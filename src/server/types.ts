import { parse } from "@babel/parser";
import fs from "node:fs";
import path from "node:path";
import { localImports } from "./store.ts";

export interface TypeDef {
  name: string;
  /** "interface" | "type" | "enum" */
  kind: string;
  /** Source text of the declaration, trimmed to a readable length. */
  code: string;
  file: string;
  line: number;
}

const MAX_LINES = 30;
const MAX_FILES = 25;

/**
 * Finds the declarations of custom types mentioned in an explanation by parsing the
 * component's file and the files it imports (two levels deep). Read straight from
 * source on every request, so a definition is never stale and needs no AI.
 * Types referenced inside found definitions are resolved too, so nested types link.
 */
export function resolveTypes(root: string, file: string | undefined, text: string): TypeDef[] {
  if (!file) return [];
  const files = candidateFiles(root, file);
  const declared = new Map<string, TypeDef>();
  for (const f of files) for (const def of declarationsIn(root, f)) if (!declared.has(def.name)) declared.set(def.name, def);

  const found = new Map<string, TypeDef>();
  let pending = mentionedNames(text);
  // Follow references inside definitions a few levels (Props → User → Role).
  for (let depth = 0; depth < 3 && pending.size; depth++) {
    const next = new Set<string>();
    for (const name of pending) {
      const def = declared.get(name);
      if (!def || found.has(name)) continue;
      found.set(name, def);
      for (const n of mentionedNames(def.code)) if (!found.has(n)) next.add(n);
    }
    pending = next;
  }
  return [...found.values()];
}

function mentionedNames(text: string): Set<string> {
  return new Set(text.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? []);
}

function candidateFiles(root: string, file: string): string[] {
  const out = [file];
  for (let i = 0; i < out.length && out.length < MAX_FILES && i < 12; i++) {
    for (const imp of localImports(root, out[i])) if (!out.includes(imp)) out.push(imp);
  }
  return out.slice(0, MAX_FILES).filter((f) => /\.[cm]?tsx?$/.test(f));
}

const cache = new Map<string, { mtimeMs: number; defs: TypeDef[] }>();

function declarationsIn(root: string, rel: string): TypeDef[] {
  const abs = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return [];
  }
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.defs;

  const source = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
  let ast;
  try {
    ast = parse(source, { sourceType: "module", errorRecovery: true, plugins: ["typescript", "jsx", "decorators-legacy"] });
  } catch {
    return [];
  }
  const defs: TypeDef[] = [];
  for (let node of ast.program.body as any[]) {
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") && node.declaration) node = node.declaration;
    const kind =
      node.type === "TSInterfaceDeclaration" ? "interface" : node.type === "TSTypeAliasDeclaration" ? "type" : node.type === "TSEnumDeclaration" ? "enum" : null;
    if (!kind || !node.id?.name) continue;
    let code = source.slice(node.start, node.end);
    const lines = code.split("\n");
    if (lines.length > MAX_LINES) code = [...lines.slice(0, MAX_LINES), "  // …"].join("\n");
    defs.push({ name: node.id.name, kind, code, file: rel, line: node.loc.start.line });
  }
  cache.set(abs, { mtimeMs: stat.mtimeMs, defs });
  return defs;
}
