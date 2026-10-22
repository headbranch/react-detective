import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findUsages, mergeWithSource, skeletonCard } from "../src/server/skeleton.ts";
import type { Card, OutlineItem } from "../src/server/card.ts";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-skeleton-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const root = project({
  "src/SearchBox.tsx": `import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUsers } from "./useUsers";

const MIN_QUERY = 2;
const UNUSED = "x";

interface Props {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}

export function SearchBox({ value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const { users } = useUsers(value);
  const trimmed = value.trim();
  const hint = useMemo(() => (trimmed.length < MIN_QUERY ? "short" : "ok"), [trimmed]);
  const clear = useCallback(() => onChange(""), [onChange]);
  function handleKey(e: KeyboardEvent): boolean {
    return e.key === "Escape";
  }
  useEffect(() => {
    document.title = trimmed;
    return () => {
      document.title = "";
    };
  }, [trimmed]);
  useEffect(() => inputRef.current?.focus(), []);
  return <input ref={inputRef} />;
}
`,
  "src/useUsers.ts": `export function useUsers(q: string) { return { users: [] }; }`,
  "src/App.tsx": `import { SearchBox } from "./SearchBox";
export const App = () => (
  <div>
    <SearchBox value="" onChange={() => {}} />
    <SearchBoxes />
  </div>
);`,
  "node_modules/lib/index.tsx": `<SearchBox />`,
});

test("builds props and an outline from source alone", () => {
  const card = skeletonCard(root, "src/SearchBox.tsx", "SearchBox", ["src/App.tsx:4"])!;
  assert.equal(card.summary, "");
  assert.deepEqual(card.props, [
    { name: "value", type: "string", optional: false, description: "" },
    { name: "onChange", type: "(value: string) => void", optional: false, description: "" },
    { name: "label", type: "string", optional: true, description: "" },
  ]);
  assert.deepEqual(
    card.outline.map((o) => [o.kind, o.name, o.line, o.type, o.initial, o.when, o.returns]),
    [
      ["constant", "MIN_QUERY", 4, "number", "", "", ""],
      ["ref", "inputRef", 14, "HTMLInputElement | null", "null", "", ""],
      ["state", "focused", 15, "boolean", "false", "", ""],
      ["hook", "useUsers(value)", 16, "(q: string)", "", "", ""],
      ["derived", "trimmed", 17, "", "", "", ""],
      ["memo", "hint", 18, "", "", "[trimmed]", ""],
      ["callback", "clear", 19, "()", "", "[onChange]", ""],
      ["function", "handleKey", 20, "(e: KeyboardEvent) => boolean", "", "", ""],
      ["effect", "useEffect", 23, "", "", "[trimmed]", ""],
      ["effect", "useEffect", 29, "", "", "[]", "no cleanup"],
      // Only a plain element is rendered, so the root is shown rather than nothing.
      ["render", "<input>", 30, "", "", "always", ""],
    ],
  );
  // What the custom hook gives the component is listed under it.
  assert.deepEqual(card.outline.find((o) => o.kind === "hook")!.children.map((c) => [c.kind, c.name, c.line]), [["derived", "users", 16]]);
  assert.deepEqual(card.usedIn, [{ ref: "src/App.tsx:4" }]);
});

test("finds where a component is rendered, skipping node_modules and similar names", () => {
  assert.deepEqual(findUsages(root, "SearchBox"), ["src/App.tsx:4"]);
  assert.deepEqual(findUsages(root, "Nope"), []);
});

test("merging: source decides structure, the model's prose is kept, gaps are filled", () => {
  const source = skeletonCard(root, "src/SearchBox.tsx", "SearchBox", ["src/App.tsx:4"])!;
  const item = (o: Partial<OutlineItem>): OutlineItem =>
    ({ kind: "derived", name: "", line: 0, type: "", initial: "", returns: "", when: "", explanation: "", children: [], ...o }) as OutlineItem;
  // What a sloppy model might return: wrong kind/line/type, misplaced fields, missing items, a prop without a type.
  const model: Card = {
    summary: "A search field.",
    props: [
      { name: "onChange", type: "", optional: false, description: "Reports typing." },
      { name: "extra", type: "number", optional: true, description: "From a spread type." },
    ],
    outline: [
      item({ kind: "ref", name: "inputRef", line: 99, type: "React.RefObject<HTMLInputElement | null>", explanation: "The input." }),
      item({ kind: "derived", name: "hint", line: 18, when: "[trimmed]", returns: "a message", explanation: "Helper text." }),
      item({ kind: "hook", name: "useUsers", line: 16, type: "{ users: User[] }", explanation: "Loads people." }),
      item({ kind: "callback", name: "clear", line: 19, type: "() => void", explanation: "Empties it." }),
      item({ kind: "effect", name: "sync tab title", line: 23, when: "when trimmed changes", type: "effect", explanation: "Updates the title." }),
      item({ kind: "render", name: "input", line: 31, when: "always", explanation: "The field." }),
    ],
    usedIn: [{ ref: "src/Other.tsx:2" }],
    history: [],
    v: 4,
  };
  const merged = mergeWithSource(model, source);
  const row = (name: string) => merged.outline.find((o) => o.name === name)!;

  assert.deepEqual(pick(row("inputRef")), { kind: "ref", line: 14, type: "HTMLInputElement | null", initial: "null", when: "", returns: "", explanation: "The input." });
  // useMemo the model called "derived", with fields that don't apply to values.
  assert.deepEqual(pick(row("hint")), { kind: "memo", line: 18, type: "", initial: "", when: "[trimmed]", returns: "", explanation: "Helper text." });
  assert.equal(row("useUsers(value)").explanation, "Loads people.");
  // Hook parameters come from the hook's source, the return type from the model.
  assert.equal(row("useUsers(value)").type, "(q: string) => { users: User[] }");
  // Effects keep their label but take the dependency list from the source.
  assert.deepEqual(pick(row("sync tab title")), { kind: "effect", line: 23, type: "", initial: "", when: "[trimmed]", returns: "", explanation: "Updates the title." });
  // The model's render item takes the source's element.
  assert.deepEqual([row("<input>").when, row("<input>").explanation], ["always", "The field."]);
  // The source's signature has no return type here, so the model's fuller one stays.
  assert.equal(row("clear").type, "() => void");
  // Items the model skipped come from the source, without an explanation, in source order.
  assert.deepEqual(
    merged.outline.map((o) => o.name),
    ["MIN_QUERY", "inputRef", "focused", "useUsers(value)", "trimmed", "hint", "clear", "handleKey", "sync tab title", "useEffect", "<input>"],
  );
  assert.equal(row("MIN_QUERY").explanation, "");
  // Props: the source's list and types with the model's descriptions, plus the model's extras.
  assert.deepEqual(
    merged.props.map((p) => [p.name, p.type, p.description]),
    [
      ["value", "string", ""],
      ["onChange", "(value: string) => void", "Reports typing."],
      ["label", "string", ""],
      ["extra", "number", "From a spread type."],
    ],
  );
  assert.deepEqual(merged.usedIn, [{ ref: "src/Other.tsx:2" }, { ref: "src/App.tsx:4" }]);
});

function pick(o: OutlineItem) {
  const { kind, line, type, initial, when, returns, explanation } = o;
  return { kind, line, type, initial, when, returns, explanation };
}

test("React's other built-in hooks are filed by what they hold, not as custom hooks", () => {
  const dir = project({
    "src/Form.tsx": `import { use, useActionState, useDeferredValue, useId, useImperativeHandle, useOptimistic, useSyncExternalStore, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useQuery } from "./useQuery";
import { ThemeContext } from "./theme";

export function Form({ ref, query, promise }) {
  const [isPending, startTransition] = useTransition();
  const [likes, addLike] = useOptimistic(0, (n, d) => n + d);
  const [error, submit, saving] = useActionState(save, "");
  const online = useSyncExternalStore<boolean>(subscribe, getSnapshot);
  const width = useSyncExternalStore(subscribe, () => window.innerWidth);
  const { pending, data } = useFormStatus();
  const deferred = useDeferredValue(query);
  const id = useId();
  const theme = use(ThemeContext);
  const user = use(promise);
  const rows = useQuery(query);
  useImperativeHandle(ref, () => ({ focus() {} }));
  useDebugValue(isPending);
  return null;
}
`,
    "src/useQuery.ts": `export function useQuery(q: string) { return []; }`,
    "src/theme.ts": `export const ThemeContext = createContext<"light" | "dark">("light");`,
  });
  const card = skeletonCard(dir, "src/Form.tsx", "Form")!;
  assert.deepEqual(
    card.outline.map((o) => [o.kind, o.name, o.type, o.initial]),
    [
      ["state", "isPending", "boolean", "false"],
      ["state", "likes", "number", "0"],
      ["state", "error", "string", '""'],
      ["state", "saving", "boolean", "false"],
      ["store", "online", "boolean", ""],
      ["store", "width", "", ""],
      ["state", "pending", "", ""],
      ["state", "data", "", ""],
      ["derived", "deferred", "", ""],
      ["derived", "id", "string", ""],
      ["context", "theme", '"light" | "dark"', ""],
      ["hook", "use(promise)", "", ""],
      ["hook", "useQuery(query)", "(q: string)", ""],
      ["ref", "useImperativeHandle(ref)", "", ""],
    ],
  );
  // Subscriptions say what they read: the context (its type followed through the import), or what the store's snapshot reads.
  assert.deepEqual(
    card.outline.filter((o) => o.from).map((o) => [o.name, o.from]),
    [
      ["online", "getSnapshot()"],
      ["width", "window.innerWidth"],
      ["theme", "ThemeContext"],
    ],
  );
});

const listRoot = project({
  "src/UserList.tsx": `export function UserList({ users, loading, error }) {
  useEffect(() => {
    async function load() {}
    load();
  }, []);
  const handleSelect = (id: number) => {
    const log = () => {};
    log();
  };
  const renderBadge = (u) => <Badge user={u} />;
  if (loading) return <Spinner />;
  const empty = users.length === 0 ? <EmptyState /> : null;
  return (
    <Layout>
      <Header title="Users">
        <SearchBox />
      </Header>
      {error && <p className="error">{error}</p>}
      {empty}
      <ul>
        {users.map((user) => (
          <UserRow key={user.id} user={user} onClick={handleSelect}>
            {user.admin ? <AdminTag /> : <MemberTag />}
          </UserRow>
        ))}
      </ul>
      <Suspense fallback={<Spinner />}>
        <Stats />
      </Suspense>
    </Layout>
  );
}
`,
});

/** The outline as an indented list, for readable assertions. */
function tree(items: OutlineItem[], depth = 0): string[] {
  return items.flatMap((o) => [`${"  ".repeat(depth)}${o.kind} ${o.name}${o.when ? ` [${o.when}]` : ""}`, ...tree(o.children, depth + 1)]);
}

test("renders are a tree of components, with branches, lists and early returns; helpers nest in their function", () => {
  const card = skeletonCard(listRoot, "src/UserList.tsx", "UserList")!;
  assert.deepEqual(tree(card.outline), [
    "effect useEffect [[]]",
    "  function load",
    "function handleSelect",
    "  function log",
    "function renderBadge",
    "  render <Badge> [always]",
    "render <Spinner> [if loading]",
    "derived empty",
    "render <Layout> [unless loading]",
    "  render <Header> [always]",
    "    render <SearchBox> [always]",
    "  render <p> [if error]",
    "  render <EmptyState> [if users.length === 0]",
    // A plain element is kept when something inside it is, so the list sits in its <ul>.
    "  render <ul> [always]",
    "    render <UserRow> [each user]",
    "      render <AdminTag> [if user.admin]",
    "      render <MemberTag> [unless user.admin]",
    "  render <Suspense> [always]",
    "    render <Spinner> [always]",
    "    render <Stats> [always]",
  ]);
});

test("render conditions are followed through variables, branches, switches, lookups, helpers, loops and hiding", () => {
  const dir = project({
    "src/Probe.tsx": `export function Probe({ user, tab, open, items, mode }) {
  const [expanded, setExpanded] = useState(false);
  const canEdit = user.role === "admin";
  let content;
  if (tab === "a") content = <TabA />;
  else if (tab === "b") content = <TabB />;
  else content = <TabC />;
  const panels = { info: <InfoPanel />, stats: <StatsPanel /> };
  const rows = [];
  for (const item of items) rows.push(<Row key={item.id} />);
  function renderFooter() {
    return <Footer />;
  }
  switch (mode) {
    case "loading":
    case "saving":
      return <Spinner />;
    case "error":
      return <ErrorPage />;
  }
  return (
    <Card>
      {open && (
        <Modal>
          {canEdit && <EditForm />}
          {expanded ? <Details /> : <Summary />}
        </Modal>
      )}
      <div hidden={!open}><HiddenThing /></div>
      <section style={{ display: expanded ? "block" : "none" }}><More /></section>
      {content}
      {panels[tab]}
      {rows}
      {renderFooter()}
      {items.filter((x) => x.visible).map((i) => <Item key={i.id} />)}
    </Card>
  );
}
`,
  });
  const card = skeletonCard(dir, "src/Probe.tsx", "Probe")!;
  assert.deepEqual(tree(card.outline.filter((o) => o.kind === "render")), [
    'render <Spinner> [if mode === "loading" or "saving"]',
    'render <ErrorPage> [if mode === "error"]',
    "render <Card> [otherwise]",
    "  render <Modal> [if open]",
    "    render <EditForm> [if canEdit]",
    "    render <Details> [if expanded]",
    "    render <Summary> [unless expanded]",
    "  render <div> [always, hidden if !open]",
    "    render <HiddenThing> [always]",
    "  render <section> [always, hidden unless expanded]",
    "    render <More> [always]",
    '  render <TabA> [if tab === "a"]',
    '  render <TabB> [else if tab === "b"]',
    "  render <TabC> [otherwise]",
    '  render <InfoPanel> [if tab === "info"]',
    '  render <StatsPanel> [if tab === "stats"]',
    "  render <Row> [each item]",
    "  render <Footer> [always]",
    "  render <Item> [each i where i.visible]",
  ]);
});

test("merging renders: the source's tree, with the model's explanations matched by element", () => {
  const source = skeletonCard(listRoot, "src/UserList.tsx", "UserList")!;
  const item = (o: Partial<OutlineItem>): OutlineItem =>
    ({ kind: "render", name: "", line: 0, type: "", initial: "", returns: "", when: "", explanation: "", children: [], ...o }) as OutlineItem;
  const model: Card = {
    summary: "",
    props: [],
    outline: [
      // Flat, a line off, and one item the source has no element for.
      item({ name: "<UserRow>", line: 22, when: "each user", explanation: "One row per user." }),
      item({ name: "Spinner", line: 11, explanation: "While loading." }),
      item({ name: "<Layout>", line: 14, explanation: "Page frame.", children: [item({ name: "<SearchBox>", line: 16, explanation: "Filters the list." })] }),
      // A label that names the element's tag, two lines off.
      item({ name: "Suspense boundary", line: 29, explanation: "Waits for the stats." }),
      item({ name: "footer note", line: 40, explanation: "Words only." }),
      item({ name: "div.wrapper", line: 41, explanation: "A wrapper the source leaves out." }),
    ],
    usedIn: [],
    history: [],
    v: 4,
  };
  const merged = mergeWithSource(model, source);
  const renders = merged.outline.filter((o) => o.kind === "render");
  assert.deepEqual(
    renders.map((o) => [o.name, o.explanation]),
    [
      ["<Spinner>", "While loading."],
      ["<Layout>", "Page frame."],
      ["footer note", "Words only."],
    ],
  );
  const layout = renders[1];
  assert.equal(layout.children.find((c) => c.name === "<Header>")!.children[0].explanation, "Filters the list.");
  assert.equal(layout.children.find((c) => c.name === "<ul>")!.children[0].explanation, "One row per user.");
  assert.equal(layout.children.find((c) => c.name === "<Suspense>")!.explanation, "Waits for the stats.");
  // The fallback spinner is a different element from the loading one, so it stays unexplained.
  assert.equal(layout.children.find((c) => c.name === "<Suspense>")!.children[0].explanation, "");
});

test("a function that renders only plain elements shows its root, not nothing", () => {
  const dir = project({
    "src/Header.tsx": `export function Header({ count }: { count: number }) {
  function renderBadge() {
    return <b>{count}</b>;
  }
  return (
    <header className="site-header">
      <span className="logo">shop</span>
      <span>{renderBadge()}</span>
    </header>
  );
}
export function Pair() {
  return (
    <>
      <span>a</span>
      <span>b</span>
    </>
  );
}
export function WithItem() {
  return <div><Item /></div>;
}`,
  });
  assert.deepEqual(tree(skeletonCard(dir, "src/Header.tsx", "Header")!.outline), [
    "function renderBadge",
    "  render <b> [always]",
    // The root only: the plain elements inside it are still left out.
    "render <header> [always]",
  ]);
  // A fragment has no element of its own, so each of its top-level elements is a root.
  assert.deepEqual(tree(skeletonCard(dir, "src/Header.tsx", "Pair")!.outline), ["render <span> [always]", "render <span> [always]"]);
  // With something of note inside, a plain element is kept for what it holds.
  assert.deepEqual(tree(skeletonCard(dir, "src/Header.tsx", "WithItem")!.outline), ["render <div> [always]", "  render <Item> [always]"]);
});

test("merging: a model's label for a plain element (`div.app`) explains the source's <div>", () => {
  const dir = project({ "src/App.tsx": `export function App() {\n  return (\n    <div className="app">\n      <Header />\n    </div>\n  );\n}` });
  const item = (o: Partial<OutlineItem>): OutlineItem =>
    ({ kind: "render", name: "", line: 0, type: "", initial: "", returns: "", when: "always", explanation: "", children: [], ...o }) as OutlineItem;
  const model: Card = { summary: "", props: [], outline: [item({ name: "div.app", line: 2, explanation: "Page shell." })], usedIn: [], history: [], v: 4 };
  const merged = mergeWithSource(model, skeletonCard(dir, "src/App.tsx", "App"));
  assert.deepEqual(tree(merged.outline), ["render <div> [always]", "  render <Header> [always]"]);
  assert.equal(merged.outline[0].explanation, "Page shell.");
});

test("merging: a label in words (`product cards`) explains the element it names, a line off", () => {
  const dir = project({
    "src/Grid.tsx": `export function Grid({ products }) {\n  return (\n    <div className="grid">\n      {products.map((p) => (\n        <ProductCard key={p.id} product={p} />\n      ))}\n    </div>\n  );\n}`,
  });
  const item = (o: Partial<OutlineItem>): OutlineItem =>
    ({ kind: "render", name: "", line: 0, type: "", initial: "", returns: "", when: "", explanation: "", children: [], ...o }) as OutlineItem;
  const model: Card = {
    summary: "",
    props: [],
    outline: [
      item({ name: "grid container", line: 3, when: "always", explanation: "The grid." }),
      item({ name: "product cards", line: 4, when: "each product", explanation: "One card per product." }),
    ],
    usedIn: [],
    history: [],
    v: 4,
  };
  const merged = mergeWithSource(model, skeletonCard(dir, "src/Grid.tsx", "Grid"));
  assert.deepEqual(tree(merged.outline), ["render <div> [always]", "  render <ProductCard> [each p]"]);
  assert.deepEqual([merged.outline[0].explanation, merged.outline[0].children[0].explanation], ["The grid.", "One card per product."]);
});

test("names given by a custom hook are listed under it, as functions or values; every array element counts, holes don't", () => {
  const dir = project({
    "src/Cart.tsx": `import { useReducer } from "react";
import { useCart, useLocalStorage } from "./hooks";
export function Cart({ pair }: { pair: [number, number] }) {
  const { count, add: addItem } = useCart();
  const [theme, setTheme] = useLocalStorage("theme");
  const cart = useCart();
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const [left, right] = pair;
  return <p>{count}</p>;
}`,
    "src/hooks.ts": `export function useCart() { return { count: 0, add() {} }; }
export function useLocalStorage(key: string) { return ["", () => {}] as const; }`,
  });
  assert.deepEqual(tree(skeletonCard(dir, "src/Cart.tsx", "Cart")!.outline), [
    "hook useCart()",
    "  derived count",
    "  function addItem",
    'hook useLocalStorage("theme")',
    "  derived theme",
    "  function setTheme",
    // Kept whole: the one name, reading all of it.
    "hook useCart()",
    "  derived cart",
    // `[, forceUpdate]` keeps no state value, so nothing is listed (and forceUpdate isn't taken for one).
    "derived left",
    "derived right",
    "render <p> [always]",
  ]);
});

test("what a hook gives is read through its return: locals, useState pairs, useCallback, a typed context", () => {
  const dir = project({
    "src/Header.tsx": `import { useCart, useToggle } from "./hooks";
export function Header() {
  const { count, add } = useCart();
  const [on, toggle] = useToggle();
  return <p>{count}</p>;
}`,
    "src/hooks.ts": `import { createContext, useCallback, useContext, useState } from "react";
interface Cart { count: number; add: (id: string) => void }
const CartContext = createContext<Cart | null>(null);
export function useCart() {
  const ctx = useContext(CartContext);
  return ctx!;
}
export function useToggle() {
  const [on, setOn] = useState(false);
  const toggle = useCallback(() => setOn((v) => !v), []);
  return [on, toggle] as const;
}`,
  });
  const hooks = skeletonCard(dir, "src/Header.tsx", "Header")!.outline.filter((o) => o.kind === "hook");
  assert.deepEqual(
    hooks.flatMap((h) => h.children.map((c) => [c.kind, c.name, c.type])),
    [
      ["derived", "count", "number"],
      ["function", "add", "(id: string) => void"],
      ["derived", "on", "boolean"],
      ["function", "toggle", "()"],
    ],
  );
});

test("a destructured context or store read lists its names under it, like a hook; kept whole it stays one row", () => {
  const dir = project({
    "src/Panel.tsx": `import { useContext, useSyncExternalStore } from "react";
import { SettingsContext } from "./settings";
export function Panel() {
  const { compact, setCompact } = useContext(SettingsContext);
  const settings = useContext(SettingsContext);
  const { x, y } = useSyncExternalStore<{ x: number; y: number }>(subscribe, getPointer);
  return null;
}`,
    "src/settings.ts": `interface Settings { compact: boolean; setCompact: (c: boolean) => void }
export const SettingsContext = createContext<Settings>(defaults);`,
  });
  const outline = skeletonCard(dir, "src/Panel.tsx", "Panel")!.outline;
  const rows = (items: OutlineItem[], depth = 0): string[] =>
    items.flatMap((o) => [`${"  ".repeat(depth)}${o.kind} ${o.name} : ${o.type}${o.reads !== undefined ? ` reads ${o.reads}` : ""}`, ...rows(o.children, depth + 1)]);
  assert.deepEqual(rows(outline), [
    "context useContext(SettingsContext) : Settings",
    "  derived compact : boolean reads compact",
    "  function setCompact : (c: boolean) => void reads setCompact",
    "context settings : Settings",
    "store useSyncExternalStore() : { x: number; y: number }",
    "  derived x : number reads x",
    "  derived y : number reads y",
  ]);
});

test("useImperativeHandle lists what it exposes, typed from the ref's handle type, with when it's rebuilt", () => {
  const dir = project({
    "src/Field.tsx": `import { forwardRef, useImperativeHandle, type Ref, type ForwardedRef } from "react";
interface Handle { focus: () => void; value: string }
export function Field({ ref, label }: { ref?: Ref<Handle>; label: string }) {
  useImperativeHandle(ref, () => ({ focus() {}, value: label, extra: 1 }), [label]);
  return null;
}
export const Old = forwardRef(function Old(props: {}, outer: ForwardedRef<Handle>) {
  useImperativeHandle(outer, () => ({ focus: () => {} }));
  return null;
});`,
  });
  const rows = (items: OutlineItem[], depth = 0): string[] =>
    items.flatMap((o) => [`${"  ".repeat(depth)}${o.kind} ${o.name} : ${o.type}${o.when ? ` [${o.when}]` : ""}`, ...rows(o.children, depth + 1)]);
  assert.deepEqual(rows(skeletonCard(dir, "src/Field.tsx", "Field")!.outline), [
    "ref useImperativeHandle(ref) : Handle [[label]]",
    "  function focus : () => void",
    "  derived value : string",
    // Not in the handle type: typed from the object itself.
    "  derived extra : number",
  ]);
  assert.deepEqual(rows(skeletonCard(dir, "src/Field.tsx", "Old")!.outline), [
    "ref useImperativeHandle(outer) : Handle [every render]",
    "  function focus : () => void",
  ]);
});

test("a destructured useMemo lists its names under it, typed from what it returns", () => {
  const dir = project({
    "src/Stats.tsx": `import { useMemo } from "react";
export function Stats({ items }: { items: number[] }) {
  const { total, label } = useMemo(() => ({ total: items.length, label: "n" }), [items]);
  const [first, onPick] = useMemo(() => [items[0], (i: number) => i], [items]);
  return null;
}`,
  });
  const rows = (items: OutlineItem[], depth = 0): string[] =>
    items.flatMap((o) => [`${"  ".repeat(depth)}${o.kind} ${o.name} : ${o.type}`, ...rows(o.children, depth + 1)]);
  assert.deepEqual(rows(skeletonCard(dir, "src/Stats.tsx", "Stats")!.outline), [
    "memo useMemo() : ",
    "  derived total : ",
    "  derived label : string",
    "memo useMemo() : ",
    "  derived first : ",
    "  function onPick : (i: number)",
  ]);
});

test("the function a state hook hands back sits under the state; memos and callbacks keep their dependencies", () => {
  const dir = project({
    "src/Todo.tsx": `import { useCallback, useMemo, useOptimistic, useReducer, useState, useTransition } from "react";
type Action = { type: "add"; text: string };
function reducer(items: string[], action: Action) { return items; }
export function Todo() {
  const [query, setQuery] = useState("");
  const [items, dispatch] = useReducer(reducer, []);
  const [isPending, startTransition] = useTransition();
  const [shown, addShown] = useOptimistic(items, (current: string[], text: string) => [...current, text]);
  const count = useMemo(() => items.length, []);
  const onAdd = useCallback(() => dispatch({ type: "add", text: query }));
  return null;
}`,
  });
  const card = skeletonCard(dir, "src/Todo.tsx", "Todo")!;
  const rows = (items: OutlineItem[], depth = 0): string[] =>
    items.flatMap((o) => [`${"  ".repeat(depth)}${o.kind} ${o.name} : ${o.type}${o.when ? ` [${o.when}]` : ""}`, ...rows(o.children, depth + 1)]);
  assert.deepEqual(rows(card.outline), [
    "state query : string",
    "  function setQuery : Dispatch<SetStateAction<string>>",
    "state items : ",
    "  function dispatch : (action: Action) => void",
    "state isPending : boolean",
    "  function startTransition : (action: () => void | Promise<void>) => void",
    "state shown : ",
    "  function addShown : (text: string) => void",
    "memo count :  [[]]",
    "callback onAdd : () [every render]",
  ]);

  // The model lists the setter at the top level: it's moved under its state and paired with the source's.
  const item = (o: Partial<OutlineItem>): OutlineItem =>
    ({ kind: "derived", name: "", line: 0, type: "", initial: "", returns: "", when: "", explanation: "", children: [], ...o }) as OutlineItem;
  const merged = mergeWithSource(
    {
      summary: "",
      props: [],
      outline: [item({ kind: "state", name: "query", line: 5, explanation: "The search." }), item({ kind: "function", name: "setQuery", line: 5, explanation: "Changes it." })],
      usedIn: [],
      history: [],
      v: 4,
    },
    card,
  );
  const query = merged.outline.find((o) => o.name === "query")!;
  assert.deepEqual(query.children.map((c) => [c.name, c.explanation, c.type]), [["setQuery", "Changes it.", "Dispatch<SetStateAction<string>>"]]);
  assert.equal(merged.outline.filter((o) => o.name === "setQuery").length, 0);
});

test("items record which hook made them, so groups can tell them apart; package hooks name their package", () => {
  const dir = project({
    "src/Mixed.tsx": `import { use, useContext, useDeferredValue, useId, useLayoutEffect, useReducer, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocal } from "./useLocal";
export function Mixed({ q }: { q: string }) {
  const [a, setA] = useState(0);
  const [b, dispatch] = useReducer(r, 0);
  const theme = useContext(ThemeContext);
  const locale = use(LocaleContext);
  const online = useSyncExternalStore(sub, () => navigator.onLine);
  const id = useId();
  const deferred = useDeferredValue(q);
  const result = useQuery({ queryKey: [q] });
  const local = useLocal();
  useLayoutEffect(() => {}, []);
  return null;
}`,
    "src/useLocal.ts": `export function useLocal() { return 1; }`,
  });
  const outline = skeletonCard(dir, "src/Mixed.tsx", "Mixed")!.outline;
  assert.deepEqual(
    outline.map((o) => [o.name.replace(/\(.*$/s, ""), o.hook ?? "", o.kind === "hook" ? (o.from ?? "") : ""]),
    [
      ["a", "useState", ""],
      ["b", "useReducer", ""],
      ["theme", "useContext", ""],
      ["locale", "use", ""],
      ["online", "useSyncExternalStore", ""],
      ["id", "useId", ""],
      ["deferred", "useDeferredValue", ""],
      ["useQuery", "", "@tanstack/react-query"],
      ["useLocal", "", ""],
      ["useLayoutEffect", "useLayoutEffect", ""],
    ],
  );
});

test("a package's hook is shown as a black box: the call and the names taken from it, nothing read from its code", () => {
  const dir = project({
    "src/List.tsx": `import { useQuery } from "fake-query";
export function List() {
  const { data, isFetching } = useQuery({ key: "x" });
  return null;
}`,
    "node_modules/fake-query/package.json": JSON.stringify({ name: "fake-query", module: "index.js" }),
    "node_modules/fake-query/index.js": `import * as React from "react";
export function useQuery(options, client) { const [o] = React.useState(() => ({ data: 1, isFetching: () => false })); return o; }`,
  });
  const hook = skeletonCard(dir, "src/List.tsx", "List")!.outline.find((o) => o.kind === "hook")!;
  assert.deepEqual(
    [hook.type, hook.from, hook.children.map((c) => [c.kind, c.name, c.type])],
    ["", "fake-query", [["derived", "data", ""], ["derived", "isFetching", ""]]],
  );
});

test("merging: the model's top-level item for a name a hook gives is paired with the one under the hook", () => {
  const dir = project({
    "src/Header.tsx": `import { useCart } from "./cart";
export function Header() {
  const { count } = useCart();
  return <header>{count}</header>;
}`,
    "src/cart.ts": `export function useCart() { return { count: 0 }; }`,
  });
  const source = skeletonCard(dir, "src/Header.tsx", "Header")!;
  const item = (o: Partial<OutlineItem>): OutlineItem =>
    ({ kind: "derived", name: "", line: 0, type: "", initial: "", returns: "", when: "", explanation: "", children: [], ...o }) as OutlineItem;
  const model: Card = {
    summary: "",
    props: [],
    outline: [
      item({ kind: "hook", name: "useCart()", line: 3, explanation: "Reads the cart." }),
      item({ name: "count", line: 3, type: "number", explanation: "Items in the cart." }),
    ],
    usedIn: [],
    history: [],
    v: 4,
  };
  const merged = mergeWithSource(model, source);
  assert.deepEqual(tree(merged.outline), ["hook useCart()", "  derived count", "render <header> [always]"]);
  const count = merged.outline[0].children[0];
  assert.deepEqual([count.type, count.explanation], ["number", "Items in the cart."]);
});

test("unknown component gives null", () => {
  assert.equal(skeletonCard(root, "src/SearchBox.tsx", "Nope"), null);
  assert.equal(skeletonCard(root, undefined, "SearchBox"), null);
});
