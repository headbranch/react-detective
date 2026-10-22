// Reads live props/state from React's internal fiber tree. Only client components
// have fibers; Server Components simply return nothing here.

export interface LiveData {
  props?: unknown;
  state?: unknown[];
  /** Values of the contexts it read (directly or through custom hooks), in read order. */
  contexts?: unknown[];
  /**
   * Every entry in React's hook list for this component, in order: state, refs, memos,
   * callbacks, effects… These are live objects (not serialized) and stay in the browser;
   * the panel pairs them with names worked out from source.
   */
  hooks?: HookEntry[];
  /** The component that rendered this one (its owner in React's dev build), to tell which call site it came from. */
  owner?: string;
}

export interface HookEntry {
  /** useState / useReducer-style entries have an update queue. */
  isState: boolean;
  /** React's stored value for the hook: the state, a ref object, [value, deps], an effect… */
  stored: unknown;
}

export function readLiveData(el: Element, componentName: string): LiveData {
  const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  let fiber: any = fiberKey ? (el as any)[fiberKey] : null;
  while (fiber) {
    if (typeof fiber.type !== "string" && fiberName(fiber) === componentName) {
      const current = currentFiber(fiber);
      const owner = current._debugOwner && typeof current._debugOwner.type !== "string" ? fiberName(current._debugOwner) : undefined;
      return { props: serialize(stripChildren(current.memoizedProps)), state: readHookState(current), contexts: readContexts(current), hooks: readHooks(current), owner };
    }
    fiber = fiber.return;
  }
  return {};
}

/**
 * React double-buffers fibers and a DOM node's fiber reference can point at the
 * stale copy. Search the committed tree to find which of the pair is current.
 */
function currentFiber(fiber: any): any {
  const alt = fiber.alternate;
  if (!alt) return fiber;
  let top = fiber;
  while (top.return) top = top.return;
  const root = top.stateNode?.current;
  if (!root) return fiber;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node === fiber) return fiber;
    if (node === alt) return alt;
    if (node.sibling) stack.push(node.sibling);
    if (node.child) stack.push(node.child);
  }
  return fiber;
}

function fiberName(fiber: any): string | undefined {
  const t = fiber.type;
  if (!t) return;
  if (typeof t === "function") return t.displayName || t.name;
  // memo / forwardRef wrappers
  return t.displayName || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name;
}

function stripChildren(props: any) {
  if (!props || typeof props !== "object") return props;
  const { children, ...rest } = props;
  return children === undefined ? rest : { ...rest, children: "[children]" };
}

/**
 * React records each context a component reads, with the value it got. In development
 * the same context can be listed more than once, so keep one entry per context, in
 * first-read order.
 */
function readContexts(fiber: any): unknown[] | undefined {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let dep = fiber.dependencies?.firstContext;
  let guard = 0;
  while (dep && guard++ < 50) {
    if (!seen.has(dep.context)) {
      seen.add(dep.context);
      out.push(serialize(dep.memoizedValue));
    }
    dep = dep.next;
  }
  return out.length ? out : undefined;
}

function readHooks(fiber: any): HookEntry[] | undefined {
  if (fiber.tag === 1) return undefined; // class component: no hooks
  const out: HookEntry[] = [];
  let hook = fiber.memoizedState;
  let guard = 0;
  while (hook && guard++ < 100) {
    out.push({ isState: !!hook.queue && "lastRenderedState" in hook.queue, stored: hook.memoizedState });
    hook = hook.next;
  }
  return out.length ? out : undefined;
}

/** useState/useReducer hooks are the ones with an update queue. */
function readHookState(fiber: any): unknown[] | undefined {
  if (fiber.tag === 1) return fiber.memoizedState ? [serialize(fiber.memoizedState)] : undefined; // class component
  const out: unknown[] = [];
  let hook = fiber.memoizedState;
  let guard = 0;
  while (hook && guard++ < 50) {
    if (hook.queue && "lastRenderedState" in hook.queue) out.push(serialize(hook.memoizedState));
    hook = hook.next;
  }
  return out.length ? out : undefined;
}

export function serialize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "string") return (value as string).length > 300 ? (value as string).slice(0, 300) + "…" : value;
  if (type === "number" || type === "boolean") return value;
  if (type === "bigint") return `${value}n`;
  if (type === "symbol") return String(value);
  if (type === "function") return `[Function ${(value as Function).name || "anonymous"}]`;
  const obj = value as any;
  if (obj.$$typeof) return `[React element${obj.type ? ` <${typeof obj.type === "string" ? obj.type : obj.type.displayName || obj.type.name || "?"}>` : ""}]`;
  if (typeof Element !== "undefined" && obj instanceof Element) return `[DOM <${obj.tagName.toLowerCase()}>]`;
  if (obj instanceof Date) return obj.toISOString();
  if (seen.has(obj)) return "[Circular]";
  if (depth >= 5) return Array.isArray(obj) ? `[Array(${obj.length})]` : "[Object]";
  seen.add(obj);
  if (Array.isArray(obj)) {
    const items = obj.slice(0, 10).map((v) => serialize(v, depth + 1, seen));
    if (obj.length > 10) items.push(`… ${obj.length - 10} more`);
    return items;
  }
  if (obj instanceof Map) return { "[Map]": serialize(Object.fromEntries([...obj.entries()].slice(0, 10)), depth + 1, seen) };
  if (obj instanceof Set) return { "[Set]": serialize([...obj].slice(0, 10), depth + 1, seen) };
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  for (const k of keys.slice(0, 25)) out[k] = serialize(obj[k], depth + 1, seen);
  if (keys.length > 25) out["…"] = `${keys.length - 25} more keys`;
  return out;
}
