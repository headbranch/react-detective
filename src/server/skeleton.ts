import fs from "node:fs";
import path from "node:path";
import { CARD_VERSION, type Card, type OutlineItem } from "./card.ts";
import { calleeName, findContext, findFunction, parseFile, type Parsed } from "./hookslots.ts";

/**
 * Built-ins besides useState / useReducer that hold a value and re-render when it changes:
 * the type and initial value their first result has, from the call's arguments.
 */
const STATE_LIKE: Record<string, (args: any[], src: (node: any) => string) => { type: string; initial: string }> = {
  useTransition: () => ({ type: "boolean", initial: "false" }),
  useOptimistic: (args, src) => ({ type: literalType(args[0]), initial: src(args[0]) }),
  useActionState: (args, src) => ({ type: literalType(args[1]), initial: src(args[1]) }),
  useFormStatus: () => ({ type: "", initial: "" }),
};
/** Built-ins whose value is their first array element (`[value, setValue]`), or the whole result. */
const VALUE_FIRST = new Set(["useState", "useReducer", "useRef", "useMemo", "useCallback", "useContext", "useDeferredValue", "useId", "useSyncExternalStore", ...Object.keys(STATE_LIKE)]);

/**
 * A card built straight from the source, with no AI: props with their types, and an outline
 * of state, refs, memos, callbacks, functions, effects, hook calls and constants with types,
 * initial values, dependencies and line numbers. Shown instantly while the agent writes the
 * explanations, so the panel is useful from the first moment and costs nothing.
 */
export function skeletonCard(root: string, file: string | undefined, component: string, usedIn: string[] = []): Card | null {
  if (!file) return null;
  const found = findFunction(root, file, component, 0);
  const parsed = found && parseFile(root, found.file);
  if (!found || !parsed) return null;
  const src = (node: any) => (node ? parsed.source.slice(node.start, node.end) : "");
  const outline: OutlineItem[] = [];
  const item = (kind: OutlineItem["kind"], name: string, node: any, extra: Partial<OutlineItem> = {}): OutlineItem => ({
    kind,
    name,
    line: node.loc?.start.line ?? 0,
    type: "",
    initial: "",
    returns: "",
    when: "",
    explanation: "",
    children: [],
    ...extra,
  });

  const inner = (fn: any, renders = true) => nested(fn, item, src, renders);
  /** The package a hook is imported from, if it isn't the project's own: "@tanstack/react-query". */
  const libraryOf = (hook: string) => {
    const spec = parsed.imports.get(hook)?.spec ?? "";
    return /^[.~]|^@\//.test(spec) || spec === "react" ? "" : spec;
  };
  /**
   * A package's hook is a black box here: its source is read only to count the entries it adds to
   * React's hook list (so the component's own values line up), never shown. Its built JavaScript has
   * no types, so nothing is read from it for the outline either.
   */
  const opaque = (hook: string) => hook === "use" || !!libraryOf(hook);
  const ownSignature = (hook: string) => (opaque(hook) ? "" : hookSignature(root, found.file, hook));
  /** A dependency list as written (`[a, b]`), or "every render" when there is none. */
  const depsText = (deps: any) => (deps?.type === "ArrayExpression" ? `[${deps.elements.map(src).join(", ")}]` : deps ? "" : "every render");
  /** `(state, action: Action) => …` → `(action: Action) => void`: what calling the dispatch function a reducer gets looks like. */
  const actionSignature = (fn: any): string => {
    const f = fn?.type === "Identifier" ? parsed.functions.get(fn.name) : fn;
    const param = /Function/.test(f?.type ?? "") ? f.params[1] : null;
    return param ? `(${src(param)}) => void` : "";
  };
  /** The function a state hook hands back with its value (`setQuery`, `dispatch`…), nested under the state. */
  const companions = (name: string | undefined, type: string, node: any): OutlineItem[] => (name ? [item("function", name, node, { type, reads: "1" })] : []);

  const body = found.fn.body?.type === "BlockStatement" ? found.fn.body.body : [];
  for (const stmt of body) {
    if (stmt.type === "FunctionDeclaration" && stmt.id) {
      outline.push(item("function", stmt.id.name, stmt, { type: signature(stmt, src), children: inner(stmt) }));
      continue;
    }
    if (stmt.type === "ExpressionStatement" && stmt.expression.type === "CallExpression") {
      const call = stmt.expression;
      const hook = calleeName(call);
      if (hook && /^use(Layout|Insertion)?Effect$/.test(hook)) {
        const deps = call.arguments[1];
        outline.push(
          item("effect", hook, stmt, {
            hook,
            when: deps?.type === "ArrayExpression" ? `[${deps.elements.map(src).join(", ")}]` : deps ? "" : "every render",
            returns: hasCleanup(call.arguments[0]) ? "" : "no cleanup",
            children: inner(call.arguments[0], false),
          }),
        );
      } else if (hook === "useImperativeHandle") {
        // Decides what a parent's ref to this component sees: the handle's type, what it exposes
        // (nested, like the names a hook gives), and when it's rebuilt (like an effect).
        const [refArg, factory, deps] = call.arguments;
        const handleType = refArg?.type === "Identifier" ? refTarget(found.fn, refArg.name, parsed) : null;
        const fromType = typeMembers(handleType, parsed);
        const exposed = returnedObject(factory);
        const members = exposed
          ? exposed.properties.flatMap((p: any) => {
              const key = p.key?.name ?? p.key?.value;
              if (key == null || p.computed) return [];
              const declared = fromType.get(key);
              const fn = p.type === "ObjectMethod" || /Function/.test(p.value?.type ?? "");
              const type = declared?.type || (p.type === "ObjectMethod" ? `(${p.params.map(src).join(", ")})` : fn ? signature(p.value, src) : literalType(p.value));
              return [item(declared?.fn || fn ? "function" : "derived", key, p, { type, reads: key })];
            })
          : [...fromType].map(([key, m]) => item(m.fn ? "function" : "derived", String(key), stmt, { type: m.type, reads: String(key) }));
        outline.push(
          item("ref", `useImperativeHandle(${src(refArg)})`, stmt, {
            hook,
            type: src(handleType),
            when: deps?.type === "ArrayExpression" ? `[${deps.elements.map(src).join(", ")}]` : deps ? "" : "every render",
            children: members,
          }),
        );
      } else if (hook && hook !== "useDebugValue" && /^use[A-Z]/.test(hook)) {
        outline.push(item("hook", `${hook}(${call.arguments.map(src).join(", ")})`, stmt, { type: ownSignature(hook), from: libraryOf(hook) }));
      }
      continue;
    }
    if (stmt.type !== "VariableDeclaration") continue;
    for (const d of stmt.declarations) {
      const init = d.init;
      const names = boundNames(d.id);
      const named = names.filter(Boolean);
      if (!init || !named.length) continue;
      const hook = init.type === "CallExpression" ? calleeName(init) : null;
      // `const [, dispatch] = useReducer(…)`: the value comes first and isn't kept, so there's nothing to list.
      if (!names[0] && hook && VALUE_FIRST.has(hook)) continue;
      const typeArg = init.typeParameters?.params?.[0] ?? init.typeArguments?.params?.[0];
      const declared = d.id.typeAnnotation?.typeAnnotation;
      if (hook === "useState" || hook === "useReducer") {
        const first = init.arguments[hook === "useState" ? 0 : 1];
        const type = src(typeArg) || literalType(first) || (first?.type === "Identifier" ? paramType(found.fn, first.name, src) : "");
        const setter = hook === "useState" ? (type ? `Dispatch<SetStateAction<${type}>>` : "") : actionSignature(init.arguments[0]);
        outline.push(item("state", names[0], d, { hook, type, initial: hook === "useState" ? src(first) : "", children: companions(names[1], setter, d) }));
      } else if (hook === "useRef") {
        const first = init.arguments[0];
        const t = src(typeArg);
        outline.push(item("ref", names[0], d, { type: t ? (first?.type === "NullLiteral" ? `${t} | null` : t) : literalType(first), initial: src(first) }));
      } else if (hook === "useMemo") {
        if (d.id.type === "Identifier") {
          outline.push(item("memo", names[0], d, { type: src(typeArg) || src(declared), when: depsText(init.arguments[1]), children: inner(init.arguments[0]) }));
        } else {
          // `const { total, max } = useMemo(…)`: the names sit under the memo, like a hook's.
          const members = typeMembers(typeArg ?? declared, parsed);
          if (!members.size) for (const [key, m] of literalMembers(init.arguments[0], src)) members.set(key, m);
          outline.push(item("memo", "useMemo()", d, { type: src(typeArg) || src(declared), when: depsText(init.arguments[1]), children: [...inner(init.arguments[0]), ...givenItems(item, d.id, d, members)] }));
        }
      } else if (hook === "useCallback") {
        outline.push(item("callback", names[0], d, { type: signature(init.arguments[0], src), when: depsText(init.arguments[1]), children: inner(init.arguments[0]) }));
      } else if (hook === "useContext" || (hook === "use" && /Context$/.test(src(init.arguments[0])))) {
        const context = src(init.arguments[0]);
        const type = src(typeArg) || src(declared) || contextType(root, found.file, context);
        if (d.id.type === "Identifier") outline.push(item("context", names[0], d, { hook, type, from: context }));
        else {
          // `const { theme, toggle } = useContext(ThemeContext)`: the names sit under the read, like a hook's.
          const given = givenItems(item, d.id, d, contextMembers(root, found.file, context));
          outline.push(item("context", `${hook}(${context})`, d, { hook, type, from: context, children: given }));
        }
      } else if (hook === "useSyncExternalStore") {
        // A value read from outside React: what getSnapshot reads, and its type if that can be told.
        const snapshot = init.arguments[1];
        const body = /Function/.test(snapshot?.type ?? "") && snapshot.body.type !== "BlockStatement" ? snapshot.body : null;
        const from = body ? src(body) : snapshot ? `${src(snapshot)}()` : "";
        const type = src(typeArg) || src(declared) || src(snapshot?.returnType?.typeAnnotation) || literalType(body);
        if (d.id.type === "Identifier") outline.push(item("store", names[0], d, { hook, type, from }));
        else outline.push(item("store", `${hook}()`, d, { hook, type, from, children: givenItems(item, d.id, d, typeMembers(typeArg ?? declared, parsed)) }));
      } else if (hook && hook in STATE_LIKE) {
        // React's other built-ins that hold a value and re-render when it changes.
        const { type, initial } = STATE_LIKE[hook](init.arguments, src);
        // The function each hands back with it: startTransition, addOptimistic, the form action.
        const companion =
          d.id.type === "ObjectPattern"
            ? []
            : companions(
                names[1],
                hook === "useTransition"
                  ? "(action: () => void | Promise<void>) => void"
                  : hook === "useOptimistic"
                    ? actionSignature(init.arguments[1])
                    : hook === "useActionState"
                      ? actionSignature(init.arguments[0])
                      : "",
                d,
              );
        for (const [i, name] of (d.id.type === "ObjectPattern" ? names : names.slice(0, 1)).entries()) {
          outline.push(item("state", name, d, { hook, type: src(typeArg) || type, initial, children: i === 0 ? companion : [] }));
        }
        // `[state, formAction, isPending]`: isPending is state too.
        if (hook === "useActionState" && names[2]) outline.push(item("state", names[2], d, { hook, type: "boolean", initial: "false" }));
      } else if (hook === "useDeferredValue" || hook === "useId") {
        outline.push(item("derived", names[0], d, { hook, type: src(typeArg) || src(declared) || (hook === "useId" ? "string" : "") }));
      } else if (hook === "use" || (hook && /^use[A-Z]/.test(hook))) {
        // `const { count, add } = useCart()`: the names it gives the component sit under the hook,
        // as functions or values according to what the hook returns for each.
        // Kept whole (`const clock = useClock()`), the one name sits under it, reading all of it.
        const given =
          d.id.type === "Identifier"
            ? [item("derived", d.id.name, d, { type: src(declared) || (opaque(hook) ? "" : hookReturnType(root, found.file, hook)), reads: "" })]
            : givenItems(item, d.id, d, opaque(hook) ? new Map() : hookGives(root, found.file, hook));
        outline.push(item("hook", `${hook}(${init.arguments.map(src).join(", ")})`, d, { type: ownSignature(hook), from: libraryOf(hook), children: given }));
      } else if (/Function/.test(init.type)) {
        outline.push(item("function", names[0], d, { type: signature(init, src), children: inner(init) }));
      } else {
        for (const name of named) outline.push(item("derived", name, d, { type: src(declared) || (named.length === 1 ? literalType(init) : "") }));
      }
    }
  }

  // Module-level constants the component actually uses.
  const used = src(found.fn);
  for (const [name, node] of found.file === file ? parsed.constantNodes : new Map<string, any>()) {
    if (!new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(used)) continue;
    outline.push(item("constant", name, node, { type: src(node.id.typeAnnotation?.typeAnnotation) || literalType(node.init) }));
  }
  outline.push(...renderTree(found.fn, item, src));
  outline.sort((a, b) => a.line - b.line);

  return { summary: "", props: propsOf(found.fn, parsed, src), outline, usedIn: usedIn.map((ref) => ({ ref })), history: [], v: CARD_VERSION };
}

// ---------- nesting ----------

type Make = (kind: OutlineItem["kind"], name: string, node: any, extra?: Partial<OutlineItem>) => OutlineItem;
type Src = (node: any) => string;

/** What sits inside a function: helpers declared in its body (recursively), and what it renders if it returns JSX. */
function nested(fn: any, make: Make, src: Src, renders = true): OutlineItem[] {
  if (!fn || !/Function/.test(fn.type)) return [];
  const out: OutlineItem[] = [];
  for (const stmt of fn.body?.type === "BlockStatement" ? fn.body.body : []) {
    if (stmt.type === "FunctionDeclaration" && stmt.id) {
      out.push(make("function", stmt.id.name, stmt, { type: signature(stmt, src), children: nested(stmt, make, src) }));
    } else if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations) {
        if (d.id.type === "Identifier" && /Function/.test(d.init?.type ?? "")) {
          out.push(make("function", d.id.name, d, { type: signature(d.init, src), children: nested(d.init, make, src) }));
        }
      }
    }
  }
  if (renders) out.push(...renderTree(fn, make, src));
  return out.sort((a, b) => a.line - b.line);
}

/**
 * What a function renders, as a tree: each component element (`<UserRow>`) nested under the one
 * it sits inside, plus plain elements that are a conditional or list branch of their own (`<p>`
 * shown "if error") or hidden while mounted, and the plain elements those sit inside, so the tree
 * follows the JSX. Plain elements with nothing of note inside (`<h2>{title}</h2>`) are left out;
 * if that leaves nothing, the returned root element is shown. `when` says when an element is
 * shown, relative to its parent ("always" if it's unconditional): conditions in JSX, early returns, `if` / `switch` branches, lists,
 * lookup objects and render helpers are all followed.
 */
function renderTree(fn: any, make: Make, src: Src): OutlineItem[] {
  if (!fn || !/Function/.test(fn.type)) return [];
  // What each local holds, so JSX kept in a variable is followed to where it's used. A `let` can be
  // assigned in several branches (`if (a) content = <A />; else content = <B />`), each with its condition.
  const locals = new Map<string, { node: any; when: string }[]>();
  const hold = (name: string, node: any, when: string) => locals.set(name, [...(locals.get(name) ?? []), { node, when }]);
  /** What an expression stands for: a local's values (each with when it holds), or the expression itself. */
  const values = (e: any) => (e?.type === "Identifier" && locals.has(e.name) ? locals.get(e.name)! : [{ node: e, when: "" }]);
  const fnValue = (e: any) => values(e).map((v) => v.node).find((n) => /Function/.test(n?.type ?? ""));
  const following = new Set<string>();
  const follow = (name: string | null, run: () => OutlineItem[]): OutlineItem[] => {
    if (!name) return run();
    if (following.has(name)) return [];
    following.add(name);
    try {
      return run();
    } finally {
      following.delete(name);
    }
  };
  const code = (node: any) => src(node).replace(/\s+/g, " ");
  const and = (...parts: string[]) => parts.filter(Boolean).join(", ");
  // How deep in the JSX we are, and whether a returned root element is kept even if it's a plain wrapper.
  let depth = 0;
  let keepRoot = false;

  const element = (node: any, when: string): OutlineItem[] => {
    const name = jsxName(node.openingElement.name);
    const attrs = node.openingElement.attributes;
    depth++;
    const children = [
      // JSX passed as props (`fallback={<Spinner />}`, `renderItem={(u) => <Row />}`) counts as inside.
      ...attrs.flatMap((a: any) => (a.type === "JSXAttribute" ? jsx(a.value, "") : [])),
      ...node.children.flatMap((c: any) => jsx(c, "")),
    ];
    depth--;
    const hidden = hiddenWhen(attrs, code);
    // A plain element that's always shown is kept when something inside it is, so the tree follows the
    // JSX; one with nothing of note inside (`<h2>{title}</h2>`) is left out.
    const plain = !/^[A-Z]/.test(name) && !name.includes(".") && !when && hidden === null;
    if (plain && !children.length && !(keepRoot && depth === 0)) return [];
    const shown = when || "always";
    return [make("render", `<${name}>`, node, { when: hidden === null ? shown : and(shown, `hidden${hidden ? ` ${hidden}` : ""}`), children })];
  };
  const jsx = (node: any, when: string): OutlineItem[] => {
    switch (node?.type) {
      case "JSXElement":
        return element(node, when);
      case "JSXFragment":
        return node.children.flatMap((c: any) => jsx(c, when));
      case "JSXExpressionContainer":
        return expr(node.expression, when);
      default:
        return [];
    }
  };
  const expr = (e: any, when: string): OutlineItem[] => {
    switch (e?.type) {
      case "JSXElement":
      case "JSXFragment":
        return jsx(e, when);
      case "LogicalExpression":
        return e.operator === "&&"
          ? expr(e.right, and(when, `if ${code(e.left)}`))
          : [...expr(e.left, when), ...expr(e.right, and(when, `unless ${code(e.left)}`))];
      case "ConditionalExpression":
        return [...expr(e.consequent, and(when, `if ${code(e.test)}`)), ...expr(e.alternate, and(when, `unless ${code(e.test)}`))];
      case "ArrayExpression":
        return e.elements.flatMap((x: any) => expr(x, when));
      case "CallExpression": {
        const { callee } = e;
        const method = callee.type === "MemberExpression" && !callee.computed ? callee.property.name : null;
        if (method === "map" || method === "flatMap") {
          const cb = fnValue(e.arguments[0]);
          if (!cb) return [];
          const item = cb.params[0] ? code(cb.params[0]) : "item";
          const each = `each ${item}${filtered(callee.object, item)}`;
          return follow(e.arguments[0].type === "Identifier" ? e.arguments[0].name : null, () => body(cb, and(when, each)));
        }
        // A render helper: `{renderRows()}`.
        const helper = callee.type === "Identifier" ? fnValue(callee) : null;
        return helper ? follow(callee.name, () => body(helper, when)) : [];
      }
      case "Identifier":
        return follow(e.name, () => (locals.get(e.name) ?? []).flatMap((v) => expr(v.node, and(when, v.when))));
      case "MemberExpression": {
        // A lookup object: `{ info: <InfoPanel />, stats: <StatsPanel /> }[tab]`.
        const key = e.computed ? null : e.property.name;
        return values(e.object).flatMap(({ node: obj, when: held }) =>
          obj?.type !== "ObjectExpression"
            ? []
            : obj.properties.flatMap((p: any) => {
                const k = p.type === "ObjectProperty" ? (p.key.name ?? p.key.value) : undefined;
                if (k === undefined) return [];
                if (key !== null) return k === key ? expr(p.value, and(when, held)) : [];
                return expr(p.value, and(when, held, `if ${code(e.property)} === ${JSON.stringify(String(k))}`));
              }),
        );
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return body(e, when); // a render prop: `{(user) => <Row user={user} />}`
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "ParenthesizedExpression":
        return expr(e.expression, when);
      default:
        return [];
    }
  };
  /** ` where i.visible` for `items.filter((i) => i.visible).map((i) => …)`, in the map's own names. */
  const filtered = (list: any, item: string): string => {
    const isFilter = list?.type === "CallExpression" && list.callee.type === "MemberExpression" && list.callee.property?.name === "filter";
    if (!isFilter) return "";
    const f = list.arguments[0];
    if (!/Function/.test(f?.type ?? "") || f.body.type === "BlockStatement") return " (filtered)";
    const param = f.params[0]?.type === "Identifier" ? f.params[0].name : null;
    const test = code(f.body);
    return ` where ${param && /^[\w$]+$/.test(item) ? test.replace(new RegExp(`\\b${param.replace(/\$/g, "\\$")}\\b`, "g"), item) : test}`;
  };
  const body = (f: any, when: string) => (f.body?.type === "BlockStatement" ? statements(f.body.body, when) : expr(f.body, when));
  const block = (s: any) => (s?.type === "BlockStatement" ? s.body : s ? [s] : []);
  const returns = (s: any) => block(s).some((x: any) => x.type === "ReturnStatement");
  /** `if (a) … else if (b) … else …` reads "if a", "else if b", "otherwise"; a plain if / else reads "if a", "unless a". */
  const ifChain = (s: any, when: string, first = true): OutlineItem[] => {
    const test = code(s.test);
    const out = statements(block(s.consequent), and(when, `${first ? "if" : "else if"} ${test}`));
    if (s.alternate?.type === "IfStatement") out.push(...ifChain(s.alternate, when, false));
    else if (s.alternate) out.push(...statements(block(s.alternate), and(when, first ? `unless ${test}` : "otherwise")));
    return out;
  };
  const statements = (stmts: any[], when: string): OutlineItem[] => {
    const out: OutlineItem[] = [];
    // Conditions of earlier returns (`if (loading) return <Spinner />`): the final return shows unless they hold.
    const early: string[] = [];
    for (const s of stmts) {
      switch (s.type) {
        case "FunctionDeclaration":
          if (s.id) hold(s.id.name, s, "");
          break;
        case "VariableDeclaration":
          for (const d of s.declarations) if (d.id.type === "Identifier" && d.init) hold(d.id.name, d.init, "");
          break;
        case "ExpressionStatement": {
          const x = s.expression;
          if (x.type === "AssignmentExpression" && x.operator === "=" && x.left.type === "Identifier") hold(x.left.name, x.right, when);
          // `rows.push(<Row />)`, usually in a loop.
          if (x.type === "CallExpression" && x.callee.type === "MemberExpression" && x.callee.property?.name === "push" && x.callee.object.type === "Identifier") {
            for (const arg of x.arguments) hold(x.callee.object.name, arg, when);
          }
          break;
        }
        case "IfStatement":
          out.push(...ifChain(s, when));
          if (returns(s.consequent)) early.push(code(s.test));
          break;
        case "SwitchStatement": {
          let tests: string[] = [];
          for (const c of s.cases) {
            if (c.test) tests.push(code(c.test));
            if (!c.consequent.length) continue; // falls through to the next case
            const test = c.test ? `${code(s.discriminant)} === ${tests.join(" or ")}` : "";
            out.push(...statements(c.consequent, and(when, test ? `if ${test}` : "otherwise")));
            if (c.consequent.some(returns)) early.push(test || "default");
            tests = [];
          }
          break;
        }
        case "ForOfStatement":
        case "ForInStatement":
          out.push(...statements(block(s.body), and(when, `each ${code(s.left.declarations?.[0]?.id ?? s.left)}`)));
          break;
        case "ForStatement":
        case "WhileStatement":
          out.push(...statements(block(s.body), and(when, "in a loop")));
          break;
        case "BlockStatement":
          out.push(...statements(s.body, when));
          break;
        case "ReturnStatement": {
          const rest = early.length === 1 ? `unless ${early[0]}` : early.length ? "otherwise" : "";
          out.push(...expr(s.argument, and(when, rest)));
          return out;
        }
      }
    }
    return out;
  };
  const tree = body(fn, "");
  if (tree.length) return tree;
  // Only plain elements, always shown (`<header>…</header>`): show the root rather than nothing,
  // so the outline doesn't read as if the function renders nothing.
  locals.clear();
  keepRoot = true;
  return body(fn, "");
}

const hides = (n: any) => n?.type === "StringLiteral" && (n.value === "none" || n.value === "hidden");

/**
 * When an element is mounted but not visible: `hidden`, `hidden={x}`, or `style={{ display: x ? "none" : … }}`
 * (or `visibility`). `null` if it isn't hidden, `""` if always, else the condition ("if !open").
 */
function hiddenWhen(attrs: any[], code: (n: any) => string): string | null {
  for (const a of attrs) {
    if (a.type !== "JSXAttribute") continue;
    const v = a.value?.type === "JSXExpressionContainer" ? a.value.expression : a.value;
    if (a.name.name === "hidden") {
      if (!v) return "";
      if (v.type === "BooleanLiteral") return v.value ? "" : null;
      return `if ${code(v)}`;
    }
    if (a.name.name === "style" && v?.type === "ObjectExpression") {
      for (const p of v.properties) {
        const key = p.key?.name ?? p.key?.value;
        if (key !== "display" && key !== "visibility") continue;
        if (hides(p.value)) return "";
        if (p.value?.type === "ConditionalExpression") {
          if (hides(p.value.consequent)) return `if ${code(p.value.test)}`;
          if (hides(p.value.alternate)) return `unless ${code(p.value.test)}`;
        }
      }
    }
  }
  return null;
}

function jsxName(n: any): string {
  if (n.type === "JSXMemberExpression") return `${jsxName(n.object)}.${n.property.name}`;
  if (n.type === "JSXNamespacedName") return `${n.namespace.name}:${n.name.name}`;
  return n.name;
}

// ---------- merging the model's card with the source ----------

/** Kinds that can describe the same declaration (the model may call a useMemo "derived"). */
const FAMILY: Record<string, string> = {
  state: "state",
  ref: "ref",
  context: "context",
  store: "store",
  hook: "hook",
  derived: "value",
  memo: "value",
  function: "fn",
  callback: "fn",
  effect: "effect",
  render: "render",
  constant: "constant",
};
/** Which kinds each field applies to; anything else the model put there is dropped. */
const FIELD_KINDS = {
  type: new Set(["state", "ref", "context", "store", "hook", "derived", "memo", "function", "callback", "constant"]),
  initial: new Set(["state", "ref"]),
  when: new Set(["effect", "render"]),
  returns: new Set(["function", "callback", "effect"]),
};
const baseName = (name: string) => name.replace(/\(.*$/s, "").trim();

/**
 * The source knows declared types and parameter lists; the model knows return types nobody wrote
 * down. A signature from source without a return type is completed with the model's (for hooks the
 * model gives just the return type, for functions usually the whole signature).
 */
function mergeType(s: OutlineItem, modelType: string): string {
  const fromSource = s.type ?? "";
  if (!fromSource) return modelType;
  const isSignature = s.kind === "function" || s.kind === "callback" || s.kind === "hook";
  if (!isSignature || fromSource.includes("=>") || !modelType) return fromSource;
  if (s.kind !== "hook" && modelType.includes("=>")) return modelType;
  return `${fromSource} => ${modelType}`;
}

/**
 * The model writes the prose; the source is the authority on structure. Items found in both
 * take their name, kind, line, type, initial value and dependency list from the source and
 * keep the model's explanation. Items the model skipped are added (without explanation),
 * fields that don't apply to an item's kind are cleared, and props / call sites are completed.
 * This keeps the panel consistent no matter which model wrote the card.
 */
export function mergeWithSource(card: Card, source: Card | null): Card {
  const clean = (item: OutlineItem): OutlineItem => {
    const out = { ...item, children: (item.children ?? []).map(clean) };
    for (const [field, kinds] of Object.entries(FIELD_KINDS)) if (!kinds.has(out.kind)) (out as any)[field] = "";
    return out;
  };
  const outline = card.outline.map(clean);
  if (!source) return { ...card, outline };

  // Props: the source's list and types, the model's descriptions (plus any it found that the source didn't, e.g. spread types).
  const described = new Map(card.props.map((p) => [p.name, p]));
  const props = source.props.length
    ? [
        ...source.props.map((p) => {
          const ai = described.get(p.name);
          described.delete(p.name);
          return { ...p, type: p.type || ai?.type || "", description: ai?.description ?? "" };
        }),
        ...described.values(),
      ]
    : card.props;

  const refs = new Set(card.usedIn.map((u) => u.ref));
  const usedIn = [...card.usedIn, ...source.usedIn.filter((u) => !refs.has(u.ref))];
  return { ...card, props, outline: mergeItems(outline, source.outline), usedIn };
}

/** One level of the outline (and, through children, everything below it). */
function mergeItems(outline: OutlineItem[], source: OutlineItem[]): OutlineItem[] {
  // Names taken from a call (a hook's, a context's, a destructured memo's) and a state's setter sit under
  // their row in the source; the model usually lists them at the top level, so move each under the
  // model's item for that row to pair it with the source's.
  const givenBy = new Map<string, OutlineItem>();
  for (const s of source) for (const c of s.children) if (c.reads !== undefined) givenBy.set(c.name, s);
  if (givenBy.size) {
    const declared = new Set(source.map((s) => baseName(s.name)));
    outline = outline.filter((item) => {
      const parent = item.kind === "render" || declared.has(baseName(item.name)) ? undefined : givenBy.get(baseName(item.name));
      const owner = parent && outline.find((o) => o !== item && FAMILY[o.kind] === FAMILY[parent.kind] && baseName(o.name) === baseName(parent.name));
      if (!owner) return true;
      owner.children = [...owner.children, item];
      return false;
    });
  }

  // When the source could read the JSX, it decides the render tree and the model's render items
  // (at any depth) only lend it their explanations; otherwise the model's are kept as they are.
  const sourceRenders = source.filter((s) => s.kind === "render");
  const pool = sourceRenders.length ? outline.filter((i) => i.kind === "render").flatMap(flatRenders) : [];
  if (pool.length) outline = outline.filter((i) => i.kind !== "render");

  const unmatched = new Set(source.filter((s) => s.kind !== "render"));
  const take = (pred: (s: OutlineItem) => boolean) => {
    const hit = [...unmatched].find(pred);
    if (hit) unmatched.delete(hit);
    return hit;
  };
  for (const item of outline) {
    if (item.kind === "render") continue;
    const family = FAMILY[item.kind];
    const s =
      item.kind === "effect"
        ? // Effects have descriptive labels: pair them by line, else in order.
          (take((s) => s.kind === "effect" && Math.abs(s.line - item.line) <= 1) ?? take((s) => s.kind === "effect"))
        : (take((s) => FAMILY[s.kind] === family && baseName(s.name) === baseName(item.name)) ??
          take((s) => baseName(s.name) === baseName(item.name)));
    if (!s) continue;
    if (item.kind !== "effect") item.name = s.name;
    item.kind = s.kind;
    item.line = s.line;
    item.type = mergeType(s, item.type ?? "");
    if (s.initial) item.initial = s.initial;
    if (s.reads !== undefined) item.reads = s.reads;
    if (s.hook) item.hook = s.hook;
    if (s.from) item.from = s.from;
    // useImperativeHandle, memos and callbacks: when they're rebuilt.
    if ((s.kind === "ref" || s.kind === "memo" || s.kind === "callback") && s.when) item.when = s.when;
    if (s.kind === "effect") {
      if (s.when) item.when = s.when;
      if (!item.returns) item.returns = s.returns;
    }
    item.children = mergeItems(item.children, s.children);
  }
  // What the model left out, in source order with everything else.
  const merged = [...outline, ...unmatched, ...mergeRenders(sourceRenders, pool)];
  // Render items the source has no element for (e.g. a section the model described in words). Plain
  // elements like `div.app` the source left out have nothing of note inside, so those are dropped.
  merged.push(...pool.filter((p) => !p.used && !PLAIN_ELEMENT.test(p.name)).map(({ used: _, ...p }) => p));
  return merged.sort((a, b) => a.line - b.line);
}

type Pooled = OutlineItem & { used?: boolean };

function flatRenders(item: OutlineItem): Pooled[] {
  return [{ ...item, children: [] }, ...item.children.filter((c) => c.kind === "render").flatMap(flatRenders)];
}

/** `<UserRow>` → "userrow"; `div.app` / `<div#main>` → "div", so a model's label for a plain element finds it. */
const tagName = (name: string) =>
  name
    .replace(/[<>/\s]/g, "")
    .replace(/^([a-z][\w-]*)[.#].*$/, "$1")
    .toLowerCase();
/** `div`, `<ul>`, `div.app`, `<section />`: an HTML element, not a component or a described section. */
const PLAIN_ELEMENT = /^<?[a-z][\w-]*(?:[.#][\w-]+)*\s*\/?>?$/;

/**
 * The source's render tree, each element taking the explanation of the model's item for it: the same
 * element (nearest line), else whatever is on its line, else a label naming its tag close by ("Clear button",
 * "product cards" for `<ProductCard>`).
 */
function mergeRenders(nodes: OutlineItem[], pool: Pooled[]): OutlineItem[] {
  const nearest = (fits: (p: Pooled) => boolean, line: number) =>
    pool.filter((p) => !p.used && fits(p)).sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
  return nodes.map((s) => {
    const tag = tagName(s.name);
    const named = labelPattern(s.name);
    const m =
      nearest((p) => tagName(p.name) === tag, s.line) ??
      nearest((p) => p.line === s.line, s.line) ??
      nearest((p) => Math.abs(p.line - s.line) <= 3 && named.test(p.name), s.line);
    if (m) m.used = true;
    return { ...s, explanation: m?.explanation || s.explanation, children: mergeRenders(s.children, pool) };
  });
}

/**
 * How a label written in words may name an element: `<ProductCard>` → "ProductCard", "product card",
 * "product cards"; `<Ctx.Provider>` → "ctx provider". Whole words only, so `<p>` doesn't match "price".
 */
function labelPattern(name: string): RegExp {
  const words = name
    .replace(/[<>/\s]/g, "")
    .split(/[.:_-]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w.replace(/[$]/g, "\\$&"));
  return new RegExp(`\\b${words.join("[\\s._-]*")}s?\\b`, "i");
}

const REF_TYPES = /^(React.)?(Ref|RefObject|ForwardedRef|MutableRefObject)$/;

/**
 * What a ref parameter points at: the `ref` prop's (or forwardRef's second parameter's) type,
 * unwrapped from `Ref<T>` and friends → T's node.
 */
function refTarget(fn: any, name: string, parsed: Parsed): any {
  const src = (n: any) => (n ? parsed.source.slice(n.start, n.end) : "");
  const unwrap = (t: any) => (t?.type === "TSTypeReference" && REF_TYPES.test(src(t.typeName)) ? (t.typeParameters ?? t.typeArguments)?.params?.[0] : null);
  const second = fn.params?.[1];
  if (second?.type === "Identifier" && second.name === name) return unwrap(second.typeAnnotation?.typeAnnotation);
  const member = propMembers(fn, parsed).find((m: any) => (m.key?.name ?? m.key?.value) === name);
  return unwrap(member?.typeAnnotation?.typeAnnotation);
}

/** What a factory returns, unwrapped: `() => ({ … })` or `() => { return [ … ]; }`. */
function returnedExpression(fn: any): any {
  if (!/Function/.test(fn?.type ?? "")) return null;
  const unwrap = (n: any): any => (n?.type === "ParenthesizedExpression" || /^TS(As|Satisfies)Expression$/.test(n?.type ?? "") ? unwrap(n.expression) : n);
  return unwrap(fn.body.type === "BlockStatement" ? [...fn.body.body].reverse().find((s: any) => s.type === "ReturnStatement")?.argument : fn.body);
}

/** The object literal a factory returns, if it returns one. */
function returnedObject(fn: any): any {
  const obj = returnedExpression(fn);
  return obj?.type === "ObjectExpression" ? obj : null;
}

/** Members of the object or array literal a factory returns: functions, or values with a literal's type. */
function literalMembers(fn: any, src: (n: any) => string): Map<string | number, Member> {
  const out = new Map<string | number, Member>();
  const member = (v: any): Member => (/Function/.test(v?.type ?? "") ? { fn: true, type: signature(v, src) } : { fn: false, type: literalType(v) });
  const e = returnedExpression(fn);
  if (e?.type === "ArrayExpression") e.elements.forEach((el: any, i: number) => el && out.set(i, member(el)));
  for (const p of e?.type === "ObjectExpression" ? e.properties : []) {
    const key = p.key?.name ?? p.key?.value;
    if (key == null || p.computed) continue;
    out.set(key, p.type === "ObjectMethod" ? { fn: true, type: `(${p.params.map(src).join(", ")})` } : member(p.value));
  }
  return out;
}

/** The members of the props type (first parameter): `Props`, `Readonly<Props>`, `PropsWithChildren<Props>`, an inline literal. */
function propMembers(fn: any, parsed: Parsed): any[] {
  const param = fn.params?.[0];
  if (!param) return [];
  const pattern = param.type === "AssignmentPattern" ? param.left : param;
  let typeNode = pattern.typeAnnotation?.typeAnnotation;
  while (typeNode?.type === "TSTypeReference" && typeNode.typeName?.type === "Identifier") {
    const decl = parsed.typeDecls.get(typeNode.typeName.name);
    if (decl) typeNode = decl.type === "TSInterfaceDeclaration" ? decl.body : decl.typeAnnotation;
    else typeNode = (typeNode.typeParameters ?? typeNode.typeArguments)?.params?.[0];
  }
  return typeNode?.type === "TSTypeLiteral" ? typeNode.members : typeNode?.type === "TSInterfaceBody" ? typeNode.body : [];
}

/** Props from the first parameter: its type's members, else the names it destructures. */
function propsOf(fn: any, parsed: Parsed, src: (n: any) => string): Card["props"] {
  const param = fn.params?.[0];
  if (!param) return [];
  const pattern = param.type === "AssignmentPattern" ? param.left : param;
  const members = propMembers(fn, parsed);
  const out: Card["props"] = [];
  for (const m of members) {
    const name = m.key?.type === "Identifier" ? m.key.name : m.key?.value;
    if (!name) continue;
    const type = m.type === "TSMethodSignature" ? `(${m.params?.map(src).join(", ") ?? ""}) => ${src(m.returnType?.typeAnnotation) || "void"}` : src(m.typeAnnotation?.typeAnnotation);
    out.push({ name, type, optional: !!m.optional, description: "" });
  }
  if (!out.length && pattern.type === "ObjectPattern") {
    for (const p of pattern.properties) {
      const name = p.key?.type === "Identifier" ? p.key.name : null;
      if (name) out.push({ name, type: "", optional: p.value?.type === "AssignmentPattern", description: "" });
    }
  }
  return out;
}

function boundNames(id: any): string[] {
  if (id.type === "Identifier") return [id.name];
  if (id.type === "ArrayPattern") {
    // Every element, by position ("" for a hole): `[value, setter]` pairs take the first.
    return id.elements.map((el: any) => {
      const target = el?.type === "AssignmentPattern" ? el.left : el?.type === "RestElement" ? el.argument : el;
      return target?.type === "Identifier" ? target.name : "";
    });
  }
  if (id.type === "ObjectPattern") {
    return id.properties
      .map((p: any) => (p.type === "RestElement" ? p.argument : p.value?.type === "AssignmentPattern" ? p.value.left : p.value))
      .filter((v: any) => v?.type === "Identifier")
      .map((v: any) => v.name);
  }
  return [];
}

/** A custom hook's parameters (and return type, if annotated), read from its own source: `(query: string)`. */
function hookSignature(root: string, file: string, hook: string): string {
  const found = findFunction(root, file, hook, 1);
  const parsed = found && parseFile(root, found.file);
  if (!found || !parsed) return "";
  return signature(found.fn, (n) => (n ? parsed.source.slice(n.start, n.end) : ""));
}

/** Items for the names `const { a, b } = call()` takes, typed from what the call gives (`members`). */
function givenItems(make: Make, id: any, node: any, members: Map<string | number, Member>): OutlineItem[] {
  return givenNames(id).map(({ key, name }) => {
    const member = members.get(key);
    return make(member?.fn ? "function" : "derived", name, node, { type: member?.type ?? "", reads: String(key) });
  });
}

/** The names a destructuring takes, each with what it reads: the property's key, or the array position. */
function givenNames(id: any): { key: string | number; name: string }[] {
  const local = (v: any) => (v?.type === "AssignmentPattern" ? v.left : v);
  if (id.type === "ObjectPattern") {
    return id.properties
      .filter((p: any) => local(p.value)?.type === "Identifier" && (p.key?.type === "Identifier" || p.key?.type === "StringLiteral"))
      .map((p: any) => ({ key: p.key.name ?? p.key.value, name: local(p.value).name }));
  }
  if (id.type === "ArrayPattern") {
    return id.elements.flatMap((el: any, i: number) => (local(el)?.type === "Identifier" ? [{ key: i, name: local(el).name }] : []));
  }
  return [];
}

type Member = { fn: boolean; type: string };

/** The members of an object or tuple type, by name (or position): `{ a: number; f(): void }`, an interface, a type alias. */
function typeMembers(t: any, parsed: Parsed, depth = 0): Map<string | number, Member> {
  const src = (n: any) => (n ? parsed.source.slice(n.start, n.end) : "");
  const out = new Map<string | number, Member>();
  if (!t || depth > 4) return out;
  if (t.type === "TSUnionType") return typeMembers(t.types.find((u: any) => !/^TS(Null|Undefined)Keyword$/.test(u.type)), parsed, depth + 1);
  if (t.type === "TSTypeOperator") return typeMembers(t.typeAnnotation, parsed, depth + 1);
  if (t.type === "TSTypeReference" && t.typeName?.type === "Identifier") {
    const decl = parsed.typeDecls.get(t.typeName.name);
    return typeMembers(decl?.type === "TSInterfaceDeclaration" ? decl.body : decl?.typeAnnotation, parsed, depth + 1);
  }
  if (t.type === "TSTupleType") {
    t.elementTypes.forEach((e: any, i: number) => {
      const el = e.type === "TSNamedTupleMember" ? e.elementType : e;
      out.set(i, { fn: el.type === "TSFunctionType", type: src(el) });
    });
  }
  for (const m of t.type === "TSTypeLiteral" ? t.members : t.type === "TSInterfaceBody" ? t.body : []) {
    const key = m.key?.name ?? m.key?.value;
    if (key == null) continue;
    if (m.type === "TSMethodSignature") out.set(key, { fn: true, type: `(${m.params?.map(src).join(", ") ?? ""}) => ${src(m.returnType?.typeAnnotation) || "void"}` });
    else out.set(key, { fn: m.typeAnnotation?.typeAnnotation?.type === "TSFunctionType", type: src(m.typeAnnotation?.typeAnnotation) });
  }
  return out;
}

/**
 * What a custom hook returns, by property name (or array position): whether each is a function, and
 * its type. Read from the hook's return type if annotated, else from what it returns: an object or
 * array literal, a local holding one, or a context value (`useContext(CartContext)` → the context's type).
 */
function hookGives(root: string, file: string, hook: string): Map<string | number, Member> {
  const found = findFunction(root, file, hook, 1);
  const parsed = found && parseFile(root, found.file);
  if (!found || !parsed) return new Map();
  const src = (n: any) => (n ? parsed.source.slice(n.start, n.end) : "");
  const unwrap = (n: any): any => (/^TS(As|Satisfies|NonNull)Expression$|^ParenthesizedExpression$/.test(n?.type) ? unwrap(n.expression) : n);
  const typeArg = (call: any) => call?.typeParameters?.params?.[0] ?? call?.typeArguments?.params?.[0];

  const typeShape = (t: any) => typeMembers(t, parsed);

  if (found.fn.returnType) return typeShape(found.fn.returnType.typeAnnotation);

  // What the hook's body declares, to follow a returned name to what it holds.
  const stmts: any[] = found.fn.body?.type === "BlockStatement" ? found.fn.body.body : [];
  const locals = new Map<string, Member | any>();
  for (const stmt of stmts) {
    if (stmt.type === "FunctionDeclaration" && stmt.id) locals.set(stmt.id.name, { fn: true, type: signature(stmt, src) });
    if (stmt.type !== "VariableDeclaration") continue;
    for (const d of stmt.declarations) {
      if (d.id.type === "Identifier") locals.set(d.id.name, d);
      else if (d.id.type === "ArrayPattern" && d.init?.type === "CallExpression" && /^use(State|Reducer)$/.test(calleeName(d.init) ?? "")) {
        // `[value, setValue]`: the value, then a setter / dispatch.
        const [value, set] = d.id.elements;
        const initial = d.init.arguments[calleeName(d.init) === "useState" ? 0 : 1];
        const type = src(typeArg(d.init)) || literalType(initial) || (initial?.type === "Identifier" ? paramType(found.fn, initial.name, src) : "");
        if (value?.type === "Identifier") locals.set(value.name, { fn: false, type });
        if (set?.type === "Identifier") locals.set(set.name, { fn: true, type: "" });
      }
    }
  }
  const memberOf = (expr: any): Member => {
    const e = unwrap(expr);
    if (/Function/.test(e?.type)) return { fn: true, type: signature(e, src) };
    const call = e?.type === "CallExpression" ? calleeName(e) : null;
    if (call === "useCallback") return { fn: true, type: signature(e.arguments[0], src) };
    if (call === "useMemo") return { fn: false, type: src(typeArg(e)) };
    if (e?.type === "Identifier") {
      const local = locals.get(e.name);
      if (local && "fn" in local) return local;
      if (local) return local.id.typeAnnotation ? { fn: false, type: src(local.id.typeAnnotation.typeAnnotation) } : memberOf(local.init);
      const fn = parsed.functions.get(e.name);
      if (fn) return { fn: true, type: signature(fn, src) };
    }
    return { fn: false, type: literalType(e) };
  };
  const shape = (expr: any, depth = 0): Map<string | number, Member> => {
    const e = unwrap(expr);
    const out = new Map<string | number, Member>();
    if (e?.type === "ObjectExpression") {
      for (const p of e.properties) {
        const key = p.key?.name ?? p.key?.value;
        if (key == null || p.computed) continue;
        out.set(key, p.type === "ObjectMethod" ? { fn: true, type: `(${p.params.map(src).join(", ")})` } : memberOf(p.value));
      }
    } else if (e?.type === "ArrayExpression") {
      e.elements.forEach((el: any, i: number) => el && out.set(i, memberOf(el)));
    } else if (e?.type === "CallExpression" && /^use(Context)?$/.test(calleeName(e) ?? "") && e.arguments[0]?.type === "Identifier") {
      // `createContext<CartContextValue | null>(null)` in this file → its type's members.
      return typeShape(typeArg(parsed.contexts.get(e.arguments[0].name)));
    } else if (e?.type === "Identifier" && depth < 4) {
      const local = locals.get(e.name);
      if (local && !("fn" in local)) return local.id.typeAnnotation ? typeShape(local.id.typeAnnotation.typeAnnotation) : shape(local.init, depth + 1);
    }
    return out;
  };
  const returned = found.fn.body?.type === "BlockStatement" ? [...stmts].reverse().find((s) => s.type === "ReturnStatement")?.argument : found.fn.body;
  return shape(returned);
}

/** The members of a context's value, from `createContext<T>()`'s T. */
function contextMembers(root: string, file: string, name: string): Map<string | number, Member> {
  const found = findContext(root, file, name);
  const t = found && (found.call.typeParameters?.params?.[0] ?? found.call.typeArguments?.params?.[0]);
  return t ? typeMembers(t, found.parsed) : new Map();
}

/** A custom hook's annotated return type, read from its own source: `(): Clock` → "Clock". */
function hookReturnType(root: string, file: string, hook: string): string {
  const found = findFunction(root, file, hook, 1);
  const parsed = found && parseFile(root, found.file);
  const t = found?.fn.returnType?.typeAnnotation;
  return parsed && t ? parsed.source.slice(t.start, t.end) : "";
}

/** What reading a context gives: `createContext<Settings>(…)` → "Settings", `createContext("en-US")` → "string". */
function contextType(root: string, file: string, name: string): string {
  const found = findContext(root, file, name);
  if (!found) return "";
  const { call, parsed } = found;
  const t = call.typeParameters?.params?.[0] ?? call.typeArguments?.params?.[0];
  return t ? parsed.source.slice(t.start, t.end) : literalType(call.arguments[0]);
}

/**
 * The type of a function's parameter, from its annotation or its default value:
 * `(start = 0)` → number, `({ open = false })` → boolean, `(q: string)` → string.
 */
function paramType(fn: any, name: string, src: (n: any) => string): string {
  const fromDefault = (p: any) => src(p.left.typeAnnotation?.typeAnnotation) || literalType(p.right);
  for (const p of fn?.params ?? []) {
    if (p.type === "Identifier" && p.name === name) return src(p.typeAnnotation?.typeAnnotation);
    if (p.type === "AssignmentPattern" && p.left.type === "Identifier" && p.left.name === name) return fromDefault(p);
    const pattern = p.type === "AssignmentPattern" ? p.left : p;
    if (pattern.type !== "ObjectPattern") continue;
    for (const prop of pattern.properties) {
      if (prop.value?.type === "AssignmentPattern" && prop.value.left.name === name) return literalType(prop.value.right);
    }
  }
  return "";
}

function signature(fn: any, src: (n: any) => string): string {
  if (!fn || !/Function/.test(fn.type)) return "";
  const ret = src(fn.returnType?.typeAnnotation);
  return `(${fn.params.map(src).join(", ")})${ret ? ` => ${ret}` : ""}`;
}

function literalType(node: any): string {
  switch (node?.type) {
    case "StringLiteral":
    case "TemplateLiteral":
      return "string";
    case "NumericLiteral":
      return "number";
    case "BooleanLiteral":
      return "boolean";
    case "NullLiteral":
      return "null";
    default:
      return "";
  }
}

/** Whether an effect callback returns a cleanup function. */
function hasCleanup(fn: any): boolean {
  if (!fn || !/Function/.test(fn.type) || fn.body?.type !== "BlockStatement") return false;
  return fn.body.body.some((s: any) => s.type === "ReturnStatement" && s.argument);
}

// ---------- where a component is rendered ----------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo", ".vercel", ".cache", ".react-detective"]);
const SOURCE_EXT = /\.(tsx|jsx|ts|js|mdx)$/;
const MAX_FILES = 4000;

/** `path:line` for each place `<Component` appears in the project's source (no AI, no shell). */
export function findUsages(root: string, component: string, limit = 20): string[] {
  const re = new RegExp(`<${component.replace(/[$.]/g, "\\$&")}[\\s/>]`);
  const out: string[] = [];
  let seen = 0;
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit || seen >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) visit(path.join(dir, e.name));
        continue;
      }
      if (!SOURCE_EXT.test(e.name)) continue;
      seen++;
      const abs = path.join(dir, e.name);
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (!re.test(text)) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      text.split(/\r?\n/).forEach((line, i) => {
        if (out.length < limit && re.test(line)) out.push(`${rel}:${i + 1}`);
      });
    }
  };
  visit(root);
  return out;
}
