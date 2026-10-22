import { parse } from "@babel/parser";
import fs from "node:fs";
import path from "node:path";

/** One prop as a call site passes it: `title="Kitchen sink"`, `count={count}`, `{...rest}`. */
export interface PassedProp {
  /** The prop's name; "..." for a spread, "children" for what's written between the tags. */
  name: string;
  /** As written: `"Kitchen sink"`, `count`, `() => save(id)`, `true` for a bare attribute. */
  value: string;
  /** When the value is a name (`{query}`, `{user.name}`): the line in the same file where that name is declared. */
  line?: number;
}

/** Where a component is rendered, with what it's given there. */
export interface UsedIn {
  /** `path:line`. */
  ref: string;
  /** The component that renders it there, e.g. "App". */
  parent?: string;
  props?: PassedProp[];
}

const asts = new Map<string, { mtimeMs: number; ast: any; source: string } | null>();

function parsed(root: string, rel: string): { ast: any; source: string } | null {
  const abs = path.join(root, rel);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(abs).mtimeMs;
  } catch {
    return null;
  }
  const hit = asts.get(abs);
  if (hit !== undefined && hit?.mtimeMs === mtimeMs) return hit;
  let entry: { mtimeMs: number; ast: any; source: string } | null = null;
  try {
    const source = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    entry = { mtimeMs, source, ast: parse(source, { sourceType: "module", errorRecovery: true, plugins: ["typescript", "jsx", "decorators-legacy"] }) };
  } catch {}
  asts.set(abs, entry);
  return entry;
}

/**
 * Adds to each place `component` is rendered (`path:line`, as found by findUsages or written by the
 * model) the component that renders it and the props it passes, read from the source. Plain source
 * reading: no AI. A ref whose line has no `<Component` is left as it is.
 */
export function describeCallSites(root: string, component: string, usedIn: UsedIn[]): UsedIn[] {
  return usedIn.map((u) => {
    const m = u.ref.match(/^(.+?):(\d+)(?::\d+)?$/);
    const file = m && parsed(root, m[1]);
    if (!m || !file) return u;
    const found = findElement(file.ast, component, Number(m[2]));
    if (!found) return u;
    const src = (n: any) => file.source.slice(n.start, n.end);
    const declaredAt = (name: string) => declarationLine(name, found.scopes);
    const props: PassedProp[] = [];
    for (const attr of found.element.openingElement.attributes) {
      if (attr.type === "JSXSpreadAttribute") {
        props.push(withLine({ name: "...", value: src(attr.argument) }, attr.argument, declaredAt));
        continue;
      }
      const name = attr.name.type === "JSXNamespacedName" ? `${attr.name.namespace.name}:${attr.name.name.name}` : attr.name.name;
      const v = attr.value;
      if (!v) props.push({ name, value: "true" });
      else if (v.type === "StringLiteral") props.push({ name, value: JSON.stringify(v.value) });
      else if (v.type === "JSXExpressionContainer" && v.expression.type !== "JSXEmptyExpression") props.push(withLine({ name, value: src(v.expression) }, v.expression, declaredAt));
      else props.push({ name, value: src(v) });
    }
    const children = found.element.children.filter((c: any) => !(c.type === "JSXText" && !c.value.trim()) && c.type !== "JSXEmptyExpression");
    if (children.length) props.push({ name: "children", value: children.map((c: any) => (c.type === "JSXText" ? c.value.trim() : src(c))).join(" ") });
    return { ...u, parent: found.parent, props };
  });
}

/** For a value that is a name or a path on one (`query`, `user.name`): where that name is declared. */
function withLine(prop: PassedProp, expr: any, declaredAt: (name: string) => number | undefined): PassedProp {
  let base = expr;
  while (base?.type === "MemberExpression" || base?.type === "OptionalMemberExpression") base = base.object;
  const line = base?.type === "Identifier" ? declaredAt(base.name) : undefined;
  return line ? { ...prop, line } : prop;
}

/** The `<Component …>` element starting on `line`, the function it sits in, and the scopes around it (innermost first). */
function findElement(ast: any, component: string, line: number): { element: any; parent?: string; scopes: any[] } | null {
  let result: { element: any; parent?: string; scopes: any[] } | null = null;
  const visit = (node: any, scopes: any[], parent?: string) => {
    if (result || !node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, scopes, parent));
    if (node.type === "JSXElement" && node.loc?.start.line === line && jsxName(node.openingElement.name) === component) {
      result = { element: node, parent, scopes };
      return;
    }
    let inner = scopes;
    let name = parent;
    if (/Function/.test(node.type) || node.type === "Program") {
      inner = [node, ...scopes];
      name = functionName(node) ?? parent;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key.endsWith("Comments")) continue;
      const child = node[key];
      // A function's name comes from the variable it's assigned to: `const App = () => …`.
      if (node.type === "VariableDeclarator" && key === "init" && /Function/.test(child?.type ?? "") && node.id.type === "Identifier") {
        child.__name = node.id.name;
      }
      visit(child, inner, name);
    }
  };
  visit(ast.program, []);
  return result;
}

function jsxName(n: any): string {
  return n.type === "JSXIdentifier" ? n.name : n.type === "JSXMemberExpression" ? `${jsxName(n.object)}.${n.property.name}` : "";
}

function functionName(fn: any): string | undefined {
  return fn.id?.name ?? fn.__name;
}

/** The line where `name` is declared in the nearest of `scopes` that declares it: a parameter (or a destructured prop), a variable, a function. */
function declarationLine(name: string, scopes: any[]): number | undefined {
  for (const scope of scopes) {
    const params = scope.type === "Program" ? [] : scope.params;
    for (const p of params) {
      const line = bindingLine(p, name);
      if (line) return line;
    }
    const body = scope.type === "Program" ? scope.body : scope.body?.type === "BlockStatement" ? scope.body.body : [];
    for (let stmt of body) {
      if ((stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration") && stmt.declaration) stmt = stmt.declaration;
      if (stmt.type === "FunctionDeclaration" && stmt.id?.name === name) return stmt.loc.start.line;
      if (stmt.type === "ImportDeclaration" && stmt.specifiers.some((s: any) => s.local.name === name)) return stmt.loc.start.line;
      if (stmt.type !== "VariableDeclaration") continue;
      for (const d of stmt.declarations) {
        const line = bindingLine(d.id, name);
        if (line) return line;
      }
    }
  }
  return undefined;
}

/** The line of `name` inside a binding pattern: `x`, `{ a, b: x }`, `[x, setX]`, `x = 1`, `...x`. */
function bindingLine(p: any, name: string): number | undefined {
  if (!p) return undefined;
  if (p.type === "Identifier") return p.name === name ? p.loc.start.line : undefined;
  if (p.type === "AssignmentPattern") return bindingLine(p.left, name);
  if (p.type === "RestElement") return bindingLine(p.argument, name);
  if (p.type === "TSParameterProperty") return bindingLine(p.parameter, name);
  const parts = p.type === "ArrayPattern" ? p.elements : p.type === "ObjectPattern" ? p.properties.map((prop: any) => (prop.type === "RestElement" ? prop : prop.value)) : [];
  for (const part of parts) {
    const line = bindingLine(part, name);
    if (line) return line;
  }
  return undefined;
}
