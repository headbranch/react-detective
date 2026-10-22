// Custom types mentioned in the panel (prop types, outline hints, inline code) become
// links: hover shows the definition (read from source by the server), click opens it.

import type { TypeDef } from "../server/types";
import { esc } from "./markdown";

export type { TypeDef };

/** Where type names get linked: code-like text only, never prose. */
const TARGETS = ".prop-type, .ol-type, code";

/** Wraps every known type name inside `root`'s code-like text in a link. Safe to call repeatedly. */
export function linkTypes(root: Element, types: Map<string, TypeDef>) {
  if (!types.size) return;
  const re = new RegExp(`\\b(${[...types.keys()].map((n) => n.replace(/[$]/g, "\\$")).join("|")})\\b`, "g");
  for (const el of root.querySelectorAll(TARGETS)) {
    if (el.closest("a, pre, .tp-code")) continue; // already a link, or a code block
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest(".type-ref")) nodes.push(n as Text);
    for (const node of nodes) {
      const text = node.data;
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      const span = document.createElement("span");
      span.innerHTML = esc(text).replace(re, (name) => typeLink(types.get(name)!));
      node.replaceWith(...span.childNodes);
    }
  }
}

function typeLink(t: TypeDef): string {
  return `<a class="src type-ref" data-type="${esc(t.name)}" data-file="${esc(t.file)}" data-line="${t.line}" data-col="1">${esc(t.name)}</a>`;
}

/** Popover body: the declaration, with nested custom types linked too. */
export function typePopover(t: TypeDef, types: Map<string, TypeDef>): string {
  const re = new RegExp(`\\b(${[...types.keys()].join("|")})\\b`, "g");
  const code = esc(t.code).replace(re, (name) => (name === t.name ? name : typeLink(types.get(name)!)));
  return `<div class="tp-head">
      <span class="tp-kind">${esc(t.kind)}</span><span class="tp-name">${esc(t.name)}</span>
      <a class="src tp-file" data-file="${esc(t.file)}" data-line="${t.line}" data-col="1" title="Open in editor">${esc(t.file.split("/").pop()!)}:${t.line} ↗</a>
    </div>
    <pre class="tp-code">${code}</pre>`;
}
