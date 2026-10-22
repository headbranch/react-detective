import { parse } from "@babel/parser";
import fs from "node:fs";
import path from "node:path";
import { resolveModule } from "./store.ts";

/**
 * React keeps a component's hook values in call order, with no names. To label the
 * live values we read the source: every useState/useReducer (and useContext) the
 * component runs, in order, including the ones inside custom hooks it calls, plus
 * what each custom hook returns. The client lines this up with the live values.
 */

export interface Slot {
  /** The custom hook (called directly by the component) this value lives in; absent for the component's own. */
  owner?: string;
  /**
   * How the hook exposes it: a returned object's property name, the name the component
   * destructures an array element into, or "" when the hook returns this value itself.
   * Absent when the hook keeps the value internal.
   */
  key?: string;
  /** Variable name where it's declared (the state name, or the context's name). */
  name: string;
}

/** One entry in React's per-component hook list, labelled from source. */
export interface HookSlot extends Slot {
  /** The built-in hook that created this entry, e.g. "useState", "useRef", "useEffect". */
  hook: string;
  /** For effects / memos / callbacks: the dependency expressions as written, e.g. ["query"]. */
  deps?: string[];
}

export interface HookSlots {
  /**
   * Every entry React keeps in the component's hook list, in order (state, refs, memos,
   * callbacks, effects, …, including those inside custom hooks). Cut short at the first
   * hook whose source we can't see (e.g. one from a library), after which order is unknown.
   */
  hooks: HookSlot[];
  /** False when `hooks` was cut short. */
  complete: boolean;
  /** One per useState/useReducer-style hook, in the order React stores them. */
  states: Slot[];
  /** One per context read, in the order React records them. */
  contexts: Slot[];
  /** Module-level constants in the component's file: name → value as written. */
  constants: Record<string, string>;
}

/** A hook-list entry: whether it's a state (has an update queue), and which element of `const [a, b, c] = …` names it (null: kept internally). */
type Entry = { state: boolean; element: number | null };
const VALUE: Entry[] = [{ state: false, element: 0 }];
const STATE: Entry[] = [{ state: true, element: 0 }];
const INTERNAL: Entry = { state: false, element: null };
/** Built-in hooks and the entries each adds to React's hook list, in order. */
const BUILTIN_ENTRIES: Record<string, Entry[]> = {
  useState: STATE,
  useReducer: STATE,
  useOptimistic: STATE,
  // isPending, then the start function.
  useTransition: [...STATE, INTERNAL],
  // The state, isPending (the third element), then the action queue.
  useActionState: [...STATE, { state: true, element: 2 }, INTERNAL],
  // The snapshot, then the effect that subscribes to the store.
  useSyncExternalStore: [...VALUE, INTERNAL],
  useRef: VALUE,
  useMemo: VALUE,
  useCallback: VALUE,
  useEffect: VALUE,
  useLayoutEffect: VALUE,
  useInsertionEffect: VALUE,
  useImperativeHandle: VALUE,
  useId: VALUE,
  useDeferredValue: VALUE,
};
export const STATE_HOOKS = new Set(Object.keys(BUILTIN_ENTRIES).filter((h) => BUILTIN_ENTRIES[h].some((e) => e.state)));
/** Built-ins that read React data without adding a hook entry. */
const NO_ENTRY = new Set(["useContext", "useDebugValue", "use"]);
/** Where each hook keeps its dependency array, by argument index. */
const DEPS_ARG: Record<string, number> = { useEffect: 1, useLayoutEffect: 1, useInsertionEffect: 1, useMemo: 1, useCallback: 1, useImperativeHandle: 2 };
/** Stand-in variable for a hook call whose result is returned directly: `return useContext(X)`. */
// "@" can't appear in a JS identifier, so this never collides with a real variable.
const RETURNED = { type: "Identifier", name: "@returned" };
const MAX_DEPTH = 4;

/** Labels for the live values of `component` in `file`, or null if its source can't be analysed. */
export function hookSlots(root: string, file: string | undefined, component: string): HookSlots | null {
  if (!file) return null;
  const found = findFunction(root, file, component, 0);
  if (!found) return null;
  const raws = collect(root, found.file, found.fn, 0);
  const unknownAt = raws.findIndex((r) => r.kind === "unknown");
  const hookRaws = (unknownAt < 0 ? raws : raws.slice(0, unknownAt)).filter((r) => r.kind === "hook");
  return {
    hooks: hookRaws.map((r) => ({ ...toSlot(r), hook: r.hook!, ...(r.deps ? { deps: r.deps } : {}) })),
    complete: unknownAt < 0,
    states: raws.filter((r) => r.kind === "hook" && r.state).map(toSlot),
    contexts: raws.filter((r) => r.kind === "context").map(toSlot),
    constants: constantsIn(root, file),
  };
}

interface Raw {
  kind: "hook" | "context" | "unknown";
  /** For kind "hook": the built-in that created the entry. */
  hook?: string;
  /** A state entry (has an update queue): one of `states`. */
  state?: boolean;
  /** Variable holding the value in the current function's scope, if any. */
  local: string | null;
  /** Name at the declaration (innermost). */
  name: string;
  owner?: string;
  key?: string;
  deps?: string[];
}

function toSlot(r: Raw): Slot {
  return r.owner ? { owner: r.owner, key: r.key, name: r.name } : { name: r.local ?? r.name };
}

/** Hook calls in a function body, in source order, expanding custom hooks into their own slots. */
function collect(root: string, file: string, fn: any, depth: number): Raw[] {
  const out: Raw[] = [];
  const source = parseFile(root, file)?.source ?? "";
  const body = fn.body?.type === "BlockStatement" ? fn.body : { type: "VariableDeclarator", id: RETURNED, init: fn.body };
  walk(body, (call, declarator) => {
    const callee = calleeName(call);
    // `use(SomeContext)` reads a context like useContext; `use(promise)` leaves no trace React lists.
    const readsContext = callee === "useContext" || (callee === "use" && /Context$/.test(call.arguments[0]?.name ?? ""));
    if (!callee || (NO_ENTRY.has(callee) && !readsContext)) return;
    if (callee in BUILTIN_ENTRIES) {
      const first = boundName(declarator?.id, 0);
      const name = first && first !== RETURNED.name ? first : callee;
      const depsNode = DEPS_ARG[callee] !== undefined ? call.arguments[DEPS_ARG[callee]] : undefined;
      const deps = depsNode?.type === "ArrayExpression" ? depsNode.elements.map((e: any) => (e ? source.slice(e.start, e.end) : "")) : undefined;
      BUILTIN_ENTRIES[callee].forEach((entry, n) => {
        const local = entry.element === null ? null : boundName(declarator?.id, entry.element);
        const label = n === 0 ? name : entry.element === null || !local ? `${name} (internal)` : local;
        out.push({ kind: "hook", hook: callee, state: entry.state, local, name: label, ...(n === 0 && deps ? { deps } : {}) });
      });
    } else if (readsContext) {
      const ctx = call.arguments[0]?.type === "Identifier" ? call.arguments[0].name : "context";
      out.push({ kind: "context", local: declarator?.id?.type === "Identifier" ? declarator.id.name : null, name: ctx });
    } else if (/^use[A-Z]/.test(callee)) {
      const target = depth < MAX_DEPTH ? findFunction(root, file, callee, depth + 1) : null;
      // A hook we can't read (e.g. from a library) adds an unknown number of entries.
      if (!target) return void out.push({ kind: "unknown", local: null, name: callee });
      const inner = collect(root, target.file, target.fn, depth + 1);
      const shape = returnShape(target.fn);
      for (const s of inner) {
        const key = shape && s.local ? exposedAs(shape, s.local, declarator?.id) : undefined;
        out.push({
          ...s,
          owner: callee,
          key,
          local: key !== undefined ? callerLocal(declarator?.id, shape!, key) : null,
        });
      }
    }
  });
  return out;
}

/** Top-level `const X = <value>` in a file (not functions or components): name → value as written. */
function constantsIn(root: string, file: string): Record<string, string> {
  const parsed = parseFile(root, file);
  return parsed ? Object.fromEntries(parsed.constants) : {};
}

type Shape = { type: "object"; map: Map<string, string> } | { type: "array"; map: Map<string, number> } | { type: "single"; name: string };

/** What a hook returns, in terms of its local variable names. */
function returnShape(fn: any): Shape | null {
  let expr = fn.body?.type !== "BlockStatement" ? fn.body : null;
  if (!expr) {
    const ret = [...(fn.body?.body ?? [])].reverse().find((s: any) => s.type === "ReturnStatement");
    expr = ret?.argument;
  }
  while (expr?.type === "TSAsExpression" || expr?.type === "TSSatisfiesExpression") expr = expr.expression;
  if (!expr) return null;
  if (expr.type === "Identifier") return { type: "single", name: expr.name };
  if (expr.type === "CallExpression") return { type: "single", name: RETURNED.name };
  if (expr.type === "ObjectExpression") {
    const map = new Map<string, string>();
    for (const p of expr.properties) {
      if (p.type !== "ObjectProperty" || p.value?.type !== "Identifier") continue;
      const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : null;
      if (key) map.set(p.value.name, key);
    }
    return { type: "object", map };
  }
  if (expr.type === "ArrayExpression") {
    const map = new Map<string, number>();
    expr.elements.forEach((e: any, i: number) => e?.type === "Identifier" && map.set(e.name, i));
    return { type: "array", map };
  }
  return null;
}

/** The label a returned value gets: property name, the caller's destructured name, or "" for a single value. */
function exposedAs(shape: Shape, local: string, callSitePattern: any): string | undefined {
  if (shape.type === "single") return shape.name === local ? "" : undefined;
  if (shape.type === "object") return shape.map.get(local);
  const index = shape.map.get(local);
  if (index === undefined) return undefined;
  return boundName(callSitePattern, index) ?? `[${index}]`;
}

/** Name the caller binds a returned value to, so outer hooks can map it further. */
function callerLocal(pattern: any, shape: Shape, key: string): string | null {
  if (!pattern) return null;
  if (shape.type === "single") return pattern.type === "Identifier" ? pattern.name : null;
  if (shape.type === "array") return key.startsWith("[") ? null : key;
  if (pattern.type === "ObjectPattern") {
    for (const p of pattern.properties) {
      const k = p.key?.type === "Identifier" ? p.key.name : p.key?.value;
      if (k !== key) continue;
      const v = p.value?.type === "AssignmentPattern" ? p.value.left : p.value;
      return v?.type === "Identifier" ? v.name : null;
    }
  }
  return null;
}

/** `const [x] = …` → x (element `index`), `const x = …` → x. */
function boundName(pattern: any, index: number): string | null {
  if (!pattern) return null;
  if (pattern.type === "Identifier") return index === 0 ? pattern.name : null;
  if (pattern.type === "ArrayPattern") {
    const el = pattern.elements[index];
    const id = el?.type === "AssignmentPattern" ? el.left : el;
    return id?.type === "Identifier" ? id.name : null;
  }
  return null;
}

export function calleeName(call: any): string | null {
  const c = call.callee;
  if (c.type === "Identifier") return c.name;
  if (c.type === "MemberExpression" && c.property.type === "Identifier" && c.object.type === "Identifier" && c.object.name === "React") return c.property.name;
  return null;
}

/** Visits call expressions in source order, skipping nested functions (hooks can't run there). */
function walk(node: any, visit: (call: any, declarator: any) => void, declarator: any = null, top = true) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit, declarator, top));
  if (!top && /Function/.test(node.type)) return;
  if (node.type === "ReturnStatement" && node.argument?.type === "CallExpression") {
    walk(node.argument, visit, { id: RETURNED }, false);
    return;
  }
  if (node.type === "VariableDeclarator") {
    walk(node.init, visit, node, false);
    return;
  }
  if (node.type === "CallExpression") {
    // Arguments first: in `useA(useB())`, useB runs first.
    walk(node.arguments, visit, null, false);
    visit(node, declarator);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments") continue;
    walk(node[key], visit, null, false);
  }
}

// ---------- finding function definitions ----------

export interface Parsed {
  source: string;
  /** Top-level non-function `const`s: name → value as written (trimmed). */
  constants: Map<string, string>;
  /** Top-level non-function `const`s: name → the node (for line numbers and types). */
  constantNodes: Map<string, any>;
  /** Top-level `createContext(…)` calls: context name → the call. */
  contexts: Map<string, any>;
  /** Top-level `interface` / `type` declarations: name → node. */
  typeDecls: Map<string, any>;
  functions: Map<string, any>;
  defaultExport: any;
  /** Names brought in from other modules, by local name: imports, and re-exports (`export { a } from "./a"`). */
  imports: Map<string, { spec: string; imported: string }>;
  /** `export * from "…"` sources, searched for names the file doesn't declare or import. */
  reexports: string[];
}

const parsedCache = new Map<string, { mtimeMs: number; parsed: Parsed | null }>();

export function parseFile(root: string, rel: string): Parsed | null {
  const abs = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  const hit = parsedCache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.parsed;
  let parsed: Parsed | null = null;
  try {
    const source = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    const ast = parse(source, { sourceType: "module", errorRecovery: true, plugins: ["typescript", "jsx", "decorators-legacy"] });
    parsed = { source, constants: new Map(), constantNodes: new Map(), contexts: new Map(), typeDecls: new Map(), functions: new Map(), defaultExport: null, imports: new Map(), reexports: [] };
    for (let node of ast.program.body as any[]) {
      if (node.type === "ImportDeclaration") {
        for (const s of node.specifiers) {
          const imported = s.type === "ImportDefaultSpecifier" ? "default" : s.type === "ImportSpecifier" ? (s.imported.name ?? s.imported.value) : null;
          if (imported) parsed.imports.set(s.local.name, { spec: node.source.value, imported });
        }
        continue;
      }
      // Re-exports, as packages' index files are written: `export { useQuery } from "./useQuery.js"`, `export * from "./react"`.
      if (node.type === "ExportNamedDeclaration" && node.source) {
        for (const s of node.specifiers) {
          const exported = s.exported?.name ?? s.exported?.value;
          if (exported && s.local) parsed.imports.set(exported, { spec: node.source.value, imported: s.local.name ?? s.local.value });
        }
        continue;
      }
      if (node.type === "ExportAllDeclaration" && !node.exported) {
        parsed.reexports.push(node.source.value);
        continue;
      }
      const isDefault = node.type === "ExportDefaultDeclaration";
      if ((node.type === "ExportNamedDeclaration" || isDefault) && node.declaration) node = node.declaration;
      if (isDefault) parsed.defaultExport = functionOf(node);
      if (node.type === "FunctionDeclaration" && node.id) parsed.functions.set(node.id.name, node);
      if ((node.type === "TSInterfaceDeclaration" || node.type === "TSTypeAliasDeclaration") && node.id) parsed.typeDecls.set(node.id.name, node);
      if (node.type === "VariableDeclaration") {
        for (const d of node.declarations) {
          const fn = functionOf(d.init);
          if (d.id.type === "Identifier" && fn) parsed.functions.set(d.id.name, fn);
          else if (d.id.type === "Identifier" && d.init?.type === "CallExpression" && /^(React\.)?createContext$/.test(source.slice(d.init.callee.start, d.init.callee.end))) {
            parsed.contexts.set(d.id.name, d.init);
          } else if (d.id.type === "Identifier" && d.init && node.kind === "const" && !/^(Call|New)Expression$/.test(d.init.type)) {
            const value = source.slice(d.init.start, d.init.end);
            parsed.constants.set(d.id.name, value.length > 300 ? value.slice(0, 299) + "…" : value);
            parsed.constantNodes.set(d.id.name, d);
          }
        }
      }
    }
  } catch {
    parsed = null;
  }
  parsedCache.set(abs, { mtimeMs: stat.mtimeMs, parsed });
  return parsed;
}

/** The function in `node`, looking through wrappers like memo(…) and forwardRef(…). */
function functionOf(node: any): any {
  while (node?.type === "CallExpression") node = node.arguments.find((a: any) => /Function/.test(a.type)) ?? node.arguments[0];
  return node && /Function/.test(node.type) ? node : null;
}

/** The `createContext(…)` call that makes context `name`, in `file` or the file it's imported from. */
export function findContext(root: string, file: string, name: string): { parsed: Parsed; call: any } | null {
  const parsed = parseFile(root, file);
  if (!parsed) return null;
  const local = parsed.contexts.get(name);
  if (local) return { parsed, call: local };
  const imp = parsed.imports.get(name);
  const target = imp && resolveModule(root, file, imp.spec);
  const targetParsed = target ? parseFile(root, target) : null;
  const call = targetParsed?.contexts.get(imp!.imported);
  return call ? { parsed: targetParsed!, call } : null;
}

export function findFunction(root: string, file: string, name: string, depth: number): { file: string; fn: any } | null {
  const parsed = parseFile(root, file);
  if (!parsed) return null;
  const local = parsed.functions.get(name);
  if (local) return { file, fn: local };
  // Default-exported anonymous components are named after their file by the transform.
  if (depth === 0 && parsed.defaultExport) return { file, fn: parsed.defaultExport };
  if (depth > MAX_DEPTH) return null;
  return importedFunction(root, file, parsed, name, 0);
}

/**
 * The function `file` imports as `name`, from the project or a package, followed through re-exports
 * (a package's index re-exporting `./useQuery.js`, `export * from` chains).
 */
function importedFunction(root: string, file: string, parsed: Parsed, name: string, hops: number): { file: string; fn: any } | null {
  if (hops > 6) return null;
  const imp = parsed.imports.get(name);
  const sources = imp ? [{ spec: imp.spec, name: imp.imported }] : parsed.reexports.map((spec) => ({ spec, name }));
  for (const { spec, name: imported } of sources) {
    const target = resolveModule(root, file, spec);
    const targetParsed = target ? parseFile(root, target) : null;
    if (!targetParsed) continue;
    const fn = imported === "default" ? targetParsed.defaultExport : targetParsed.functions.get(imported);
    if (fn) return { file: target!, fn };
    const further = imported === "default" ? null : importedFunction(root, target!, targetParsed, imported, hops + 1);
    if (further) return further;
  }
  return null;
}

