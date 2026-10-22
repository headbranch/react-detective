import { parse } from "@babel/parser";
import _traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import MagicString from "magic-string";
import path from "node:path";

// @babel/traverse ships CJS; under ESM interop the function lives on `.default`.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse;

export const LOC_ATTR = "data-rd-loc";
export const COMP_ATTR = "data-rd-comp";

const FILE_RE = /\.[cm]?[jt]sx?$/;
// Elements where extra attributes are pointless or can upset document-level rendering.
const SKIP_TAGS = new Set(["html", "head", "meta", "title", "script", "style", "link", "base", "noscript"]);

export interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

/**
 * Adds `data-rd-loc="file:line:col"` and `data-rd-comp="ComponentName"` to every
 * host JSX element (`<div>`, `<button>`, ...). Composite elements (`<UserCard>`)
 * are left alone so we never inject unexpected props into user components.
 *
 * Because the attribute sits on DOM written inside the component's own file, the
 * location always points at where the component is *defined*, which also works
 * for React Server Components, which have no client-side fiber.
 */
export function transformJsx(code: string, id: string, root: string): TransformResult | null {
  const filename = id.split("?")[0];
  if (!FILE_RE.test(filename) || filename.includes("node_modules")) return null;
  if (!code.includes("<")) return null;

  const isTs = /\.[cm]?tsx?$/.test(filename);
  // .ts files can't contain JSX (`<T>x` is a type assertion there).
  if (isTs && !filename.endsWith("x")) return null;

  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: "module",
      errorRecovery: true,
      plugins: isTs ? ["jsx", "typescript", "decorators-legacy"] : ["jsx", "decorators-legacy"],
    });
  } catch {
    return null;
  }

  const rel = path.relative(root, filename).split(path.sep).join("/");
  const s = new MagicString(code);
  let changed = false;

  traverse(ast, {
    JSXOpeningElement(p) {
      const name = p.node.name;
      if (name.type !== "JSXIdentifier") return;
      const tag = name.name;
      if (!/^[a-z]/.test(tag) || SKIP_TAGS.has(tag)) return;
      const hasAttr = p.node.attributes.some(
        (a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === LOC_ATTR,
      );
      if (hasAttr || name.end == null || !p.node.loc) return;

      const comp = findComponentName(p, filename);
      const { line, column } = p.node.loc.start;
      let attrs = ` ${LOC_ATTR}="${rel}:${line}:${column + 1}"`;
      if (comp) attrs += ` ${COMP_ATTR}="${comp}"`;
      s.appendLeft(name.end, attrs);
      changed = true;
    },
  });

  if (!changed) return null;
  return { code: s.toString(), map: s.generateMap({ source: filename, hires: true, includeContent: true }) };
}

/** Walks up to the nearest PascalCase function (component) enclosing this JSX. */
function findComponentName(p: NodePath, filename: string): string | null {
  let cur: NodePath | null = p.getFunctionParent();
  while (cur) {
    const name = functionName(cur);
    if (name && /^[A-Z]/.test(name)) return name;
    if (!name && isDefaultExport(cur)) return componentNameFromFile(filename);
    cur = cur.parentPath?.getFunctionParent() ?? null;
  }
  return null;
}

function functionName(fn: NodePath): string | null {
  const node = fn.node as t.Function;
  if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id) return node.id.name;
  if (node.type === "ClassMethod" || node.type === "ClassPrivateMethod") {
    const cls = fn.parentPath?.parentPath?.node;
    if (cls && (cls.type === "ClassDeclaration" || cls.type === "ClassExpression") && cls.id) return cls.id.name;
  }
  // const Foo = () => …, const Foo = memo(() => …), const Foo = forwardRef(function (…) …)
  let parent: NodePath | null = fn.parentPath;
  while (parent && parent.node.type === "CallExpression") parent = parent.parentPath;
  if (parent?.node.type === "VariableDeclarator" && parent.node.id.type === "Identifier") return parent.node.id.name;
  return null;
}

function isDefaultExport(fn: NodePath): boolean {
  let parent: NodePath | null = fn.parentPath;
  while (parent && parent.node.type === "CallExpression") parent = parent.parentPath;
  return parent?.node.type === "ExportDefaultDeclaration";
}

function componentNameFromFile(filename: string): string {
  let base = path.basename(filename).replace(FILE_RE, "");
  // Next.js route files (page.tsx, layout.tsx) are named after their folder.
  if (["page", "layout", "index", "template", "loading", "error", "not-found"].includes(base)) {
    const dir = path.basename(path.dirname(filename));
    const label = base[0].toUpperCase() + base.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    return dir && !dir.startsWith("(") && dir !== "app" && dir !== "pages" ? `${pascal(dir)}${label}` : label;
  }
  return pascal(base);
}

function pascal(s: string): string {
  return s.replace(/[[\]]/g, "").replace(/(^|[-_.\s]+)(\w)/g, (_, __, c: string) => c.toUpperCase());
}
