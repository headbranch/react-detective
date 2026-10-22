// Devtools-style rendering of live values (already serialized by fiber.ts):
// colored primitives, `ƒ name()` for functions, short previews for objects and
// arrays, and an expandable key/value view.

import { esc } from "./markdown";

const span = (cls: string, text: string) => `<span class="${cls}">${esc(text)}</span>`;

/** Placeholders produced by fiber.ts's serializer, e.g. "[Function onSelect]", and evaluate.ts's "[Code …]". */
function special(s: string): string | null {
  // Code that couldn't be worked out to a value (a hook argument like `compute(id)`): shown as written.
  let m = s.match(/^\[Code (.*)\]$/s);
  if (m) return span("v-code", m[1].length > 40 ? `${m[1].slice(0, 39)}…` : m[1]);
  m = s.match(/^\[Function (.*)\]$/);
  if (m) return span("v-fn", `ƒ ${m[1] === "anonymous" ? "" : m[1]}()`);
  m = s.match(/^\[React element <(.+)>\]$/);
  if (m) return span("v-el", `<${m[1]} />`);
  if (/^\[React element\]$/.test(s)) return span("v-el", "<element />");
  if (/^\[(children|Circular|Object|Array\(\d+\)|DOM <[^>]+>)\]$/.test(s)) return span("v-meta", s.slice(1, -1));
  return null;
}

/** One-line preview. `depth` > 0 collapses nested objects to {…} / Array(n). */
export function preview(v: unknown, depth = 0): string {
  if (v === null) return span("v-null", "null");
  if (v === undefined) return span("v-null", "undefined");
  if (typeof v === "boolean") return span("v-bool", String(v));
  if (typeof v === "number") return span("v-num", String(v));
  if (typeof v === "string") {
    const s = special(v);
    if (s) return s;
    return span("v-str", `"${v.length > 40 ? v.slice(0, 39) + "…" : v}"`);
  }
  if (Array.isArray(v)) {
    if (depth > 0) return span("v-meta", `Array(${v.length})`);
    const shown = v.slice(0, 3).map((x) => preview(x, depth + 1));
    return `<span class="v-meta">(${v.length})</span> [${shown.join(", ")}${v.length > 3 ? ", …" : ""}]`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (depth > 0) return span("v-meta", entries.length ? "{…}" : "{}");
    const shown = entries.slice(0, 3).map(([k, x]) => `${span("v-key", k)}: ${preview(x, depth + 1)}`);
    return `{ ${shown.join(", ")}${entries.length > 3 ? `, ${span("v-meta", `+${entries.length - 3}`)}` : ""} }`;
  }
  return span("v-meta", String(v));
}

export function isExpandable(v: unknown): boolean {
  return v !== null && typeof v === "object" && Object.keys(v as object).length > 0;
}

/**
 * Expanded view, like the browser console: one row per key (or index), and every
 * nested object or array is itself expandable, as deep as the captured value goes.
 */
export function tree(v: unknown, depth = 0): string {
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  return `<div class="vt">${entries
    .map(([k, x]) => {
      const row = `<span class="vt-tw"></span><span class="v-key">${esc(k)}</span><span class="vt-val">${preview(x)}</span>`;
      return isExpandable(x) && depth < 8
        ? `<details class="vt-node"><summary class="vt-row">${row}</summary>${tree(x, depth + 1)}</details>`
        : `<div class="vt-row">${row}</div>`;
    })
    .join("")}</div>`;
}

/** A value box: preview on one line, click to expand objects into rows. */
export function valueBox(v: unknown, label?: string): string {
  const expandable = isExpandable(v);
  return `<div class="val ${expandable ? "expandable" : ""}" ${expandable ? 'title="Click to expand"' : ""}>
    <div class="val-line">
      ${label ? `<span class="val-label">${esc(label)}</span>` : ""}
      <span class="val-preview">${preview(v)}</span>
      ${expandable ? '<span class="val-chevron">▸</span>' : ""}
    </div>
    ${expandable ? `<div class="val-tree">${tree(v)}</div>` : ""}
  </div>`;
}
