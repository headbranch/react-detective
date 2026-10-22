import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import MagicString from "magic-string";

/**
 * Source edits made by `react-detective init`. Each takes a file's text and returns the new
 * text, or says it's already set up, or says why it can't be edited safely (the wizard then
 * prints the snippet to paste instead of guessing).
 */
export type EditResult = { status: "changed"; code: string } | { status: "already" } | { status: "manual"; reason: string };

export interface DetectiveOptions {
  model?: string;
}

const changed = (code: string): EditResult => ({ status: "changed", code });
const manual = (reason: string): EditResult => ({ status: "manual", reason });

function parseModule(code: string, filename: string): t.File | null {
  const isTs = /\.[cm]?tsx?$/.test(filename);
  // .ts files can't contain JSX (`<T>x` is a type assertion there).
  const plugins: any[] = isTs ? (filename.endsWith("x") ? ["typescript", "jsx"] : ["typescript"]) : ["jsx"];
  try {
    return parse(code, { sourceType: "unambiguous", plugins }) as t.File;
  } catch {
    return null;
  }
}

/** `{ model: "opus" }`, or "" when everything is default. */
export function optionsLiteral(opts: DetectiveOptions = {}): string {
  return opts.model && opts.model !== "sonnet" ? `{ model: ${JSON.stringify(opts.model)} }` : "";
}

/** Inserts a statement after the last top-level import/require, or at the top of the file. */
function insertImport(s: MagicString, ast: t.File, line: string) {
  let last: t.Statement | undefined;
  for (const stmt of ast.program.body) {
    if (stmt.type === "ImportDeclaration" || isRequireDeclaration(stmt)) last = stmt;
  }
  if (last) s.appendLeft(last.end!, `\n${line}`);
  else {
    const directive = ast.program.directives.at(-1);
    if (directive) s.appendLeft(directive.end!, `\n${line}`);
    else s.prepend(`${line}\n`);
  }
}

function isRequireDeclaration(stmt: t.Statement): boolean {
  if (stmt.type !== "VariableDeclaration") return false;
  return stmt.declarations.some((d) => d.init?.type === "CallExpression" && d.init.callee.type === "Identifier" && d.init.callee.name === "require");
}

/** Top-level `const name = <init>`. */
function findVariable(ast: t.File, name: string): t.Expression | null {
  for (const stmt of ast.program.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (d.id.type === "Identifier" && d.id.name === name && d.init) return d.init;
    }
  }
  return null;
}

function findFunction(ast: t.File, name: string): t.FunctionDeclaration | null {
  for (const stmt of ast.program.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type === "FunctionDeclaration" && decl.id?.name === name) return decl;
  }
  return null;
}

/** What a function returns: its expression body, or its last top-level `return`. */
function returnedExpression(fn: t.Node): t.Expression | null {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression" && fn.type !== "FunctionDeclaration") return null;
  if (fn.body.type !== "BlockStatement") return fn.body;
  const ret = [...fn.body.body].reverse().find((s): s is t.ReturnStatement => s.type === "ReturnStatement");
  return ret?.argument ?? null;
}

function unwrapTs(node: t.Node): t.Node {
  while (node.type === "TSSatisfiesExpression" || node.type === "TSAsExpression" || node.type === "TSNonNullExpression") node = node.expression;
  return node;
}

function defaultExport(ast: t.File): t.Node | null {
  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportDefaultDeclaration") return stmt.declaration;
  }
  return null;
}

function moduleExports(ast: t.File): t.AssignmentExpression | null {
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ExpressionStatement" || stmt.expression.type !== "AssignmentExpression") continue;
    const left = stmt.expression.left;
    if (
      left.type === "MemberExpression" &&
      left.object.type === "Identifier" &&
      left.object.name === "module" &&
      left.property.type === "Identifier" &&
      left.property.name === "exports"
    )
      return stmt.expression;
  }
  return null;
}

/** Text from the start of `pos`'s line up to `pos`, when it's only whitespace. */
function indentBefore(code: string, pos: number): string | null {
  const lineStart = code.lastIndexOf("\n", pos - 1) + 1;
  const prefix = code.slice(lineStart, pos);
  return /^[ \t]*$/.test(prefix) ? prefix : null;
}

/** Puts `child` just before a closing tag, on its own line when the closing tag is on its own line. */
function insertBeforeClosing(s: MagicString, code: string, closingStart: number, child: string) {
  const indent = indentBefore(code, closingStart);
  if (indent === null) s.appendLeft(closingStart, child);
  else s.appendLeft(closingStart, `${indent.includes("\t") ? "\t" : "  "}${child}\n${indent}`);
}

// ---------------------------------------------------------------------------
// Vite

/** The object literal a Vite config exports, through `defineConfig(...)`, functions and variables. */
function resolveConfigObject(ast: t.File, node: t.Node | null | undefined, depth = 0): t.ObjectExpression | null {
  if (!node || depth > 8) return null;
  node = unwrapTs(node);
  switch (node.type) {
    case "ObjectExpression":
      return node;
    case "CallExpression":
      for (const arg of node.arguments) {
        const found = resolveConfigObject(ast, arg, depth + 1);
        if (found) return found;
      }
      return null;
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "FunctionDeclaration":
      return resolveConfigObject(ast, returnedExpression(node), depth + 1);
    case "Identifier":
      return resolveConfigObject(ast, findVariable(ast, node.name) ?? findFunction(ast, node.name), depth + 1);
    default:
      return null;
  }
}

function propertyNamed(obj: t.ObjectExpression, name: string): t.ObjectProperty | null {
  for (const p of obj.properties) {
    if (p.type !== "ObjectProperty") continue;
    const key = p.key;
    if ((key.type === "Identifier" && key.name === name) || (key.type === "StringLiteral" && key.value === name)) return p;
  }
  return null;
}

/** Adds `import detective from "react-detective/vite"` and puts `detective()` first in `plugins`. */
export function addVitePlugin(code: string, filename: string, opts: DetectiveOptions = {}): EditResult {
  if (code.includes("react-detective/vite")) return { status: "already" };
  const ast = parseModule(code, filename);
  if (!ast) return manual(`couldn't parse ${filename}`);

  const exported = defaultExport(ast) ?? moduleExports(ast)?.right;
  const config = resolveConfigObject(ast, exported);
  if (!config) return manual(`couldn't find the config object exported by ${filename}`);

  const name = /\bdetective\b/.test(code) ? "reactDetective" : "detective";
  const call = `${name}(${optionsLiteral(opts)})`;
  const s = new MagicString(code);

  const plugins = propertyNamed(config, "plugins");
  if (plugins) {
    const arr = unwrapTs(plugins.value);
    if (arr.type !== "ArrayExpression") return manual(`\`plugins\` in ${filename} isn't an array literal`);
    const first = arr.elements.find((e) => e);
    if (!first) s.appendLeft(arr.start! + 1, call);
    else {
      const indent = indentBefore(code, first.start!);
      s.appendLeft(first.start!, indent === null ? `${call}, ` : `${call},\n${indent}`);
    }
  } else {
    const first = config.properties[0];
    if (!first) s.appendLeft(config.start! + 1, ` plugins: [${call}] `);
    else {
      const indent = indentBefore(code, first.start!);
      s.appendLeft(first.start!, indent === null ? `plugins: [${call}], ` : `plugins: [${call}],\n${indent}`);
    }
  }

  insertImport(s, ast, isCommonJs(ast) ? `const ${name} = require("react-detective/vite").default;` : `import ${name} from "react-detective/vite";`);
  return changed(s.toString());
}

function isCommonJs(ast: t.File): boolean {
  return !ast.program.body.some((s) => s.type === "ImportDeclaration" || s.type === "ExportDefaultDeclaration" || s.type === "ExportNamedDeclaration") && !!moduleExports(ast);
}

// ---------------------------------------------------------------------------
// Next.js

/** Wraps the exported Next.js config in `withDetective(...)`. */
export function wrapNextConfig(code: string, filename: string, opts: DetectiveOptions = {}): EditResult {
  if (code.includes("react-detective/next")) return { status: "already" };
  const ast = parseModule(code, filename);
  if (!ast) return manual(`couldn't parse ${filename}`);

  const extra = optionsLiteral(opts);
  const close = extra ? `, ${extra})` : ")";
  const s = new MagicString(code);

  const exported = defaultExport(ast);
  if (exported) {
    if (exported.type === "ClassDeclaration" || exported.type === "TSInterfaceDeclaration" || exported.type === "TSDeclareFunction") {
      return manual(`${filename} doesn't export a config`);
    }
    s.appendLeft(exported.start!, "withDetective(");
    s.appendRight(exported.end!, close);
    insertImport(s, ast, `import { withDetective } from "react-detective/next";`);
    return changed(s.toString());
  }

  const assignment = moduleExports(ast);
  if (assignment) {
    s.appendLeft(assignment.right.start!, "withDetective(");
    s.appendRight(assignment.right.end!, close);
    insertImport(s, ast, `const { withDetective } = require("react-detective/next");`);
    return changed(s.toString());
  }

  return manual(`couldn't find \`export default\` or \`module.exports\` in ${filename}`);
}

const DETECTIVE_IMPORT = `import { Detective } from "react-detective/react";`;

function findJsxElement(node: t.Node, tag: string): t.JSXElement | null {
  if (node.type === "JSXElement") {
    const name = node.openingElement.name;
    if (name.type === "JSXIdentifier" && name.name === tag) return node;
  }
  for (const key of Object.keys(node) as (keyof typeof node)[]) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    const value = node[key] as unknown;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (child && typeof child === "object" && typeof (child as t.Node).type === "string") {
        const found = findJsxElement(child as t.Node, tag);
        if (found) return found;
      }
    }
  }
  return null;
}

/** App Router: adds `<Detective />` as the last child of `<body>` in the root layout. */
export function addToLayout(code: string, filename: string): EditResult {
  if (code.includes("react-detective/react")) return { status: "already" };
  const ast = parseModule(code, filename);
  if (!ast) return manual(`couldn't parse ${filename}`);

  const body = findJsxElement(ast.program, "body");
  if (!body?.closingElement) return manual(`couldn't find <body>…</body> in ${filename}`);

  const s = new MagicString(code);
  insertBeforeClosing(s, code, body.closingElement.start!, "<Detective />");
  insertImport(s, ast, DETECTIVE_IMPORT);
  return changed(s.toString());
}

/** Pages Router: adds `<Detective />` next to what the custom `_app` renders. */
export function addToApp(code: string, filename: string): EditResult {
  if (code.includes("react-detective/react")) return { status: "already" };
  const ast = parseModule(code, filename);
  if (!ast) return manual(`couldn't parse ${filename}`);

  let exported = defaultExport(ast);
  if (exported) exported = unwrapTs(exported);
  if (exported?.type === "Identifier") exported = findVariable(ast, exported.name) ?? findFunction(ast, exported.name);
  const rendered = exported && returnedExpression(exported);
  if (!rendered) return manual(`couldn't find what the default export of ${filename} renders`);

  const s = new MagicString(code);
  if (rendered.type === "JSXFragment") insertBeforeClosing(s, code, rendered.closingFragment.start!, "<Detective />");
  else if (rendered.type === "JSXElement") {
    s.appendLeft(rendered.start!, "<>");
    s.appendRight(rendered.end!, "<Detective /></>");
  } else return manual(`the default export of ${filename} doesn't return JSX directly`);

  insertImport(s, ast, DETECTIVE_IMPORT);
  return changed(s.toString());
}

/** A new `pages/_app` for Pages Router projects that don't have one. */
export function newAppFile(typescript: boolean): string {
  return typescript
    ? `import type { AppProps } from "next/app";
${DETECTIVE_IMPORT}

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <Detective />
    </>
  );
}
`
    : `${DETECTIVE_IMPORT}

export default function App({ Component, pageProps }) {
  return (
    <>
      <Component {...pageProps} />
      <Detective />
    </>
  );
}
`;
}

// ---------------------------------------------------------------------------
// Env and .gitignore

/** Sets `KEY=value` in a .env file's text, replacing an existing line for that key. */
export function setEnvVar(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  if (!text) return `${line}\n`;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

/**
 * Whether a root-level file is ignored by a .gitignore's text. Handles the patterns that
 * matter for env files (`*`, `?`, leading `/`, `!` negation, last match wins); the wizard
 * asks git itself first when it can.
 */
export function isGitIgnored(gitignore: string, file: string): boolean {
  let ignored = false;
  for (const raw of gitignore.split(/\r?\n/)) {
    let pattern = raw.trim();
    if (!pattern || pattern.startsWith("#")) continue;
    const negate = pattern.startsWith("!");
    if (negate) pattern = pattern.slice(1);
    if (pattern.endsWith("/")) continue; // directories only
    pattern = pattern.replace(/^\//, "").replace(/^\*\*\//, "");
    if (pattern.includes("/")) continue;
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
    if (re.test(file)) ignored = !negate;
  }
  return ignored;
}

/** Appends a line to a .gitignore's text. */
export function addGitIgnore(text: string, entry: string): string {
  if (!text) return `${entry}\n`;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${entry}\n`;
}
