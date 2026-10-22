import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hookSlots } from "../src/server/hookslots.ts";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-hooks-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const root = project({
  "src/hooks/useUsers.ts": `
    import { useEffect, useState } from "react";
    export function useUsers(query: string) {
      const [users, setUsers] = useState([]);
      const [loading, setLoading] = useState(true);
      const [attempts] = useState(0); // internal, never returned
      useEffect(() => { const [nested] = useState(1); }, [query]); // nested function: ignored
      return { users, loading };
    }`,
  "src/hooks/useToggle.ts": `
    import { useState, useCallback } from "react";
    export default function useToggle(initial = false) {
      const [on, setOn] = useState(initial);
      const toggle = useCallback(() => setOn((v) => !v), []);
      return [on, toggle] as const;
    }`,
  "src/context/ThemeContext.tsx": `
    import { createContext, useContext } from "react";
    export const ThemeContext = createContext(null);
    export const useTheme = () => useContext(ThemeContext);
    export function useCount() {
      const [count] = useState(0);
      return count;
    }
    export function useLabel() {
      const theme = useTheme();         // custom hook calling a custom hook
      const { users } = useUsers("x");
      return { theme, users };
    }
    import { useUsers } from "../hooks/useUsers";`,
  "src/Dashboard.tsx": `
    import { useState } from "react";
    import { useUsers } from "./hooks/useUsers";
    import useToggle from "./hooks/useToggle";
    import { useTheme, useCount, useLabel } from "@/context/ThemeContext";
    export const Dashboard = memo(function Dashboard() {
      const [query, setQuery] = useState("");
      const { users, loading: isLoading } = useUsers(query);
      const [expanded, toggleExpanded] = useToggle();
      const theme = useTheme();
      const count = useCount();
      const label = useLabel();
      const handle = () => { const [x] = useState(0); }; // not a hook call site
      return null;
    });`,
});

test("labels the component's own state and each custom hook's values in React's order", () => {
  const slots = hookSlots(root, "src/Dashboard.tsx", "Dashboard")!;
  assert.deepEqual(slots.states, [
    { name: "query" },
    // object return: labelled by the returned property, internal ones have no key
    { owner: "useUsers", key: "users", name: "users" },
    { owner: "useUsers", key: "loading", name: "loading" },
    { owner: "useUsers", key: undefined, name: "attempts" },
    // array return: labelled by the name the component destructures into
    { owner: "useToggle", key: "expanded", name: "on" },
    // single value return
    { owner: "useCount", key: "", name: "count" },
    // custom hook calling custom hooks: their values belong to the outer hook
    { owner: "useLabel", key: "users", name: "users" },
    { owner: "useLabel", key: undefined, name: "loading" },
    { owner: "useLabel", key: undefined, name: "attempts" },
  ]);
  assert.deepEqual(slots.contexts, [
    { owner: "useTheme", key: "", name: "ThemeContext" },
    { owner: "useLabel", key: "theme", name: "ThemeContext" },
  ]);
});

test("lists every hook entry React keeps, with effect/memo dependencies and module constants", () => {
  const r = project({
    "src/Search.tsx": `
      import { useState, useRef, useMemo, useCallback, useEffect, useTransition } from "react";
      import { useQuery } from "some-library";
      const PAGE_SIZE = 20;
      const LABELS = { empty: "Nothing here" };
      const helper = () => 1;
      export function Search({ items }) {
        const [query, setQuery] = useState("");
        const inputRef = useRef(null);
        const filtered = useMemo(() => items.filter((i) => i.includes(query)), [items, query]);
        const onChange = useCallback((e) => setQuery(e.target.value), []);
        useEffect(() => { inputRef.current?.focus(); }, []);
        const [isPending, startTransition] = useTransition();
        const result = useQuery(query); // library hook: unknown entries
        const [after] = useState(0);
        return null;
      }`,
  });
  const slots = hookSlots(r, "src/Search.tsx", "Search")!;
  assert.deepEqual(
    slots.hooks.map((h) => [h.hook, h.name, h.deps]),
    [
      ["useState", "query", undefined],
      ["useRef", "inputRef", undefined],
      ["useMemo", "filtered", ["items", "query"]],
      ["useCallback", "onChange", []],
      ["useEffect", "useEffect", []],
      ["useTransition", "isPending", undefined],
      ["useTransition", "isPending (internal)", undefined],
    ],
  );
  // Everything after the library hook is dropped, since its entry count is unknown.
  assert.equal(slots.complete, false);
  assert.deepEqual(slots.constants, { PAGE_SIZE: "20", LABELS: '{ empty: "Nothing here" }' });
});

test("built-ins that add several entries, and use(Context), line up with React's lists", () => {
  // Entry counts as React 19 stores them (checked against a live fiber).
  const r = project({
    "src/Form.tsx": `
      import { use, useActionState, useSyncExternalStore, useRef } from "react";
      import { LocaleContext } from "./ctx";
      export function Form() {
        const [message, action, saving] = useActionState(save, "");
        const online = useSyncExternalStore(subscribe, () => navigator.onLine);
        const locale = use(LocaleContext);
        const data = use(promise); // not a context: no entry anywhere
        const box = useRef(null);
        return null;
      }`,
  });
  const slots = hookSlots(r, "src/Form.tsx", "Form")!;
  assert.deepEqual(
    slots.hooks.map((h) => [h.hook, h.name]),
    [
      ["useActionState", "message"],
      ["useActionState", "saving"],
      ["useActionState", "message (internal)"],
      ["useSyncExternalStore", "online"],
      ["useSyncExternalStore", "online (internal)"],
      ["useRef", "box"],
    ],
  );
  assert.equal(slots.complete, true);
  assert.deepEqual(slots.states.map((s) => s.name), ["message", "saving"]);
  assert.deepEqual(slots.contexts, [{ name: "locale" }]);
});

test("hooks from a package are read from node_modules, through its exports and re-exports", () => {
  // Laid out like @tanstack/react-query: an index re-exporting built files, hooks calling React.*.
  const r = project({
    "app/src/List.tsx": `
      import { useRef } from "react";
      import { useQuery } from "fake-query";
      import { useStore } from "fake-query"; // via export * → more.js → store.js
      export function List() {
        const { data } = useQuery({ key: "x" });
        const value = useStore();
        const box = useRef(null);
        return null;
      }`,
    // Hoisted above the app, as in a workspace.
    "node_modules/fake-query/package.json": JSON.stringify({
      name: "fake-query",
      exports: { ".": { import: { types: "./build/index.d.ts", default: "./build/index.js" }, require: "./build/index.cjs" }, "./store": { import: "./build/store.js" } },
    }),
    "node_modules/fake-query/build/index.js": `import { useQuery } from "./useQuery.js";\nexport * from "./more.js";\nexport { useQuery };`,
    "node_modules/fake-query/build/useQuery.js": `
      import * as React from "react";
      import { useClient } from "./client.js";
      function useQuery(options) {
        const client = useClient();
        const [observer] = React.useState(() => client.observe(options));
        const result = React.useSyncExternalStore(React.useCallback((cb) => observer.subscribe(cb), [observer]), () => observer.get());
        React.useEffect(() => { observer.setOptions(options); }, [options, observer]);
        return result;
      }
      export { useQuery };`,
    "node_modules/fake-query/build/client.js": `import * as React from "react";\nconst ClientContext = React.createContext(null);\nexport const useClient = () => React.useContext(ClientContext);`,
    "node_modules/fake-query/build/more.js": `export { useStore } from "./store.js";`,
    "node_modules/fake-query/build/store.js": `import { useState } from "react";\nexport function useStore() { const [v] = useState(0); return v; }`,
  });
  const slots = hookSlots(path.join(r, "app"), "src/List.tsx", "List")!;
  assert.equal(slots.complete, true);
  assert.deepEqual(
    slots.hooks.map((h) => [h.hook, h.owner ?? ""]),
    [
      ["useState", "useQuery"],
      ["useCallback", "useQuery"],
      ["useSyncExternalStore", "useQuery"],
      ["useSyncExternalStore", "useQuery"],
      ["useEffect", "useQuery"],
      ["useState", "useStore"],
      ["useRef", ""],
    ],
  );
  assert.deepEqual(slots.contexts, [{ owner: "useQuery", key: undefined, name: "ClientContext" }]);
});

test("unknown component or file gives null", () => {
  assert.equal(hookSlots(root, "src/Nope.tsx", "Nope"), null);
  assert.equal(hookSlots(root, undefined, "Dashboard"), null);
});
