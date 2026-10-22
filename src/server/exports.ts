import { parse } from "@babel/parser";
import fs from "node:fs";
import path from "node:path";
import { resolveImport } from "./store.ts";

/** One export of a file, read straight from source (no AI). */
export interface ExportInfo {
  /** The exported name; `default` for the default export. */
  name: string;
  kind: "function" | "component" | "hook" | "class" | "const" | "variable" | "type" | "interface" | "enum";
  /** Signature or type as code, e.g. `(query: string) => User[]`; empty when unknown. */
  signature: string;
  /** File that actually declares it (differs from the file asked about for re-exports). */
  file: string;
  /** The name `file` exports it as, which differs from `name` when re-exported under another name. */
  declaredAs: string;
  /** Name of the declaration in `file`, which can differ from `name` (`export { a as b }`, defaults). */
  local: string;
  line: number;
}

/** What one file imports from one project file. */
export interface LocalImport {
  file: string;
  /** Imported export names; `default` for a default import, `*` for `import * as x`. */
  names: string[];
}

type Decl = Omit<ExportInfo, "name" | "declaredAs">;

interface FileInfo {
  /** Declared here: exported name → info. */
  own: Map<string, ExportInfo>;
  /** `export { a as b } from "./x"`: exported name → [specifier, name there]. */
  reexports: Map<string, [string, string]>;
  /** `export * from "./x"` specifiers. */
  star: string[];
  imports: Map<string, Set<string>>;
}

const MAX_SIGNATURE = 200;
const MAX_DEPTH = 4;
const cache = new Map<string, { mtimeMs: number; info: FileInfo | null }>();

/** Every export of a file, following re-exports (barrel files) to their declarations. */
export function exportsOf(root: string, rel: string, depth = 0): Map<string, ExportInfo> {
  const info = fileInfo(root, rel);
  const out = new Map<string, ExportInfo>();
  if (!info) return out;
  for (const [name, e] of info.own) out.set(name, e);
  if (depth >= MAX_DEPTH) return out;
  for (const [name, [spec, there]] of info.reexports) {
    const target = resolveImport(root, rel, spec);
    const hit = target && exportsOf(root, target, depth + 1).get(there);
    if (hit) out.set(name, { ...hit, name });
  }
  for (const spec of info.star) {
    const target = resolveImport(root, rel, spec);
    if (!target) continue;
    for (const [name, e] of exportsOf(root, target, depth + 1)) if (name !== "default" && !out.has(name)) out.set(name, e);
  }
  return out;
}

/** The project files a file imports from, and which names it imports from each. */
export function importsOf(root: string, rel: string): LocalImport[] {
  const info = fileInfo(root, rel);
  if (!info) return [];
  const out = new Map<string, Set<string>>();
  for (const [spec, names] of info.imports) {
    const file = resolveImport(root, rel, spec);
    if (!file) continue;
    const set = out.get(file) ?? new Set<string>();
    names.forEach((n) => set.add(n));
    out.set(file, set);
  }
  return [...out].map(([file, names]) => ({ file, names: [...names] }));
}

function fileInfo(root: string, rel: string): FileInfo | null {
  const abs = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.info;
  let info: FileInfo | null = null;
  try {
    info = readInfo(rel, fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n"));
  } catch {}
  cache.set(abs, { mtimeMs: stat.mtimeMs, info });
  return info;
}

function readInfo(rel: string, source: string): FileInfo {
  const ast = parse(source, { sourceType: "module", errorRecovery: true, plugins: ["typescript", "jsx", "decorators-legacy"] });
  const src = (n: any) => (n ? source.slice(n.start, n.end) : "");
  const info: FileInfo = { own: new Map(), reexports: new Map(), star: [], imports: new Map() };
  // Top-level declarations by name, so `export { a }` and `export default a` can find them.
  const declared = new Map<string, Decl>();
  const addOwn = (name: string, d: Decl) => info.own.set(name, { name, declaredAs: name, ...d });
  const pendingLocal: [exported: string, local: string][] = [];

  const declare = (node: any): [string, Decl][] => {
    const line = node.loc?.start.line ?? 0;
    const base = { file: rel, line };
    switch (node.type) {
      case "FunctionDeclaration":
        return node.id ? [[node.id.name, { ...base, local: node.id.name, kind: fnKind(node.id.name), signature: signature(node, src) }]] : [];
      case "ClassDeclaration":
        return node.id ? [[node.id.name, { ...base, local: node.id.name, kind: "class", signature: "" }]] : [];
      case "TSInterfaceDeclaration":
        return [[node.id.name, { ...base, local: node.id.name, kind: "interface", signature: clip(src(node.body)) }]];
      case "TSTypeAliasDeclaration":
        return [[node.id.name, { ...base, local: node.id.name, kind: "type", signature: clip(src(node.typeAnnotation)) }]];
      case "TSEnumDeclaration":
        return [[node.id.name, { ...base, local: node.id.name, kind: "enum", signature: "" }]];
      case "VariableDeclaration":
        return node.declarations
          .filter((d: any) => d.id.type === "Identifier")
          .map((d: any) => {
            const fn = functionOf(d.init);
            const name = d.id.name;
            const annotated = src(d.id.typeAnnotation?.typeAnnotation);
            const kind: ExportInfo["kind"] = fn ? fnKind(name) : node.kind === "const" ? "const" : "variable";
            const sig = annotated || (fn ? signature(fn, src) : kind === "const" && d.init && !/^(Call|New)Expression$/.test(d.init.type) ? src(d.init) : "");
            return [name, { file: rel, line: d.loc?.start.line ?? line, local: name, kind, signature: clip(sig) }];
          });
      default:
        return [];
    }
  };

  for (const node of ast.program.body as any[]) {
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type" && !node.specifiers.length) continue;
      const names = info.imports.get(node.source.value) ?? new Set<string>();
      for (const s of node.specifiers) {
        if (s.type === "ImportDefaultSpecifier") names.add("default");
        else if (s.type === "ImportNamespaceSpecifier") names.add("*");
        else names.add(s.imported.name ?? s.imported.value);
      }
      info.imports.set(node.source.value, names);
      continue;
    }
    if (node.type === "ExportAllDeclaration") {
      info.star.push(node.source.value);
      continue;
    }
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        for (const [name, d] of declare(node.declaration)) addOwn(name, d);
        continue;
      }
      for (const s of node.specifiers) {
        const exported = s.exported.name ?? s.exported.value;
        const local = s.local?.name ?? s.local?.value;
        if (node.source) info.reexports.set(exported, [node.source.value, s.type === "ExportNamespaceSpecifier" ? "*" : local]);
        else pendingLocal.push([exported, local]);
      }
      continue;
    }
    if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (decl.type === "Identifier") pendingLocal.push(["default", decl.name]);
      else {
        const own = declare(decl)[0];
        if (own) {
          addOwn("default", own[1]);
          declared.set(own[0], own[1]);
        } else {
          const fn = functionOf(decl);
          const line = decl.loc?.start.line ?? 0;
          addOwn("default", {
            file: rel,
            line,
            local: "default",
            kind: fn ? "function" : "const",
            signature: clip(fn ? signature(fn, src) : src(decl)),
          });
        }
      }
      continue;
    }
    for (const [name, d] of declare(node)) declared.set(name, d);
  }
  for (const [exported, local] of pendingLocal) {
    const d = declared.get(local);
    if (d) addOwn(exported, d);
  }
  return info;
}

function fnKind(name: string): ExportInfo["kind"] {
  return /^use[A-Z0-9]/.test(name) ? "hook" : /^[A-Z]/.test(name) ? "component" : "function";
}

/** The function in `node`, looking through wrappers like memo(…) and forwardRef(…). */
function functionOf(node: any): any {
  while (node?.type === "CallExpression") node = node.arguments.find((a: any) => /Function/.test(a.type)) ?? node.arguments[0];
  return node && /Function/.test(node.type) ? node : null;
}

function signature(fn: any, src: (n: any) => string): string {
  const ret = src(fn.returnType?.typeAnnotation);
  return clip(`(${fn.params.map(src).join(", ")})${ret ? ` => ${ret}` : ""}`);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SIGNATURE ? flat.slice(0, MAX_SIGNATURE - 1) + "…" : flat;
}
