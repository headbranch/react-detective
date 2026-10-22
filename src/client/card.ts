import type { Card, OutlineItem } from "../server/card";
import type { HookSlots } from "../server/hookslots";
import { serialize, type LiveData } from "./fiber";
import { esc, inline, srcLink } from "./markdown";
import { evaluate } from "./evaluate";
import { valueBox } from "./value";

// Renders a structured explanation top to bottom: overview, props (with live values),
// the component's internals grouped by type, IDE-outline style (click a row to read about it),
// where it's used, and history.

const svg = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

/** Symbol icons (ready-to-insert HTML), in the spirit of VS Code's outline view. */
const ICONS = {
  // Braces: a value the component holds.
  state: svg(`<path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/>`),
  // A chain link: a reference that's kept between renders.
  ref: svg(`<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>`),
  // Broadcast: provided from somewhere above.
  context: svg(`<circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>`),
  // A cube: a packaged, reusable piece of logic.
  hook: svg(`<path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/>`),
  derived: "x",
  function: "ƒ",
  // A bolt, drawn rather than the ⚡ emoji, which renders in its own colours.
  effect: svg(`<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z"/>`),
  render: "&lt;&gt;",
  // A padlock: fixed, defined outside the component.
  constant: svg(`<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>`),
  other: "•",
};

const KINDS: Record<string, { icon: string; label: string; tag?: string }> = {
  state: { icon: ICONS.state, label: "state (useState)" },
  ref: { icon: ICONS.ref, label: "ref (useRef)" },
  context: { icon: ICONS.context, label: "context (useContext)" },
  store: { icon: ICONS.context, label: "external store (useSyncExternalStore)", tag: "store" },
  hook: { icon: ICONS.hook, label: "custom hook" },
  derived: { icon: ICONS.derived, label: "computed during render" },
  memo: { icon: ICONS.derived, label: "memoized value (useMemo)", tag: "useMemo" },
  callback: { icon: ICONS.function, label: "memoized callback (useCallback)", tag: "useCallback" },
  function: { icon: ICONS.function, label: "function" },
  effect: { icon: ICONS.effect, label: "effect (useEffect)" },
  render: { icon: ICONS.render, label: "rendered output" },
  constant: { icon: ICONS.constant, label: "constant" },
};

/**
 * Groups hold items made by different hooks (State: useState, useReducer, useTransition…). Each kind
 * has a usual hook that goes untagged; any other gets a tag naming it, and a hover label saying what it is.
 */
const USUAL_HOOK: Record<string, string> = { state: "useState", ref: "useRef", context: "useContext", store: "useSyncExternalStore", effect: "useEffect" };
const HOOK_LABELS: Record<string, string> = {
  useReducer: "state updated by a reducer (useReducer)",
  useTransition: "whether a transition is pending (useTransition)",
  useOptimistic: "state shown optimistically while an action runs (useOptimistic)",
  useActionState: "state of a form action (useActionState)",
  useFormStatus: "status of the enclosing form (useFormStatus)",
  useDeferredValue: "a value that lags behind during urgent updates (useDeferredValue)",
  useId: "a unique id, stable across renders (useId)",
  use: "context (use)",
  useLayoutEffect: "effect that runs before paint (useLayoutEffect)",
  useInsertionEffect: "effect that runs before layout effects (useInsertionEffect)",
};

/**
 * The "Outline" section groups items by what they are. `hint` says what the gray text
 * next to each item means (it has one fixed meaning per group); `about` is the tooltip.
 */
const GROUPS: { kinds: string[]; title: string; hint: string; about: string; cls: keyof typeof ICONS }[] = [
  { kinds: ["state"], title: "State", hint: "type", about: "useState, plus other hooks that hold a value (tagged): useReducer, useTransition, useOptimistic, useActionState", cls: "state" },
  { kinds: ["ref"], title: "Refs", hint: "type", about: "useRef, and useImperativeHandle: what a parent's ref to this component sees", cls: "ref" },
  { kinds: ["context", "store"], title: "Subscriptions", hint: "returns", about: "Values read from outside the component that re-render it when they change: context from a provider above it (useContext, or use, tagged), or an external store (useSyncExternalStore, tagged store)", cls: "context" },
  { kinds: ["hook"], title: "Hooks", hint: "signature", about: "Custom hooks it calls; ones from a package are tagged with it", cls: "hook" },
  { kinds: ["derived", "memo"], title: "Computed values", hint: "type", about: "Worked out on each render, or kept by a hook (tagged): useMemo, useDeferredValue, useId", cls: "derived" },
  { kinds: ["function", "callback"], title: "Functions", hint: "signature", about: "Handlers and helpers (useCallback ones are tagged)", cls: "function" },
  { kinds: ["effect"], title: "Effects", hint: "timing", about: "useEffect (useLayoutEffect and useInsertionEffect are tagged), each with when it runs: only on mount, after every render, or on mount and when its dependencies change", cls: "effect" },
  { kinds: ["render"], title: "Renders", hint: "shown when", about: "Parts of the returned JSX", cls: "render" },
  { kinds: ["constant"], title: "Constants", hint: "type", about: "Defined outside the component", cls: "constant" },
];

export interface CardContext {
  component: string;
  /** The component's own file, for outline "go to line" links. */
  file: string;
  live: LiveData;
  /** Names for live hook values, worked out from source by the server. */
  slots?: HookSlots | null;
}

export function renderCard(card: Card, ctx: CardContext): string {
  card = { ...card, outline: flattenSelf(card.outline, ctx.component) };
  // Live values are shown next to what they belong to: prop values under Props,
  // state values on their State items, hook values on their hook.
  const values = liveStateValues(card, ctx.live, ctx.slots);
  return [overview(card), props(card, ctx.live), outline(card, ctx, values), usedIn(card, ctx.live), history(card)].join("");
}

interface LiveValue {
  value: unknown;
  /** For a hook's value: how the hook returns it (property / destructured name, "" = the whole return), or undefined if internal. */
  key?: string;
  /** Declared name (state variable or context). */
  name: string;
  /** Belongs to a custom hook rather than the component itself. */
  fromHook: boolean;
  /** An effect's dependency (shown together under "Current") rather than a value of the item. */
  dep?: boolean;
  /** One piece (under `key`) of a hook's return that the component keeps whole; the pieces are shown together. */
  part?: boolean;
}
/** Live values per outline item, plus every value the panel knows by name (to resolve hook arguments). */
type LiveValues = Map<object, LiveValue[]> & { known?: Map<string, unknown> };

/**
 * After an async transition React keeps useTransition's pending flag as a settled promise
 * (`{ status: "fulfilled", value: false }`); show the value it settled to.
 */
function settled(v: unknown): unknown {
  if (v === null || typeof v !== "object" || !("status" in v) || !("then" in v)) return v;
  const p = v as { status: string; value?: unknown; reason?: unknown };
  return p.status === "fulfilled" ? p.value : p.status === "rejected" ? p.reason : v;
}

/** Attaches each live hook / context value to the outline item it belongs to. */
function liveStateValues(card: Card, live: LiveData, slots?: HookSlots | null): LiveValues {
  const map: LiveValues = new Map();
  const add = (item: object | undefined, v: LiveValue) => {
    if (!item) return;
    if (!map.has(item)) map.set(item, []);
    map.get(item)!.push(v);
  };
  const base = (name: string) => name.replace(/\(.*$/, "").trim();
  const hookItem = (hook: string) => card.outline.find((o) => (o.kind === "hook" || o.kind === "context") && base(o.name) === hook);
  /**
   * A value from a call the component takes names from (a custom hook, a context, a store) goes on
   * the nested name that holds it: by returned property or array position, or, when the call returns
   * one value the component destructures, each name gets its part. A name that keeps a hook's whole
   * return gets all of it, or the pieces the hook hands out put back together. Values a hook keeps
   * internal stay on the hook.
   */
  const spread = (parent: OutlineItem | undefined, key: string | undefined, name: string, value: unknown) => {
    const given = (parent?.children ?? []).filter((c) => c.reads !== undefined);
    // A function's live value says nothing, so it gets none.
    const own = (child: OutlineItem, v: unknown) => {
      if (child.kind !== "function") add(child, { value: v, name: child.name, fromHook: false });
    };
    const whole = given.find((c) => c.reads === "");
    if (key === "" && whole) return void own(whole, value);
    if (key === "" && given.length && value !== null && typeof value === "object") {
      for (const child of given) {
        if (child.reads! in (value as object)) own(child, (value as Record<string, unknown>)[child.reads!]);
      }
      return;
    }
    if (key && whole) return void add(whole, { value, key, name, fromHook: false, part: true });
    // Arrays label a value by the caller's name for it (or `[i]`), objects by the property.
    const child = key ? given.find((c) => c.reads === key || c.name === key || `[${c.reads}]` === key) : undefined;
    if (child) return void own(child, value);
    // What a hook keeps to itself is its own business, not the component's: only what it gives is shown.
    if (parent?.kind === "hook") return;
    add(parent, { value, key, name, fromHook: true });
  };
  const addOwned = (s: { owner?: string; key?: string; name: string }, value: unknown) => spread(hookItem(s.owner!), s.key, s.name, value);
  /** The component's own value: on its item, or split across the names it destructures from it. */
  const addOwn = (item: OutlineItem | undefined, v: LiveValue) =>
    !v.dep && item?.children.some((c) => c.reads !== undefined) ? spread(item, "", v.name, v.value) : add(item, v);
  const states = live.state ?? [];
  const contexts = live.contexts ?? [];

  if (slots && slots.states.length === states.length) {
    slots.states.forEach((s, i) => {
      const value = settled(states[i]);
      if (s.owner) return addOwned(s, value);
      add(card.outline.find((o) => o.kind === "state" && base(o.name) === s.name), { value, key: s.key, name: s.name, fromHook: false });
    });
  } else {
    // Source couldn't be matched up (e.g. an unusual hook): fall back to guessing from the outline.
    stateNames(card, live).forEach((label, i) => {
      const item = card.outline.find((o) => (o.kind === "state" && o.name === label) || (o.kind === "hook" && label.startsWith(base(o.name))));
      add(item, { value: states[i], key: item?.kind === "state" ? undefined : label, name: label, fromHook: item?.kind === "hook" });
    });
  }
  // Refs, memoized values and effects: pair React's full hook list with the list from source.
  matchOtherHooks(card, live, slots, addOwn, addOwned);

  // Contexts line up by identity, not position: each distinct context once, in first-read order.
  const distinct = [...new Set(slots?.contexts.map((s) => s.name) ?? [])];
  if (slots && distinct.length === contexts.length) {
    slots.contexts.forEach((s) => {
      const i = distinct.indexOf(s.name);
      if (s.owner) return addOwned(s, contexts[i]);
      const item = card.outline.find((o) => o.kind === "context" && (base(o.name) === s.name || o.name.includes(s.name) || o.from === s.name || (o.type ?? "").includes(s.name)));
      addOwn(item, { value: contexts[i], key: s.key, name: s.name, fromHook: false });
    });
  }
  // What a parent's ref sees: the handle, read from the ref the parent passed.
  const passed = (live.props && typeof live.props === "object" ? live.props : {}) as Record<string, unknown>;
  for (const handle of card.outline.filter((o) => o.hook === "useImperativeHandle")) {
    const current = (passed[handleRef(handle)] as { current?: unknown } | undefined)?.current;
    if (current !== undefined) spread(handle, "", handle.name, current);
  }
  // Values by name, for resolving what the component passes to its hooks.
  const known = new Map<string, unknown>(Object.entries((live.props && typeof live.props === "object" ? live.props : {}) as Record<string, unknown>));
  for (const vals of map.values()) for (const v of vals) if (!v.fromHook && !v.dep) known.set(v.name, v.value);
  map.known = known;
  return map;
}

/** The ref a useImperativeHandle item sets: `useImperativeHandle(ref)` → "ref". */
const handleRef = (item: OutlineItem) => item.name.match(/^useImperativeHandle\(([\w$]+)\)/)?.[1] ?? "";

const STATE_HOOKS = new Set(["useState", "useReducer", "useOptimistic", "useTransition", "useActionState"]);
/** Built-ins whose stored entry is the value itself. */
const VALUE_HOOKS = new Set(["useSyncExternalStore", "useDeferredValue", "useId"]);
const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect", "useImperativeHandle"]);

/**
 * React's hook list and the source's hook list should be the same length and shape.
 * We walk them together and stop at the first entry that doesn't look like what the
 * source says (e.g. after a library hook), so a mismatch can never mislabel a value.
 */
function matchOtherHooks(
  card: Card,
  live: LiveData,
  slots: HookSlots | null | undefined,
  add: (item: OutlineItem | undefined, v: LiveValue) => void,
  addOwned: (s: { owner?: string; key?: string; name: string }, value: unknown) => void,
) {
  const entries = live.hooks ?? [];
  const list = slots?.hooks ?? [];
  const base = (name: string) => name.replace(/\(.*$/, "").trim();
  const effects = card.outline.filter((o) => o.kind === "effect");
  let effectIndex = 0;
  const memos = new Set<OutlineItem>();
  const handles = card.outline.filter((o) => o.hook === "useImperativeHandle");
  let handleIndex = 0;
  // The live values of each dependency, under the names the source writes them with.
  let slot: HookSlots["hooks"][number];
  const addDeps = (item: OutlineItem | undefined, deps: unknown) => {
    if (!item || !slot.deps?.length || !Array.isArray(deps)) return;
    slot.deps.forEach((name, d) => add(item, { value: serialize(deps[d]), name, fromHook: false, dep: true }));
  };
  for (let i = 0; i < list.length && i < entries.length; i++) {
    slot = list[i];
    const { isState, stored } = entries[i];
    const isObj = stored !== null && typeof stored === "object";
    const fits = STATE_HOOKS.has(slot.hook)
      ? slot.name.endsWith("(internal)") || isState
      : slot.hook === "useRef"
        ? isObj && "current" in (stored as object)
        : slot.hook === "useMemo" || slot.hook === "useCallback"
          ? Array.isArray(stored) && stored.length === 2
          : EFFECT_HOOKS.has(slot.hook)
            ? isObj && ("create" in (stored as object) || "deps" in (stored as object))
            : true;
    if (!fits) return;
    // The value each built-in holds; effects are handled below, state in liveStateValues.
    const value =
      slot.hook === "useRef"
        ? serialize((stored as { current: unknown }).current)
        : slot.hook === "useMemo"
          ? serialize((stored as unknown[])[0])
          : VALUE_HOOKS.has(slot.hook) && !slot.name.endsWith("(internal)")
            ? serialize(stored)
            : MISSING;
    if (slot.owner) {
      if (value !== MISSING) addOwned(slot, value);
      continue;
    }
    if (VALUE_HOOKS.has(slot.hook) && value !== MISSING) {
      const item = card.outline.find((o) => (o.kind === "store" || o.kind === "state" || o.kind === "derived") && base(o.name) === slot.name);
      add(item, { value, name: slot.name, fromHook: false });
    } else if (slot.hook === "useRef") {
      const item = card.outline.find((o) => o.kind === "ref" && base(o.name) === slot.name);
      add(item, { value: serialize((stored as { current: unknown }).current), name: slot.name, fromHook: false });
    } else if (slot.hook === "useMemo") {
      // Destructured memos are all named `useMemo()`, so they pair up in source order.
      const item = card.outline.find((o) => (o.kind === "memo" || o.kind === "derived") && base(o.name) === slot.name && !memos.has(o));
      if (item) memos.add(item);
      add(item, { value: serialize((stored as unknown[])[0]), name: slot.name, fromHook: false });
      addDeps(item, (stored as unknown[])[1]);
    } else if (slot.hook === "useCallback") {
      addDeps(card.outline.find((o) => o.kind === "callback" && base(o.name) === slot.name), (stored as unknown[])[1]);
    } else if (slot.hook === "useImperativeHandle") {
      // Named by the ref they set, which may repeat: pair them in source order.
      const item = handles[handleIndex++];
      addDeps(item, (stored as { deps?: unknown[] | null }).deps);
    } else if (EFFECT_HOOKS.has(slot.hook)) {
      // Effects have labels, not names, so they pair up in source order.
      const item = effects[effectIndex++];
      addDeps(item, (stored as { deps?: unknown[] | null }).deps);
    }
  }
}

/**
 * How an outline item shows its live values. A component's own state or context, or a name
 * a custom hook gives it, is a single value. A custom hook itself shows only what no nested
 * name holds: values it keeps internally, and its return when the component keeps it whole.
 */
function presentValues(all: LiveValue[]): string {
  // Dependencies (of an effect, memo, callback or handle) are shown together, after the item's own value.
  const deps = all.filter((v) => v.dep);
  const depsBox = deps.length ? valueBox(Object.fromEntries(deps.map((v) => [v.name, v.value])), "Current dependencies") : "";
  return ownValues(all.filter((v) => !v.dep)) + depsBox;
}

function ownValues(vals: LiveValue[]): string {
  if (!vals.length) return "";
  // A hook's return the component keeps whole, handed out piece by piece.
  if (vals[0].part) return valueBox(Object.fromEntries(vals.map((v) => [v.key, v.value])), "Current");
  if (!vals[0].fromHook) return valueBox(vals[0].value, "Current");
  const returned = vals.filter((v) => v.key !== undefined);
  const internal = vals.filter((v) => v.key === undefined);
  const whole = returned.find((v) => v.key === "");
  const shown = whole ? whole.value : returned.length ? Object.fromEntries(returned.map((v) => [v.key, v.value])) : undefined;
  const blocks = [
    // Read alongside the hook's signature: "Current arguments" → "Current return".
    shown !== undefined ? valueBox(shown, "Current return") : "",
    ...internal.map((v) => valueBox(v.value, `Internal · ${v.name}`)),
  ];
  return blocks.join("");
}

const MISSING = Symbol("missing");

/**
 * The live values a custom hook is being called with, keyed by the hook's parameter names:
 * `useUsers(query)` with signature `(q: string) => …` gives `{ q: "" }`. Each argument is worked
 * out from what the panel knows live (props, state, refs, memos, context, names from hooks); parts
 * that can't be, like a call, are shown as the code. A single argument to a hook whose parameters
 * aren't known (a package's) is shown as itself.
 */
function hookArguments(item: { name: string; type?: string }, known: Map<string, unknown>): string {
  const call = item.name.match(/^[\w$]+\((.*)\)$/s);
  const args = call ? splitTopLevel(call[1]) : [];
  if (!args.length) return "";
  const params = parameterNames(item.type ?? "");
  const results = args.map((arg) => evaluate(arg, known));
  if (!results.some((r) => r.resolved)) return "";
  if (args.length === 1 && !params[0]) return valueBox(results[0].value, "Current arguments");
  const out: Record<string, unknown> = {};
  results.forEach((r, i) => {
    out[params[i] ?? (/^[\w$]+$/.test(args[i]) ? args[i] : `argument ${i + 1}`)] = r.value;
  });
  return valueBox(out, "Current arguments");
}

/** `(query: string, opts?: Options) => …` → ["query", "opts"]. Destructured parameters have no name. */
function parameterNames(signature: string): (string | undefined)[] {
  if (!signature.startsWith("(")) return [];
  let depth = 0;
  for (let i = 0; i < signature.length; i++) {
    const c = signature[i];
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c) && signature[i - 1] !== "=") depth--;
    if (depth === 0) return splitTopLevel(signature.slice(1, i)).map((p) => p.replace(/^\.\.\./, "").match(/^[A-Za-z_$][\w$]*/)?.[0]);
  }
  return [];
}

/**
 * One argument, short enough to read at a glance (the full code is on hover): an object literal by its
 * keys (`{ queryKey: […], queryFn: () => … }` → `{ queryKey, queryFn }`), a function by its parameters
 * (`(id) => …`), anything else long cut short.
 */
function compactArg(arg: string): string {
  const a = arg.trim();
  if (a.startsWith("{") && a.endsWith("}")) {
    const keys = splitTopLevel(a.slice(1, -1)).map((p) => p.match(/^(\.\.\.)?\s*["']?[\w$]+/)?.[0].replace(/["']/g, "") ?? "…");
    return keys.length ? `{ ${keys.join(", ")} }` : "{}";
  }
  const fn = a.match(/^(async\s+)?(\([^)]*\)|[\w$]+)\s*=>/);
  if (fn) return `${fn[1] ?? ""}${fn[2]} => …`;
  if (/^(async\s+)?function\b/.test(a)) return "function …";
  return a.length > 40 ? `${a.slice(0, 39)}…` : a;
}

/** Splits on commas that aren't inside brackets or strings. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c) && text[i - 1] !== "=") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/** The section is already "Inside <X>", so a single root node for X itself is noise. */
function flattenSelf(outline: Card["outline"], component: string): Card["outline"] {
  const [only] = outline;
  if (outline.length !== 1 || !only.children.length || !only.name.includes(component)) return outline;
  return only.children;
}

/**
 * React only keeps hook values in call order, without names. The outline lists
 * the component's state in source order, so we can label them: own state first,
 * then values that come from inside a custom hook (named after that hook).
 */
function stateNames(card: Card, live: LiveData): string[] {
  const count = live.state?.length ?? 0;
  const names: string[] = [];
  const order = card.outline.filter((i) => i.kind === "state" || i.kind === "hook");
  for (const [i, item] of order.entries()) {
    if (item.kind === "state") {
      names.push(item.name);
      continue;
    }
    // A custom hook may hold any number of states. We can only attribute them
    // when it's the last stateful thing in the outline.
    if (i === order.length - 1) {
      const hook = item.name.replace(/\(.*$/, "");
      const rest = count - names.length;
      for (let n = 1; n <= rest; n++) names.push(rest > 1 ? `${hook} · ${n}` : hook);
    }
    break;
  }
  return names.length === count ? names : [];
}

function section(id: string, title: string, body: string, opts: { count?: number; open?: boolean; extra?: string } = {}): string {
  return `<details class="sec" data-sec="${id}" ${opts.open === false ? "" : "open"}>
    <summary><span class="sec-title">${title}</span>${opts.count !== undefined ? `<span class="count">${opts.count}</span>` : ""}${opts.extra ?? ""}</summary>
    <div class="sec-body">${body}</div>
  </details>`;
}

function overview(card: Card): string {
  // A card read from source alone (shown while the AI writes) has no overview yet.
  if (!card.summary) {
    return section("overview", "Overview", `<p class="summary pending">The AI is writing the overview and explanations. Meanwhile, everything below is read straight from the code.</p>`);
  }
  return section("overview", "Overview", `<p class="summary">${inline(card.summary)}</p>`);
}

// ---------- props ----------

/** Docs-style row: name and type on the left; description and current value on the right. */
function propRow(name: string, type: string, description: string, value: unknown, hasValue: boolean, note = ""): string {
  return `<div class="prop" data-def="${esc(name.replace(/\?$/, ""))}">
    <div class="prop-head">
      <code class="prop-name">${esc(name)}</code>
      ${type ? `<code class="prop-type" title="${esc(type)}">${esc(type)}</code>` : ""}
    </div>
    <div class="prop-body">
      ${description ? `<div class="prop-desc">${inline(description)}</div>` : ""}
      ${note}
      ${hasValue ? valueBox(value, "Current") : ""}
    </div>
  </div>`;
}

function props(card: Card, live: LiveData): string {
  const liveProps = (live.props && typeof live.props === "object" ? live.props : {}) as Record<string, unknown>;
  // A ref the component fills with useImperativeHandle: say what the parent gets through it.
  const exposes = new Map<string, string[]>();
  for (const o of card.outline) if (o.hook === "useImperativeHandle") exposes.set(handleRef(o), o.children.map((c) => c.name));
  const rows = card.props.map((p) => {
    const names = exposes.get(p.name);
    const note = names?.length ? `<div class="prop-desc">Exposes ${names.map((n) => `<code>${esc(n)}</code>`).join(", ")} to the parent through useImperativeHandle.</div>` : "";
    // The handle's value is shown under useImperativeHandle, so not repeated here.
    return propRow(p.name + (p.optional ? "?" : ""), p.type, p.description, liveProps[p.name], p.name in liveProps && !names, note);
  });
  // Values the running app passes that the explanation didn't list (e.g. spread props).
  const described = new Set(card.props.map((p) => p.name));
  for (const [k, v] of Object.entries(liveProps)) {
    if (!described.has(k)) rows.push(propRow(k, "", "", v, true));
  }
  if (!rows.length) return "";
  return section("props", "Props", rows.join(""), { count: rows.length });
}

// ---------- outline ----------

function outline(card: Card, ctx: CardContext, values: LiveValues): string {
  if (!card.outline.length) return "";
  const count = (items: OutlineItem[]): number => items.reduce((n, i) => n + 1 + count(i.children ?? []), 0);
  const total = count(card.outline);
  const known = new Set(GROUPS.flatMap((g) => g.kinds));
  const groups = [...GROUPS, { kinds: [] as string[], title: "Other", hint: "", about: "", cls: "other" as const }].map((g) => ({
    ...g,
    items: card.outline.filter((i) => (g.cls === "other" ? !known.has(i.kind) : g.kinds.includes(i.kind))),
  }));
  const body = groups
    .filter((g) => g.items.length)
    .map(
      (g) => `<details class="ol-group" open>
        <summary class="ol-group-head" title="${esc(g.about)}">
          <span class="ol-icon k-${g.cls}">${ICONS[g.cls]}</span>
          <span class="ol-group-title">${g.title}</span>
          <span class="ol-group-hint">${g.hint ? `<span class="ol-hint-label">${esc(g.hint)}</span>` : ""}</span>
          <span class="count">${g.items.length}</span>
        </summary>
        <ul class="outline">${g.items.map((item) => outlineNode(item, ctx, values)).join("")}</ul>
      </details>`,
    )
    .join("");
  return section("outline", "Outline", body, {
    count: total,
    extra: `<button class="link expand-all" data-expand-all title="Expand or collapse every explanation">expand all</button>`,
  });
}

function fact(label: string, cls: string, html: string): string {
  return `<div class="fact fact-${cls}"><span class="val-label">${label}</span><span class="fact-val">${html}</span></div>`;
}

/** An effect's dependencies as written: `[a, b.c]` → ["a", "b.c"]; null when it has no list. */
function effectDeps(when: string): string[] | null {
  const list = when.trim().match(/^\[(.*)\]$/s);
  return list ? splitTopLevel(list[1]) : null;
}

/**
 * When an effect runs, in words: on mount only, after every render, or on mount and when its
 * dependencies change (the dependencies themselves are listed when the row is opened), plus
 * "before paint" / "before layout" for the effects that run before the browser paints.
 */
function effectTiming(when: string, hook = ""): string {
  const w = when.trim();
  const deps = effectDeps(w);
  const timing =
    deps?.length === 0 || /^(on |only on )?mount|once|mount only/i.test(w)
      ? "only on mount"
      : /every render|no dep/i.test(w)
        ? "after every render"
        : deps?.length || !w
          ? "on mount and when dependencies change"
          : w; // a model's own wording we can't read
  const phase = hook === "useLayoutEffect" ? "before paint" : hook === "useInsertionEffect" ? "before layout" : "";
  return [timing, phase].filter(Boolean).join(" · ");
}

/** A row for a call shows the hook's name: `useCounter(initialCount)` → useCounter, plus what it's called with. */
function callParts(name: string): { shown: string; args: string } {
  const call = name.match(/^(use[\w$]*)\((.*)\)$/s);
  return call ? { shown: call[1], args: call[2].trim() } : { shown: name, args: "" };
}

function outlineNode(item: OutlineItem, ctx: CardContext, values: LiveValues, parent?: OutlineItem): string {
  // The call's arguments are shown when the row is opened (live, or as written); the hint is the hook's signature.
  const { shown, args } = callParts(item.name);
  // A name taken from a call (a custom hook, a context, a store) is a value or function it returns, not worked out here.
  const fromCall = item.reads !== undefined && parent ? `${callParts(parent.name).shown}${parent.kind === "state" ? "" : "()"}` : "";
  const base = KINDS[item.kind] ?? { icon: ICONS.other, label: item.kind };
  const kind = fromCall
    ? parent?.kind === "state"
      ? { ...base, label: `updates ${parent.name}` }
      : { ...base, label: `${item.kind === "derived" ? "value" : "function"} from ${fromCall}`, tag: undefined }
    : item.hook === "useImperativeHandle"
      ? { ...base, label: "what a parent's ref sees (useImperativeHandle)" }
      : item.hook && HOOK_LABELS[item.hook]
        ? { ...base, label: HOOK_LABELS[item.hook] }
        : item.kind === "hook" && item.from
          ? { ...base, label: `hook from ${item.from}` }
          : base;
  // Which hook made it, unless it's the group's usual one or the name already says.
  const tagText = kind.tag ?? (item.hook && item.hook !== USUAL_HOOK[item.kind] ? item.hook : "");
  const tag = tagText && !shown.startsWith(tagText) ? tagText : "";
  const children = item.children ?? [];
  const facts = { type: item.type ?? "", initial: item.initial ?? "", when: item.when ?? "" };
  const liveArgs = item.kind === "hook" ? hookArguments(item, values.known ?? new Map()) : "";
  const block = liveArgs + presentValues(values.get(item) ?? []);
  // Row: name and its type (or, for effects and renders, when they run / are shown).
  // Nothing in the row is repeated when expanded: the pill just wraps to show the full type.
  const typePill = facts.type ? `<span class="ol-type" title="${esc(facts.type)}">${esc(facts.type)}</span>` : "";
  // Everything with a dependency list says when it runs or is rebuilt, in the same words.
  const timed = item.kind === "effect" || item.kind === "memo" || item.kind === "callback" || item.hook === "useImperativeHandle";
  // (Memos and callbacks are worked out during render, not after it.)
  const when = !timed ? facts.when : item.kind === "effect" ? effectTiming(facts.when, item.hook) : effectTiming(facts.when).replace("after every render", "on every render");
  const whenChip = when ? `<span class="ol-when" title="${esc(facts.when)}">${esc(when)}</span>` : "";
  const constant = item.kind === "constant" ? ctx.slots?.constants?.[item.name] : undefined;
  const returns = item.returns;
  // Secondary facts get the same labelled-box look as "Current", so they stand apart from the prose.
  const factRows = [
    facts.initial && fact("Initial", "initial", `<code>${esc(facts.initial)}</code>`),
    constant && fact("Value", "value", `<code>${esc(constant)}</code>`),
    returns && (item.kind === "effect" ? fact("Cleanup", "cleanup", inline(returns)) : fact("Returns", "returns", inline(returns))),
    // An effect's dependencies, when there are no live ones to show them with.
    timed && !block && effectDeps(facts.when)?.length && fact("Dependencies", "deps", effectDeps(facts.when)!.map((d) => `<code>${esc(d)}</code>`).join(", ")),
    // A hook's arguments as written, when there are no live ones to show.
    item.kind === "hook" && args && !liveArgs && fact("Arguments", "args", `<code title="${esc(args)}">${esc(splitTopLevel(args).map(compactArg).join(", "))}</code>`),
  ].filter(Boolean);
  // Plain computed values only exist while rendering; say so rather than show nothing.
  // (Not for a name taken from a hook, context or store: React does hold those.)
  const transient =
    item.kind === "derived" && !fromCall && !block ?`<div class="ol-note">Worked out on every render and not stored by React, so there's no live value to show.</div>` : "";
  return `<li class="ol-node kc-${item.kind}" data-def="${esc(shown)}">
    <div class="ol-row" title="Click to explain">
      <span class="ol-icon k-${item.kind}" title="${esc(kind.label)}">${kind.icon}</span>
      <span class="ol-name" title="${esc(item.name)}">${esc(shown)}</span>
      ${tag ? `<span class="ol-tag">${esc(tag)}</span>` : ""}
      ${item.from && !shown.includes(item.from) ? `<span class="ol-tag ol-from" title="${item.kind === "hook" ? "From the package" : "Reads"} ${esc(item.from)}">${esc(item.from)}</span>` : ""}
      ${typePill}${whenChip}
      <a class="src ol-goto" data-file="${esc(ctx.file)}" data-line="${item.line}" data-col="1" title="Open line ${item.line} in editor">${item.line}</a>
    </div>
    <div class="ol-expl">
      ${inline(item.explanation)}
      ${factRows.length ? `<div class="ol-facts">${factRows.join("")}</div>` : ""}
      ${block ? `<div class="ol-now">${block}</div>` : ""}${transient}
    </div>
    ${children.length ? `<ul class="outline">${children.map((c) => outlineNode(c, ctx, values, item)).join("")}</ul>` : ""}
  </li>`;
}

// ---------- used in / history ----------

/**
 * Each place the component is rendered: the component rendering it there, and the props it passes as
 * written. A prop that's a name in that component links to where it's declared, so data can be
 * followed up the tree. The place that rendered the instance being inspected is marked.
 */
function usedIn(card: Card, live: LiveData): string {
  if (!card.usedIn.length) return "";
  const current = thisCallSite(card, live);
  // Laid out like the Props section (these are props, as one parent passes them): a line saying where,
  // then name and value side by side, each value in the pill a prop's type gets.
  const body = card.usedIn
    .map((u) => {
      const file = u.ref.replace(/:\d+(:\d+)?$/, "");
      const line = u.ref.match(/:(\d+)/)?.[1] ?? "1";
      const props = (u.props ?? []).map((p) => {
        const shown = p.name === "children" && p.value.startsWith("<") ? `${p.value.match(/^<[\w.]+/)?.[0] ?? "<…"} …>` : compactArg(p.value);
        const value = p.line
          ? `<a class="src prop-type used-var" data-file="${esc(file)}" data-line="${p.line}" data-col="1" title="${esc(p.value)}: declared on line ${p.line}">${esc(shown)} ↗</a>`
          : `<code class="prop-type" title="${esc(p.value)}">${esc(shown)}</code>`;
        return `<code class="prop-name">${esc(p.name === "..." ? "{...}" : p.name)}</code><span class="used-val">${value}</span>`;
      });
      return `<div class="used${u === current ? " current" : ""}">
        <div class="used-head">
          <a class="src ref" data-file="${esc(file)}" data-line="${line}" data-col="1" title="Open ${esc(u.ref)} in editor">${esc(file.split("/").pop()!)}:${line}</a>
          ${u.parent ? `<span class="used-in">in <code>&lt;${esc(u.parent)}&gt;</code></span>` : ""}
          ${u === current ? `<span class="used-this" title="The instance you're inspecting was rendered here">this one</span>` : ""}
        </div>
        ${props.length ? `<div class="used-props">${props.join("")}</div>` : ""}
      </div>`;
    })
    .join("");
  return section("used", "Used in", `<div class="used-list">${body}</div>`, { count: card.usedIn.length });
}

/**
 * The call site that rendered the instance being inspected: the one in the component that rendered it
 * (React's owner). When that component renders it in several places, the one whose literal props
 * (`variant="primary"`) match the live ones, if exactly one does.
 */
function thisCallSite(card: Card, live: LiveData): Card["usedIn"][number] | undefined {
  if (!live.owner) return undefined;
  const candidates = card.usedIn.filter((u) => u.parent === live.owner);
  if (candidates.length <= 1) return candidates[0];
  const passed = (live.props && typeof live.props === "object" ? live.props : {}) as Record<string, unknown>;
  const matches = candidates.filter((u) =>
    (u.props ?? []).every((p) => {
      if (p.name === "..." || p.name === "children" || p.name === "key" || p.name === "ref") return true;
      const r = evaluate(p.value, new Map());
      if (!r.resolved || (typeof r.value === "string" && r.value.startsWith("[Code "))) return true;
      return JSON.stringify(r.value) === JSON.stringify(passed[p.name]);
    }),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function history(card: Card): string {
  if (!card.history.length) return "";
  const body = `<ol class="timeline">${card.history
    .map(
      (h) => `<li>
        <div class="tl-meta"><code>${esc(h.commit)}</code>${h.date ? ` · ${esc(h.date)}` : ""}${h.author ? ` · ${esc(h.author)}` : ""}</div>
        <div class="tl-why">${inline(h.why)}</div>
      </li>`,
    )
    .join("")}</ol>`;
  return section("history", "History", body, { count: card.history.length, open: false });
}
