// Names of the component's own props, state, functions, etc. mentioned in the panel
// (`focused`, `clear()`, `user.name`) become references, like in an editor: hover shows a
// preview of the definition from the outline / props sections, click jumps to it.
// Everything is read from the rendered card, so it works for cached explanations too.

import { esc } from "./markdown";

/** Identifier, optionally followed by a call or a property chain: `x`, `x()`, `x(a, b)`, `x.y.z`. */
const REF = /^([A-Za-z_$][\w$]*)(?:\.[\w$]+)*(?:\(.*\))?$/s;

/** Definitions in the card, by name (first wins: the props section comes before the outline). */
function definitions(root: Element): Map<string, HTMLElement> {
  const defs = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-def]")) {
    if (!defs.has(el.dataset.def!)) defs.set(el.dataset.def!, el);
  }
  return defs;
}

export function findDefinition(root: Element, name: string): HTMLElement | null {
  return definitions(root).get(name) ?? null;
}

/** Where references are never made: links, code blocks, the definition rows' own names and types, values, call sites' props. */
const SKIP = "a, pre, .ol-row, .prop-head, .tp-head, .val, .sym-ref, .used-list";

/**
 * Names that can only be code when they appear in prose: camelCase (`inputRef`), snake/SCREAMING
 * case (`MIN_QUERY`) or containing `$`. Plain words like "value" or "clear" are only linked
 * inside inline code, since in prose they're usually just English.
 */
const CODE_LIKE = /^(?:[a-z][a-z0-9]*[A-Z][\w$]*|[A-Za-z$][\w$]*[_$][\w$]*)$/;

const kindOf = (def: Element) => [...def.classList].find((c) => c.startsWith("kc-")) ?? "kc-prop";

/** Marks mentions of known definitions (inline code, plus unmistakable names in prose) as references. Safe to call repeatedly. */
export function linkSymbols(root: Element) {
  const defs = definitions(root);
  if (!defs.size) return;
  for (const code of root.querySelectorAll<HTMLElement>("code:not(.sym-ref)")) {
    if (code.closest(SKIP) || code.querySelector("a")) continue;
    const name = code.textContent!.trim().match(REF)?.[1];
    const def = name ? defs.get(name) : undefined;
    if (!def || code.closest<HTMLElement>("[data-def]") === def) continue; // no self-references
    code.classList.add("sym-ref", kindOf(def));
    code.dataset.sym = name;
  }

  const prose = [...defs.keys()].filter((n) => CODE_LIKE.test(n));
  if (!prose.length) return;
  const re = new RegExp(`(?<![\\w$.])(${prose.map((n) => n.replace(/\$/g, "\\$")).join("|")})(?![\\w$])`, "g");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const parent = n.parentElement;
    if (parent && !parent.closest(`${SKIP}, code, summary, button, .steps`)) nodes.push(n);
  }
  for (const node of nodes) {
    re.lastIndex = 0;
    if (!re.test(node.data)) continue;
    const own = node.parentElement!.closest<HTMLElement>("[data-def]");
    const span = document.createElement("span");
    span.innerHTML = esc(node.data).replace(re, (name) => {
      const def = defs.get(name)!;
      return def === own ? name : `<span class="sym-ref ${kindOf(def)}" data-sym="${esc(name)}">${name}</span>`;
    });
    node.replaceWith(...span.childNodes);
  }
}

/** Popover body for a definition: kind, name, type and line, then the explanation and its values. */
export function symbolPopover(def: HTMLElement): string {
  if (def.classList.contains("prop")) {
    const type = def.querySelector(".prop-type")?.textContent ?? "";
    const desc = def.querySelector(".prop-desc")?.innerHTML ?? "";
    const value = def.querySelector(".prop-body > .val")?.outerHTML ?? "";
    return `<div class="tp-head">
        <span class="tp-kind">prop</span><span class="tp-name">${esc(def.dataset.def!)}</span>
        ${type ? `<span class="ol-type sp-type">${esc(type)}</span>` : ""}
      </div>
      <div class="sp-body">${desc}${value}</div>`;
  }
  const row = def.querySelector(":scope > .ol-row")!;
  const icon = row.querySelector(".ol-icon")?.outerHTML ?? "";
  const pill = row.querySelector(".ol-type, .ol-when");
  const goto = row.querySelector<HTMLElement>(".ol-goto");
  // The explanation's prose, then its labelled boxes (Initial, Returns, Current…), without the "not stored" note.
  const expl = def.querySelector(":scope > .ol-expl")!.cloneNode(true) as HTMLElement;
  expl.querySelector(".ol-note")?.remove();
  const boxes = [...expl.querySelectorAll(".ol-facts, .ol-now")].map((b) => (b.remove(), b.outerHTML)).join("");
  return `<div class="sp ${[...def.classList].filter((c) => c.startsWith("kc-")).join(" ")}">
      <div class="tp-head">
        ${icon}<span class="tp-name">${esc(def.dataset.def!)}</span>
        ${pill ? `<span class="ol-type sp-type">${esc(pill.textContent!)}</span>` : ""}
        ${goto ? `<a class="src tp-file" data-file="${esc(goto.dataset.file!)}" data-line="${goto.dataset.line}" data-col="1" title="Open in editor">L${goto.dataset.line} ↗</a>` : ""}
      </div>
      <div class="sp-body">${expl.innerHTML.trim()}${boxes}</div>
    </div>`;
}

/** Go to definition: open its section/group, expand it, scroll to it and flash it. */
export function revealDefinition(def: HTMLElement) {
  for (let d = def.closest("details"); d; d = d.parentElement!.closest("details")) (d as HTMLDetailsElement).open = true;
  if (def.classList.contains("ol-node")) def.classList.add("open");
  def.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  def.classList.remove("flash");
  void def.offsetWidth; // restart the animation
  def.classList.add("flash");
}
