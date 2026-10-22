export const STYLES = /* css */ `
:host { all: initial; }
* { box-sizing: border-box; }
.box, .tip, .launcher, .panel, .type-pop {
  /* Monotone: neutral greys with a muted violet-grey accent, so the outline's kind colours are the only real colour. */
  --accent: #5d5873;
  --bg: #ffffff; --fg: #33303d; --muted: #6f6c7c; --line: #e6e6e9; --soft: #f5f5f6; --code: #efeff1;
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .box, .tip, .launcher, .panel, .type-pop {
    --accent: #b1adc4;
    --bg: #18181b; --fg: #dddbe6; --muted: #9a97a8; --line: #2d2d31; --soft: #212124; --code: #28282c;
  }
}
[hidden] { display: none !important; }

.box {
  position: fixed; top: 0; left: 0;
  border: 2px solid var(--accent); border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  transition: transform 60ms ease-out, width 60ms ease-out, height 60ms ease-out;
}
.box.selected { background: none; border-style: dashed; }

.tip {
  position: fixed; top: 0; left: 0; max-width: min(560px, calc(100vw - 8px));
  display: flex; gap: 8px; align-items: baseline;
  padding: 4px 8px; border-radius: 6px;
  background: var(--fg); color: var(--bg); white-space: nowrap; overflow: hidden;
  box-shadow: 0 4px 16px rgb(0 0 0 / .25);
}
.tip .name { font: 600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.tip .path { font-size: 11px; opacity: .75; overflow: hidden; text-overflow: ellipsis; }

.launcher {
  pointer-events: auto; position: fixed; touch-action: none; user-select: none;
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--bg); color: var(--muted); cursor: pointer;
  box-shadow: 0 2px 10px rgb(0 0 0 / .12); opacity: .75; transition: opacity .15s;
}
/* Drag it anywhere; it snaps to the nearest corner (remembered per browser). */
.launcher[data-corner="br"] { right: 12px; bottom: 12px; }
.launcher[data-corner="bl"] { left: 12px; bottom: 12px; }
.launcher[data-corner="tr"] { right: 12px; top: 12px; }
.launcher[data-corner="tl"] { left: 12px; top: 12px; }
.launcher.dragging { cursor: grabbing; opacity: 1; box-shadow: 0 8px 24px rgb(0 0 0 / .25); }
.launcher:hover, .launcher.active { opacity: 1; color: var(--fg); }
.launcher .hat { width: 18px; height: 18px; flex-shrink: 0; transform-origin: 30% 80%; transition: transform .25s cubic-bezier(.3, 1.6, .5, 1); }
.launcher .hat .band { fill: var(--bg); }
.launcher:hover .hat { transform: rotate(-14deg) translateY(-1px); }  /* tips the hat */
.launcher.active .hat { color: var(--accent); animation: sleuth 2.2s ease-in-out infinite; }
@keyframes sleuth { 0%, 100% { transform: rotate(0); } 30% { transform: rotate(-8deg) translateX(-1px); } 60% { transform: rotate(6deg) translateX(1px); } }
@media (prefers-reduced-motion: reduce) { .launcher .hat { transition: none; animation: none !important; } }
/* While inspecting, the label turns into a prompt and the key hint shows how to stop. */
.launcher .on, .launcher.active .off { display: none; }
.launcher.active .on { display: inline; }
.launcher kbd { font: 11px ui-monospace, monospace; padding: 0 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--soft); }

.panel {
  pointer-events: auto; position: fixed; top: 0; right: 0; bottom: 0;
  width: min(460px, 100vw); display: flex; flex-direction: column;
  background: var(--bg); border-left: 1px solid var(--line);
  box-shadow: -8px 0 32px rgb(0 0 0 / .12);
}
header { position: relative; padding: 12px 44px 12px 16px; border-bottom: 1px solid var(--line); }
.title { display: flex; align-items: center; gap: 4px; min-width: 0; }
.title-link { display: inline-flex; align-items: center; gap: 7px; min-width: 0; padding: 3px 10px; border-radius: 7px; border: 1px solid var(--line); background: var(--soft); text-decoration: none; cursor: pointer; transition: background .12s, border-color .12s; }
.title-link:hover { background: var(--code); border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
.title-goto { font-size: 12px; color: var(--muted); }
.title-link:hover .title-goto { color: var(--accent); }
header .close { position: absolute; top: 8px; right: 8px; }
h1 { margin: 0; font: 600 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--fg); overflow-wrap: anywhere; }
button { font: inherit; color: inherit; }
.icon { width: 28px; height: 28px; border: 0; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; font-size: 15px; }
.icon:hover { background: var(--soft); color: var(--fg); }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 1px; margin: -2px 0 4px -4px; font: 11px ui-monospace, monospace; color: var(--muted); }
.crumbs button { border: 0; background: none; padding: 1px 4px; border-radius: 4px; cursor: pointer; color: var(--muted); font: inherit; }
.crumbs button:hover { background: var(--soft); color: var(--fg); }
.crumbs .sep { opacity: .45; }

.meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; margin-top: 4px; font-size: 11.5px; color: var(--muted); }
.meta-row:not(:has(> :not([hidden]))) { display: none; }
.meta-row > :not([hidden]) ~ :not([hidden])::before { content: "·"; margin: 0 7px; opacity: .6; }
.status, .gitinfo { cursor: default; white-space: nowrap; }
.gitinfo .tag { margin-left: 4px; }

.body { flex: 1; overflow-y: auto; padding: 4px 16px 16px; }
.progress { display: flex; align-items: center; gap: 10px; margin: 14px 0 6px; color: var(--muted); }
/* Busy indicator: a magnifying glass searching about. */
.spinner { position: relative; flex-shrink: 0; width: 16px; height: 16px; animation: search 1.6s ease-in-out infinite; }
.spinner::before { content: ""; position: absolute; left: 0; top: 0; width: 11px; height: 11px; border: 2px solid var(--accent); border-radius: 50%; }
.spinner::after { content: ""; position: absolute; left: 10px; top: 9px; width: 2.5px; height: 7px; border-radius: 1px; background: var(--accent); transform: rotate(-45deg); transform-origin: top center; }
@keyframes search { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(3px, -2px); } 50% { transform: translate(0, -4px); } 75% { transform: translate(-3px, -1px); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
.steps { list-style: none; margin: 0; padding: 0 0 0 26px; font: 12px ui-monospace, monospace; color: var(--muted); }
.steps li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .55; }
.steps li:last-child { opacity: 1; }

.md h2, .md h3, .md h4 { margin: 18px 0 6px; font-size: 13px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.md h2:first-child { margin-top: 14px; }
.md p, .md ul, .md ol { margin: 0 0 8px; }
.md ul, .md ol { padding-left: 20px; }
.md li { margin: 2px 0; }
.md code, .md pre { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.md code { padding: 1px 4px; border-radius: 4px; background: var(--code); overflow-wrap: anywhere; }
.md pre { padding: 10px; border-radius: 6px; background: var(--code); overflow-x: auto; }
.md pre code { padding: 0; background: none; }
/* Web links anywhere in the panel; without this they'd get the browser's dark blue, unreadable in dark mode. */
a[href] { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
a[href]:hover { color: var(--fg); }
.banner a[href], .error a[href] { color: inherit; font-weight: 600; }
.md a { color: var(--accent); }
.md a.src { cursor: pointer; text-decoration: none; }
.md a.src code { color: var(--accent); }
.md a.src:hover code { text-decoration: underline; }
.meta { margin-top: 12px; font-size: 11px; color: var(--muted); }
.link { border: 0; padding: 0; background: none; color: var(--accent); cursor: pointer; font-size: inherit; }
.error { margin: 14px 0; padding: 10px 12px; border-radius: 6px; background: color-mix(in srgb, #e5484d 12%, var(--bg)); color: #c62a2f; overflow-wrap: anywhere; }
@media (prefers-color-scheme: dark) {
  .error { color: #ff9592; }
}

/* ---------- explanation card ---------- */
.card code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 0 3px; border-radius: 3px; background: var(--code); }
a.ref { font: 11px ui-monospace, monospace; color: var(--muted); text-decoration: none; cursor: pointer; white-space: nowrap; }
a.ref:hover { color: var(--accent); text-decoration: underline; }

.sec { border-top: 1px solid var(--line); }
.sec:first-child { border-top: 0; }
.sec > summary { display: flex; align-items: center; gap: 6px; padding: 12px 0 8px; cursor: pointer; list-style: none; user-select: none; }
.sec > summary::-webkit-details-marker { display: none; }
.sec > summary::before { content: "▸"; font-size: 10px; color: var(--muted); transition: transform .15s; }
.sec[open] > summary::before { transform: rotate(90deg); }
.sec-title { font-size: 11.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.count { min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--soft); font-size: 11px; text-align: center; color: var(--muted); }
.expand-all { margin-left: auto; font-size: 11px; }
.sec-body { padding-bottom: 10px; }

.summary { margin: 0; font-size: 14px; line-height: 1.55; }
.summary.pending { font-size: 12.5px; color: var(--muted); font-style: italic; }
/* Read-from-source outline while the AI writes: explanations are still empty, so items open to just their facts. */
.card.skeleton .ol-expl:not(:has(.ol-facts, .ol-now, .ol-note)) { display: none !important; }

/* live values, devtools-style */
.v-str { color: #c2410c; }
.v-num { color: #2563eb; }
.v-bool { color: #9333ea; }
.v-null { color: var(--muted); font-style: italic; }
.v-fn { color: #a24d9c; font-style: italic; }
.v-el { color: #0d8a7c; }
.v-meta { color: var(--muted); }
/* Code that couldn't be worked out to a value: as written, muted and italic so it doesn't read as a string. */
.v-code { color: var(--muted); font-style: italic; }
.v-key { color: var(--muted); }
@media (prefers-color-scheme: dark) {
  .v-str { color: #f0a46b; }
  .v-num { color: #8ab4ff; }
  .v-bool { color: #d2a8ff; }
  .v-fn { color: #d7a0d3; }
  .v-el { color: #6ad3c2; }
}

.val { margin-top: 6px; border-radius: 6px; background: var(--soft); border: 1px solid var(--line); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.val.expandable { cursor: pointer; }
.val.expandable:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
.val-line { display: flex; align-items: baseline; gap: 8px; padding: 3px 8px; min-width: 0; }
/* Labels take the colour of what they belong to (--kc: an outline item's group colour, else the accent).
   Live values ("Current") get a filled, gently pulsing dot. */
.val-label { flex-shrink: 0; font: 700 9.5px ui-sans-serif, system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--kc, var(--accent)); }
.val-label::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: currentColor; vertical-align: 0; animation: live 2.4s ease-in-out infinite; }
.fact .val-label::before { content: none; }
@keyframes live { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .val-label::before { animation: none; } }
.val-preview { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.val-chevron { flex-shrink: 0; font-size: 10px; color: var(--muted); transition: transform .15s; }
.val.open .val-chevron { transform: rotate(90deg); }
.val-tree { display: none; padding: 2px 8px 6px; border-top: 1px solid var(--line); cursor: text; }
.val.open .val-tree { display: block; }
.vt .vt { padding-left: 14px; }
.vt-row { display: flex; align-items: baseline; gap: 4px; padding: 1px 0; min-width: 0; list-style: none; }
.vt-row::-webkit-details-marker { display: none; }
summary.vt-row { cursor: pointer; border-radius: 3px; }
summary.vt-row:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.vt-tw { flex-shrink: 0; width: 10px; font-size: 9px; color: var(--muted); }
summary.vt-row .vt-tw::before { content: "▸"; display: inline-block; transition: transform .12s; }
.vt-node[open] > summary.vt-row .vt-tw::before { transform: rotate(90deg); }
.vt-row > .v-key { flex-shrink: 0; }
.vt-row > .v-key::after { content: ":"; margin-right: 4px; }
.vt-val { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* props: docs-style rows */
.prop { display: grid; grid-template-columns: minmax(90px, 30%) 1fr; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }
.prop:first-child { border-top: 0; padding-top: 2px; }
.prop-head { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; }
.card .prop-name { padding: 0; background: none; font-weight: 650; color: var(--fg); overflow-wrap: anywhere; }
.card .prop-type { max-width: 100%; padding: 1px 6px; border-radius: 4px; font-size: 11px; color: var(--muted); background: var(--code); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.prop-body { min-width: 0; }
.prop-desc { font-size: 12.5px; }
.prop-desc + .val { margin-top: 6px; }
.prop-body > .val:first-child { margin-top: 0; }

/* outline tree, in the spirit of VS Code's outline view */
.ol-group + .ol-group { margin-top: 10px; }
.ol-group-head { display: flex; align-items: center; gap: 7px; padding: 4px 6px 3px; border-radius: 4px; cursor: pointer; list-style: none; user-select: none; }
.ol-group-head::-webkit-details-marker { display: none; }
.ol-group-head:hover { background: var(--soft); }
.ol-group-head::before { content: "▸"; width: 8px; font-size: 9px; color: var(--muted); transition: transform .12s; }
.ol-group[open] > .ol-group-head::before { transform: rotate(90deg); }
.ol-group-title { font-size: 12px; font-weight: 650; }
.ol-group-hint { flex: 1; }
.ol-hint-label { font: 10.5px ui-monospace, monospace; color: var(--muted); padding: 0 5px; border-radius: 3px; border: 1px dashed var(--line); }

/* custom types: linked in code-like text, definition in a hover popover */
.type-ref { color: inherit; text-decoration: underline dotted; text-decoration-color: color-mix(in srgb, var(--accent) 70%, transparent); text-underline-offset: 2px; cursor: pointer; }
.type-ref:hover { color: var(--accent); text-decoration-style: solid; }
.type-pop { pointer-events: auto; position: fixed; z-index: 2; max-width: min(420px, calc(100vw - 16px)); border-radius: 8px; border: 1px solid var(--line); background: var(--bg); box-shadow: 0 8px 28px rgb(0 0 0 / .28); overflow: hidden; }
.tp-head { display: flex; align-items: baseline; gap: 7px; padding: 7px 10px; border-bottom: 1px solid var(--line); background: var(--soft); }
.tp-kind { font: 10px ui-monospace, monospace; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.tp-name { flex: 1; font: 600 12.5px ui-monospace, monospace; color: var(--fg); }
.tp-file { font: 11px ui-monospace, monospace; color: var(--muted); text-decoration: none; cursor: pointer; }
.tp-file:hover { color: var(--accent); text-decoration: underline; }
.tp-code { margin: 0; padding: 8px 10px; max-height: 320px; overflow: auto; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
/* Symbol references: underlined in their outline kind colour; hover previews the definition, click jumps to it. */
.kc-prop { --kc: var(--accent); }
/* Symbol references read as tinted chips in their outline kind colour, so names stand out when skimming.
   (Text is mixed toward the foreground so lighter kind colours stay readable.) */
.panel .sym-ref, .type-pop .sym-ref {
  cursor: pointer; padding: 0 4px; border-radius: 4px; white-space: nowrap;
  font: 500 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: color-mix(in srgb, var(--kc, var(--accent)) 78%, var(--fg));
  background: color-mix(in srgb, var(--kc, var(--accent)) 15%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--kc, var(--accent)) 22%, transparent);
  transition: background .12s, box-shadow .12s;
}
.panel .sym-ref:hover, .type-pop .sym-ref:hover {
  background: color-mix(in srgb, var(--kc, var(--accent)) 26%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--kc, var(--accent)) 55%, transparent);
}
.sp-body { max-height: 340px; overflow: auto; padding: 8px 10px 10px; font-size: 12.5px; }
.sp-body .ol-facts { margin-top: 8px; }
.sp-body .val { background: var(--bg); }
.sp-body .val-label { min-width: 64px; }
.sp-type { max-width: 50%; }
.tp-head .ol-icon { align-self: center; }
.tp-head .tp-file { margin-left: auto; }
/* Go to definition: briefly highlight where we landed. */
.ol-node.flash > .ol-row, .prop.flash { animation: flash 1.4s ease-out; }
@keyframes flash { 0%, 30% { background: color-mix(in srgb, var(--kc, var(--accent)) 26%, transparent); } }
@media (prefers-reduced-motion: reduce) { .ol-node.flash > .ol-row, .prop.flash { animation-duration: .01s; } }
.ol-group .outline { margin-left: 15px; padding-left: 8px; border-left: 1px solid var(--line); }
.ol-tag { flex-shrink: 0; font: 10px ui-monospace, monospace; padding: 0 4px; border-radius: 3px; border: 1px solid var(--line); color: var(--muted); }
.ol-now { margin-top: 6px; }
.outline { list-style: none; margin: 0; padding: 0; }
.outline .outline { margin-left: 11px; padding-left: 10px; border-left: 1px solid var(--line); }
.ol-row { display: flex; align-items: center; gap: 7px; padding: 3px 6px; border-radius: 4px; cursor: pointer; min-width: 0; }
.ol-row:hover { background: var(--soft); }
.ol-node.open > .ol-row { background: var(--soft); }
.ol-icon { flex-shrink: 0; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 4px; font: 700 10px ui-monospace, monospace; }
.ol-icon svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.ol-name { flex-shrink: 0; font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ol-type { flex-shrink: 1; min-width: 0; max-width: 45%; padding: 0 6px; border-radius: 4px; background: var(--code); font: 11px/1.6 ui-monospace, monospace; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ol-when { flex-shrink: 1; min-width: 0; padding: 0 6px; border-radius: 4px; border: 1px dashed var(--line); font: 11px/1.6 ui-monospace, monospace; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ol-goto { margin-left: auto; }
/* Long types are cut off in the row; opening the item shows the whole thing in place. */
.ol-node.open > .ol-row { align-items: flex-start; flex-wrap: wrap; }
.ol-node.open > .ol-row .ol-type, .ol-node.open > .ol-row .ol-when { max-width: none; white-space: normal; overflow-wrap: anywhere; }
/* Secondary facts (initial value, returns, cleanup…) as labelled boxes, like "Current". */
.ol-facts { display: grid; gap: 5px; margin-top: 10px; }
.ol-facts + .ol-now .val:first-child { margin-top: 5px; }
.fact { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px; border-radius: 6px; background: var(--bg); border: 1px solid var(--line); }
.fact-val { min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.fact-val code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 0; background: none; }
.ol-expl .val-label { min-width: 64px; }
.ol-expl .val { background: var(--bg); }
.ol-note { margin-top: 6px; font-size: 11.5px; color: var(--muted); font-style: italic; }
.ol-goto { flex-shrink: 0; font: 10.5px ui-monospace, monospace; color: var(--muted); text-decoration: none; opacity: 0; padding: 0 2px; }
.ol-row:hover .ol-goto, .ol-node.open > .ol-row .ol-goto { opacity: 1; }
.ol-goto:hover { color: var(--accent); text-decoration: underline; }
.ol-goto::before { content: "L"; opacity: .6; }
.ol-expl { display: none; margin: 2px 0 6px 31px; padding: 6px 10px; border-left: 2px solid var(--kc, var(--accent)); font-size: 12.5px; background: var(--soft); border-radius: 0 4px 4px 0; }
.ol-node.open > .ol-expl { display: block; }
/* One colour per kind, spread around the colour wheel so no two groups look alike.
   It drives the group icon, the item's labels and the expanded panel's edge. */
.kc-state, .k-state { --kc: #9d5fc9; }
.kc-callback, .kc-function, .k-callback, .k-function { --kc: #c2418f; }
.kc-render, .k-render { --kc: #d0453f; }
.kc-effect, .k-effect { --kc: #d27a12; }
.kc-hook, .k-hook { --kc: #a68f0b; }
.kc-ref, .k-ref { --kc: #2e9a52; }
.kc-context, .kc-store, .k-context, .k-store { --kc: #12918e; }
.kc-derived, .kc-memo, .k-derived, .k-memo { --kc: #3a7fc4; }
.kc-constant, .kc-other, .k-constant, .k-other { --kc: var(--muted); }
.ol-icon[class*="k-"] { background: color-mix(in srgb, var(--kc) 20%, transparent); color: var(--kc); }
/* Brighter in dark mode so the kinds stay vivid against the dark panel. */
@media (prefers-color-scheme: dark) {
  .kc-state, .k-state { --kc: #c495f2; }
  .kc-callback, .kc-function, .k-callback, .k-function { --kc: #f07cc0; }
  .kc-render, .k-render { --kc: #ff7b72; }
  .kc-effect, .k-effect { --kc: #ffab4a; }
  .kc-hook, .k-hook { --kc: #e8cd45; }
  .kc-ref, .k-ref { --kc: #5fd987; }
  .kc-context, .kc-store, .k-context, .k-store { --kc: #44d4cd; }
  .kc-derived, .kc-memo, .k-derived, .k-memo { --kc: #74b4ff; }
  .ol-icon[class*="k-"] { background: color-mix(in srgb, var(--kc) 24%, transparent); }
}
.k-render { font-size: 9px; }

/* Used in: like the props rows (these are props, as a parent passes them), one block per place. */
.used { padding: 10px 0; border-top: 1px solid var(--line); }
.used:first-child { border-top: 0; padding-top: 2px; }
.used-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 12.5px; }
.used-head a.ref { color: var(--fg); font: 650 12px ui-monospace, monospace; padding: 1px 6px; border: 1px solid var(--line); border-radius: 4px; }
.used-head a.ref:hover { color: var(--accent); text-decoration: none; border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
.used-in { color: var(--muted); }
.used-in code { background: none; padding: 0; }
.used-this { margin-left: auto; font-size: 11px; color: var(--accent); }
.used-this::before { content: "● "; font-size: 8px; vertical-align: 1px; }
.used-props { display: grid; grid-template-columns: minmax(90px, 30%) 1fr; gap: 6px 12px; margin-top: 8px; align-items: baseline; }
.used-props .prop-name { font-weight: normal; }
.used-val { min-width: 0; display: flex; }
.card a.used-var { text-decoration: none; cursor: pointer; }
.card a.used-var:hover { color: var(--accent); }

.timeline { list-style: none; margin: 4px 0 0 5px; padding: 0 0 0 14px; border-left: 2px solid var(--line); }
.timeline li { position: relative; margin: 0 0 10px; }
.timeline li::before { content: ""; position: absolute; left: -21px; top: 4px; width: 8px; height: 8px; border-radius: 50%; background: var(--bg); border: 2px solid var(--accent); }
.tl-meta { font-size: 11px; color: var(--muted); }
.tl-why { font-size: 12.5px; }

.banner { margin: 14px 0 0; padding: 8px 10px; border-radius: 6px; font-size: 12px; background: color-mix(in srgb, #f5a524 16%, var(--bg)); color: var(--fg); overflow-wrap: anywhere; }
.banner code { font: 11px ui-monospace, monospace; }
.stale { opacity: .45; pointer-events: none; }
.diffs { margin-top: 6px; }
.diffs summary { cursor: pointer; color: var(--accent); }
.difffile { margin: 8px 0 2px; font: 600 11px ui-monospace, monospace; }
pre.diff { margin: 0; padding: 6px 0; max-height: 240px; overflow: auto; border-radius: 4px; background: var(--bg); font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre.diff span { display: block; padding: 0 8px; white-space: pre; }
pre.diff .add { background: color-mix(in srgb, #30a46c 18%, transparent); }
pre.diff .del { background: color-mix(in srgb, #e5484d 18%, transparent); }
pre.diff .hunk { color: var(--muted); }

.meta code { font: 11px ui-monospace, monospace; }

.history { margin-top: 4px; padding-top: 12px; border-top: 1px solid var(--line); }
.history h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font-size: 11.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.qa { border-bottom: 1px solid var(--line); }
.qa > summary { padding: 7px 0; cursor: pointer; font-weight: 550; }
.qa[open] > summary { color: var(--accent); }
.qa-body { padding: 0 0 8px 14px; }
.qa-body .progress { margin-top: 2px; }
.tag { font-size: 10px; font-weight: 600; text-transform: uppercase; padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, #f5a524 22%, var(--bg)); }


.ask { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--line); background: var(--soft); }
.ask input { flex: 1; min-width: 0; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; outline: none; }
.ask input:focus { border-color: var(--accent); }
.ask button { padding: 0 12px; border: 0; border-radius: 6px; background: var(--fg); color: var(--bg); font-weight: 600; cursor: pointer; }
.ask button:hover { background: var(--accent); }
`;
