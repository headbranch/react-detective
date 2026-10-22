import { readLiveData } from "./fiber";
import { renderCard } from "./card";
import { esc, renderMarkdown } from "./markdown";
import { linkTypes, typePopover, type TypeDef } from "./types";
import { findDefinition, linkSymbols, revealDefinition, symbolPopover } from "./symbols";
import { STYLES } from "./styles";

const LOC_ATTR = "data-rd-loc";
const COMP_ATTR = "data-rd-comp";

export interface DetectiveClientOptions {
  /** Base URL of the explain server, e.g. `/__detective` (Vite) or `http://127.0.0.1:5899/__detective`. */
  endpoint: string;
  /** Show the small launcher pill in the corner. Default true. */
  showLauncher?: boolean;
}

interface Target {
  comp: string;
  file: string;
  line: number;
  column: number;
  /** Outermost DOM element belonging to this component instance. */
  root: Element;
  /** The exact element under the pointer. */
  el: Element;
}

interface Loc {
  file: string;
  line: number;
  column: number;
}

function parseLoc(el: Element): Loc | null {
  const raw = el.getAttribute(LOC_ATTR);
  const m = raw?.match(/^(.*):(\d+):(\d+)$/);
  return m ? { file: m[1], line: +m[2], column: +m[3] } : null;
}

/** Finds the component instance an element belongs to and its outermost DOM node. */
function resolveTarget(start: Element | null): Target | null {
  const el = start?.closest(`[${COMP_ATTR}]`);
  if (!el) return null;
  const comp = el.getAttribute(COMP_ATTR)!;
  const file = parseLoc(el)?.file;
  let root: Element = el;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.getAttribute(COMP_ATTR) !== comp || parseLoc(p)?.file !== file) break;
    root = p;
  }
  const loc = parseLoc(root);
  if (!loc) return null;
  return { comp, ...loc, root, el: start! };
}

/** Component names enclosing the target in the page, outermost first. */
function componentChain(t: Target): Target[] {
  const chain: Target[] = [t];
  let cur: Element | null = t.root.parentElement;
  while (cur) {
    const parent = resolveTarget(cur);
    if (!parent) break;
    chain.unshift(parent);
    cur = parent.root.parentElement;
  }
  return chain;
}

/** "claude-sonnet-5-5" → "Sonnet 5.5"; anything unrecognised is shown as is. */
function modelName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}` : id;
}

export function init(options: DetectiveClientOptions): () => void {
  const w = window as any;
  if (w.__reactDetective) return w.__reactDetective;

  const endpoint = options.endpoint.replace(/\/$/, "");
  const host = document.createElement("react-detective");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${STYLES}</style>
    <div class="box" hidden></div>
    <div class="box selected" hidden></div>
    <div class="tip" hidden></div>
    <button class="launcher" title="React Detective: press Alt (or click here) to inspect, then click any component. Esc to stop.">
      <svg class="hat" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M1.5 16.6c2.7 1.8 6.4 2.6 10.5 2.6s7.8-.8 10.5-2.6c-1.5-.5-3-.8-4.4-.9l-1.3-7.4c-.3-1.7-1.4-2.5-2.6-2.1L12 7l-2.2-.8c-1.2-.4-2.3.4-2.6 2.1l-1.3 7.4c-1.4.1-2.9.4-4.4.9z"/>
        <path class="band" d="M6.1 13.2c3.9.9 7.9.9 11.8 0l.35 2.1c-4.1 1-8.4 1-12.5 0z"/>
      </svg>
      <span class="label"><span class="off">Detective</span><span class="on">Select a component to inspect</span></span><kbd class="off">Alt</kbd><kbd class="on" title="Press Esc to stop inspecting">Esc</kbd>
    </button>
    <aside class="panel" hidden></aside>
    <div class="type-pop" hidden></div>`;
  document.documentElement.appendChild(host);

  const $ = <T extends Element>(sel: string) => shadow.querySelector(sel) as T;
  const hoverBox = $<HTMLDivElement>(".box:not(.selected)");
  const selectedBox = $<HTMLDivElement>(".box.selected");
  const tip = $<HTMLDivElement>(".tip");
  const launcher = $<HTMLButtonElement>(".launcher");
  const panel = $<HTMLElement>(".panel");
  const pop = $<HTMLDivElement>(".type-pop");
  /** Custom type definitions known for the open panel, filled in from server responses. */
  let currentTypes = new Map<string, TypeDef>();
  if (options.showLauncher === false) launcher.hidden = true;

  let altDown = false;
  let sticky = false;
  let hovered: Target | null = null;
  let selected: Target | null = null;
  let pointer = { x: -1, y: -1 };
  let request: AbortController | null = null;
  let raf = 0;

  const inspecting = () => altDown || sticky;

  function setInspecting() {
    const on = inspecting();
    launcher.classList.toggle("active", on);
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (on) updateHover();
    else hideHover();
  }

  function place(box: HTMLDivElement, el: Element) {
    const r = el.getBoundingClientRect();
    box.hidden = false;
    box.style.transform = `translate(${r.left}px, ${r.top}px)`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    return r;
  }

  function hideHover() {
    hovered = null;
    hoverBox.hidden = true;
    tip.hidden = true;
  }

  function updateHover() {
    if (!inspecting() || pointer.x < 0) return;
    const el = document.elementFromPoint(pointer.x, pointer.y);
    const t = el && !host.contains(el) ? resolveTarget(el) : null;
    if (!t) return hideHover();
    hovered = t;
    const r = place(hoverBox, t.root);
    tip.hidden = false;
    tip.innerHTML = `<span class="name">&lt;${esc(t.comp)}&gt;</span><span class="path">${esc(t.file)}:${t.line}</span>`;
    const tr = tip.getBoundingClientRect();
    const top = r.top - tr.height - 6 >= 0 ? r.top - tr.height - 6 : Math.min(r.bottom + 6, innerHeight - tr.height - 4);
    const left = Math.max(4, Math.min(r.left, innerWidth - tr.width - 4));
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }

  function trackSelected() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (!selected || !selected.root.isConnected) {
        selectedBox.hidden = true;
        return;
      }
      place(selectedBox, selected.root);
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------- panel ----------

  function select(t: Target) {
    selected = t;
    sticky = false;
    setInspecting();
    trackSelected();
    const chain = componentChain(t);
    const live = readLiveData(t.root, t.comp);
    currentTypes = new Map();
    pop.hidden = true;

    panel.hidden = false;
    panel.innerHTML = `
      <header>
        ${
          chain.length > 1
            ? `<nav class="crumbs" title="Rendered inside these components. Click one to inspect it.">${chain
                .slice(0, -1)
                .map((c, i) => `<button data-crumb="${i}">${esc(c.comp)}</button>`)
                .join('<span class="sep">›</span>')}<span class="sep">›</span></nav>`
            : ""
        }
        <button class="icon close" title="Close (Esc)">✕</button>
        <div class="title">
          <a class="src title-link" data-file="${esc(t.file)}" data-line="${t.line}" data-col="${t.column}" title="Open ${esc(t.file)}:${t.line} in your editor">
            <h1>&lt;${esc(t.comp)}&gt;</h1><span class="title-goto">↗</span>
          </a>
          <button class="icon refresh" title="Regenerate the explanation">↻</button>
        </div>
        <div class="meta-row">
          <span class="status" hidden></span>
          <span class="gitinfo" hidden></span>
        </div>
      </header>
      <div class="body">
        <section class="explanation"></section>
        <section class="history" hidden></section>
      </div>
      <form class="ask">
        <input name="q" placeholder="Ask about &lt;${esc(t.comp)}&gt;… (e.g. when does it re-render?)" autocomplete="off" />
        <button type="submit">Ask</button>
      </form>`;

    panel.querySelector(".close")!.addEventListener("click", closePanel);
    panel.querySelector(".refresh")!.addEventListener("click", () => run(true));
    panel.querySelectorAll<HTMLButtonElement>("[data-crumb]").forEach((b) =>
      b.addEventListener("click", () => select(chain[Number(b.dataset.crumb)])),
    );
    panel.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = (e.target as HTMLFormElement).q as HTMLInputElement;
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      ask(q);
    });

    /** Questions go into the "Questions asked" list: a new entry at the bottom, or the existing one (moved to the bottom) if re-asked. */
    function ask(q: string) {
      const list = questionList();
      const key = normalizeQuestion(q);
      let entry = [...list.querySelectorAll<HTMLDetailsElement>(".qa")].find((d) => d.dataset.key === key);
      if (!entry) {
        entry = document.createElement("details");
        entry.className = "qa";
        entry.dataset.key = key;
        entry.innerHTML = `<summary>${esc(q)}</summary><div class="qa-body"></div>`;
      }
      entry.querySelector(".tag")?.remove();
      list.append(entry);
      entry.open = true;
      updateQuestionCount();
      entry.scrollIntoView({ behavior: "smooth", block: "start" });
      stream({ question: q }, entry.querySelector(".qa-body")!, false);
    }

    function questionList(): HTMLElement {
      const section = panel.querySelector<HTMLElement>(".history")!;
      if (!section.querySelector(".qa-list")) {
        section.innerHTML = `<h3>Questions asked <span class="count">0</span></h3><div class="qa-list"></div>`;
      }
      section.hidden = false;
      return section.querySelector<HTMLElement>(".qa-list")!;
    }

    function updateQuestionCount() {
      const section = panel.querySelector<HTMLElement>(".history")!;
      section.querySelector(".count")!.textContent = String(section.querySelectorAll(".qa").length);
    }

    /** Short status in the header; the full detail is in the tooltip. */
    function setStatus(text: string, detail = "") {
      const el = panel.querySelector<HTMLElement>(".status")!;
      el.textContent = text;
      el.title = detail;
      el.hidden = !text;
    }

    /** Who last changed the component, with the commit message on hover. Hidden outside git. */
    function renderGitLine(last: { sha: string; author: string; date: string; subject: string } | null, uncommitted: boolean) {
      const el = panel.querySelector<HTMLElement>(".gitinfo")!;
      if (!last) return;
      el.innerHTML = `${esc(last.author)}, ${esc(shortDate(last.date))}${uncommitted ? ' <span class="tag">uncommitted</span>' : ""}`;
      el.title = `Last changed in ${last.sha}: ${last.subject}${uncommitted ? "\nThe file also has uncommitted changes." : ""}`;
      el.hidden = false;
    }

    // Saved questions arrive with every explanation stream (including regenerations), but
    // the list only needs building once; questions asked since then are already in it.
    let historyRendered = false;
    function renderHistory(questions: { question: string; answer: string; createdAt: number; stale: boolean }[]) {
      if (historyRendered || !questions.length) return;
      historyRendered = true;
      const list = questionList();
      list.innerHTML = questions
        .map(
          (q) => `<details class="qa" data-key="${esc(normalizeQuestion(q.question))}">
            <summary>${esc(q.question)}${q.stale ? ' <span class="tag">outdated</span>' : ""}</summary>
            <div class="qa-body">
              <div class="md">${renderMarkdown(q.answer)}</div>
              <div class="meta">${timeAgo(q.createdAt)}${q.stale ? ` · code changed since · <button class="link" data-reask>ask again</button>` : ""}</div>
            </div>
          </details>`,
        )
        .join("");
      updateQuestionCount();
      list.querySelectorAll<HTMLButtonElement>("[data-reask]").forEach((b) =>
        b.addEventListener("click", () => ask(b.closest(".qa")!.querySelector("summary")!.textContent!.trim())),
      );
    }

    const run = (refresh: boolean) => stream({ refresh }, panel.querySelector(".explanation")!, true);
    run(false);

    function stream(extra: { refresh?: boolean; question?: string }, target: HTMLElement, primary: boolean) {
      if (primary) request?.abort();
      const ctrl = new AbortController();
      if (primary) request = ctrl;
      const progressHtml = (label: string) =>
        `<div class="progress"><div class="spinner"></div><span>${label}</span></div><ul class="steps"></ul>`;
      // While regenerating, keep the current explanation visible (dimmed) under the progress.
      const current = primary ? (target.querySelector(".card")?.outerHTML ?? "") : "";
      target.innerHTML = progressHtml(current ? "Regenerating…" : "Exploring the codebase…") + (current ? `<div class="stale">${current}</div>` : "");
      // The progress block below is the only busy indicator; the header shows the result once done.
      if (primary) setStatus("");
      else target.closest("details")?.setAttribute("open", "");
      let steps = target.querySelector(".steps")!;
      // Explanations render as structured sections; answers as markdown.
      const content = (ev: { card?: any; markdown: string; slots?: any }) =>
        primary && ev.card
          ? `<div class="card">${renderCard(ev.card, { component: t.comp, file: t.file, live, slots: ev.slots })}</div>`
          : `<div class="md">${renderMarkdown(ev.markdown)}</div>`;
      const body = {
        component: t.comp,
        file: t.file,
        line: t.line,
        chain: chain.map((c) => c.comp),
        props: live.props,
        state: live.state,
        elementText: (t.el as HTMLElement).innerText?.trim().slice(0, 200) || undefined,
        ...extra,
      };
      readStream(`${endpoint}/explain`, body, ctrl.signal, (ev) => {
        for (const def of ev.types ?? []) currentTypes.set(def.name, def);
        handle(ev);
        if (ev.type === "result" || ev.type === "stale" || ev.type === "history" || ev.type === "skeleton") {
          const body = panel.querySelector(".body")!;
          linkTypes(body, currentTypes);
          linkSymbols(body);
        }
      }).catch((err) => {
        if (ctrl.signal.aborted) return;
        target.innerHTML = `<div class="error">Could not reach the react-detective server at <code>${esc(endpoint)}</code>.<br>${esc(String(err?.message ?? err))}</div>`;
      });

      function handle(ev: any) {
        if (ev.type === "progress") {
          const li = document.createElement("li");
          li.textContent = ev.text;
          steps.appendChild(li);
          while (steps.children.length > 6) steps.firstElementChild!.remove();
        } else if (ev.type === "skeleton") {
          // Outline read straight from the code (no AI): show it right away, explanations follow.
          // When regenerating, the dimmed current explanation is more useful, so keep that.
          if (!primary || current) return;
          const done = steps.innerHTML;
          target.innerHTML =
            progressHtml("Writing the explanations…") +
            `<div class="card skeleton">${renderCard(ev.card, { component: t.comp, file: t.file, live, slots: ev.slots })}</div>`;
          steps = target.querySelector(".steps")!;
          steps.innerHTML = done;
        } else if (ev.type === "context") {
          renderGitLine(ev.lastChange, ev.uncommitted);
        } else if (ev.type === "history") {
          renderHistory(ev.questions);
        } else if (ev.type === "stale") {
          const changes: { file: string; diff?: string; deleted?: boolean }[] = ev.changes;
          const files = changes.map((c) => `<code>${esc(c.file)}</code>${c.deleted ? " (deleted)" : ""}`).join(", ");
          const diffs = changes.filter((c) => c.diff);
          target.innerHTML = `<div class="banner">Code changed since this was written${ev.git ? ` at <code>${esc(ev.git.commit)}</code>` : ""} (${files}).
              If the changes were significant, you might need to <button class="link" data-regenerate>generate a new explanation</button>.
              ${diffs.length ? `<details class="diffs"><summary>Show what changed</summary>${diffs.map((c) => renderDiff(c.diff!)).join("")}</details>` : ""}
            </div>
            ${progressHtml("Re-reading what changed…")}
            <div class="stale">${content(ev)}</div>`;
          steps = target.querySelector(".steps")!;
          target.querySelector("[data-regenerate]")?.addEventListener("click", () => run(true));
        } else if (ev.type === "result") {
          let meta = "";
          const at = ev.git ? ` at <code>${esc(ev.git.commit)}</code>${ev.git.branch && ev.git.branch !== "HEAD" ? ` (${esc(ev.git.branch)})` : ""}${ev.git.dirty ? " with uncommitted changes" : ""}` : "";
          let short = "";
          if (ev.cached) {
            meta = primary ? `Saved ${timeAgo(ev.createdAt)}${at} · code unchanged` : `Answered before (${timeAgo(ev.createdAt)}${at}) · code unchanged`;
            short = `Saved ${timeAgo(ev.createdAt)}`;
          } else {
            short = `Generated just now${ev.costUsd ? ` · $${ev.costUsd.toFixed(2)}` : ""}`;
            const bits = [`Explored live${at}`];
            if (ev.model) bits.push(modelName(ev.model));
            if (ev.turns) bits.push(`${ev.turns} step${ev.turns === 1 ? "" : "s"}`);
            if (ev.filesRead !== undefined) bits.push(`read ${ev.filesRead} file${ev.filesRead === 1 ? "" : "s"}`);
            const reused = [
              ev.notesReused && `${ev.notesReused} note${ev.notesReused === 1 ? "" : "s"}`,
              ev.exportsReused && `${ev.exportsReused} import${ev.exportsReused === 1 ? "" : "s"}`,
              ev.answersReused && `${ev.answersReused} past answer${ev.answersReused === 1 ? "" : "s"}`,
            ].filter(Boolean);
            if (reused.length) bits.push(`reused ${reused.join(" + ")}`);
            if (ev.costUsd) bits.push(`~$${ev.costUsd.toFixed(3)}`);
            meta = bits.join(" · ");
          }
          if (primary) {
            setStatus(short, meta.replace(/<[^>]+>/g, ""));
            target.innerHTML = content(ev);
          } else {
            target.innerHTML = `${content(ev)}<div class="meta">${meta}</div>`;
            target.closest("details")?.setAttribute("open", "");
          }
        } else if (ev.type === "error") {
          if (primary) setStatus("");
          const message = esc(ev.message)
            .replace(/^(ANTHROPIC_API_KEY=.*)$/m, "<code>$1</code>")
            .replace(/(https:\/\/\S+?)(\.?)(?=\s|$)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>$2')
            .replace(/\n/g, "<br>");
          const box = `<div class="${ev.code === "no-api-key" ? "banner" : "error"}">${message}</div>`;
          // Keep the outline read from the code (it needs no key); just stop showing progress.
          const skeleton = target.querySelector(".card.skeleton");
          // While regenerating, the current explanation is shown dimmed: put it back as it was.
          const dimmed = target.querySelector(":scope > .stale");
          if (!dimmed && !skeleton) return void (target.innerHTML = box);
          target.querySelectorAll(":scope > .progress, :scope > .steps").forEach((el) => el.remove());
          dimmed?.replaceWith(...dimmed.childNodes);
          const pending = skeleton?.querySelector(".summary.pending");
          if (pending) pending.textContent = "No explanation yet. The outline below is read straight from the code.";
          target.insertAdjacentHTML("afterbegin", box);
        }
      }
    }
  }

  function closePanel() {
    request?.abort();
    selected = null;
    panel.hidden = true;
    pop.hidden = true;
    selectedBox.hidden = true;
    cancelAnimationFrame(raf);
  }

  // ---------- custom type popover ----------

  // The same popover previews custom types and the component's own symbols (props, state, functions…).
  let hideTimer = 0;
  let shownFor: HTMLElement | null = null;
  function showRef(ref: HTMLElement) {
    clearTimeout(hideTimer);
    if (ref === shownFor && !pop.hidden) return; // still over the same reference
    let html = "";
    if (ref.dataset.type) {
      const def = currentTypes.get(ref.dataset.type);
      if (def) html = typePopover(def, currentTypes);
    } else {
      const def = findDefinition(panel, ref.dataset.sym!);
      if (def) html = symbolPopover(def);
    }
    if (!html) return;
    // Links inside the popover swap its content in place; elsewhere it opens next to the link.
    const inPop = pop.contains(ref);
    pop.innerHTML = html;
    pop.hidden = false;
    shownFor = inPop ? null : ref;
    if (inPop) return;
    // Measure at the top-left first: near the screen edge the popover would shrink to fit and measure too narrow.
    pop.style.left = "0px";
    pop.style.top = "0px";
    const r = ref.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, innerWidth - p.width - 8));
    const top = r.bottom + 6 + p.height < innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - p.height - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  const hidePopSoon = () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => (pop.hidden = true), 200);
  };
  for (const el of [panel, pop]) {
    el.addEventListener("mouseover", (e) => {
      const ref = (e.target as Element).closest<HTMLElement>(".type-ref, .sym-ref");
      // Inside the popover, symbol references are click-to-jump only, so the preview doesn't swap under the pointer.
      if (ref && !(el === pop && ref.classList.contains("sym-ref"))) showRef(ref);
      else if (el === pop) clearTimeout(hideTimer);
    });
    el.addEventListener("mouseout", (e) => {
      if (el === pop || (e.target as Element).closest(".type-ref, .sym-ref")) hidePopSoon();
    });
  }
  pop.addEventListener("click", (e) => onPanelClick(e));

  panel.addEventListener("click", (e) => onPanelClick(e));
  function onPanelClick(e: MouseEvent) {
    const target = e.target as Element;

    // Source links anywhere in the panel open the file in the developer's editor.
    const a = target.closest<HTMLElement>("a.src");
    if (a) {
      e.preventDefault();
      fetch(`${endpoint}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: a.dataset.file, line: a.dataset.line, column: a.dataset.col }),
      }).catch(() => {});
      return;
    }

    // A symbol reference jumps to its definition in the card (like "Go to Definition").
    const sym = target.closest<HTMLElement>(".sym-ref");
    if (sym) {
      const def = findDefinition(panel, sym.dataset.sym!);
      if (def) {
        e.preventDefault();
        pop.hidden = true;
        revealDefinition(def);
      }
      return;
    }

    // "expand all" sits inside a <summary>, so stop it from also toggling the section.
    const all = target.closest<HTMLElement>("[data-expand-all]");
    if (all) {
      e.preventDefault();
      const sec = all.closest(".sec");
      const nodes = [...(sec?.querySelectorAll(".ol-node") ?? [])];
      const groups = [...(sec?.querySelectorAll<HTMLDetailsElement>("details.ol-group") ?? [])];
      const open = nodes.some((n) => !n.classList.contains("open")) || groups.some((g) => !g.open);
      nodes.forEach((n) => n.classList.toggle("open", open));
      // Expanding everything should also reopen any collapsed groups.
      if (open) groups.forEach((g) => (g.open = true));
      all.textContent = open ? "collapse all" : "expand all";
      return;
    }

    // Outline rows and object values expand in place (clicks inside an open value don't collapse it).
    const row = target.closest(".ol-row");
    if (row) return row.parentElement!.classList.toggle("open");
    const value = target.closest(".expandable");
    if (value && !target.closest(".val-tree")) value.classList.toggle("open");
  }

  launcher.addEventListener("click", (e) => {
    if (justDragged) {
      justDragged = false;
      return e.preventDefault();
    }
    sticky = !sticky;
    setInspecting();
  });

  // ---------- draggable launcher, snapping to the nearest corner ----------

  type Corner = "tl" | "tr" | "bl" | "br";
  const CORNER_KEY = "react-detective:launcher-corner";
  let justDragged = false;
  function setCorner(c: Corner) {
    launcher.dataset.corner = c;
  }
  try {
    const saved = localStorage.getItem(CORNER_KEY);
    setCorner(saved === "tl" || saved === "tr" || saved === "bl" ? saved : "br");
  } catch {
    setCorner("br");
  }
  launcher.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    const start = launcher.getBoundingClientRect();
    launcher.setPointerCapture(down.pointerId);
    let dragging = false;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - down.clientX;
      const dy = e.clientY - down.clientY;
      if (!dragging && Math.hypot(dx, dy) < 5) return; // still a click
      if (!dragging) {
        dragging = true;
        launcher.classList.add("dragging");
      }
      const x = Math.max(0, Math.min(innerWidth - start.width, start.left + dx));
      const y = Math.max(0, Math.min(innerHeight - start.height, start.top + dy));
      launcher.style.cssText = `left:${x}px;top:${y}px;right:auto;bottom:auto;`;
    };
    const up = () => {
      launcher.removeEventListener("pointermove", move);
      launcher.removeEventListener("pointerup", up);
      launcher.removeEventListener("pointercancel", up);
      if (!dragging) return;
      justDragged = true;
      setTimeout(() => (justDragged = false), 0); // in case no click follows
      // Snap: pick the corner nearest the badge's centre, then animate from where it was dropped (FLIP).
      const from = launcher.getBoundingClientRect();
      const cx = from.left + from.width / 2;
      const cy = from.top + from.height / 2;
      const corner = `${cy < innerHeight / 2 ? "t" : "b"}${cx < innerWidth / 2 ? "l" : "r"}` as Corner;
      launcher.style.cssText = "";
      launcher.classList.remove("dragging");
      setCorner(corner);
      try {
        localStorage.setItem(CORNER_KEY, corner);
      } catch {}
      const to = launcher.getBoundingClientRect();
      launcher.animate(
        [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: "none" }],
        { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220, easing: "cubic-bezier(.2, .9, .3, 1.15)" },
      );
    };
    launcher.addEventListener("pointermove", move);
    launcher.addEventListener("pointerup", up);
    launcher.addEventListener("pointercancel", up);
  });

  // ---------- global listeners ----------

  const onMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (inspecting()) updateHover();
  };
  // Tapping Alt on its own toggles inspect mode. Holding it while clicking still works as a
  // one-off inspect; any other key or a click during the press means it wasn't a tap.
  let altAlone = false;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Alt") {
      if (!altDown) {
        altDown = true;
        altAlone = true;
        setInspecting();
      }
      e.preventDefault(); // stops Windows/Firefox from focusing the menu bar
      return;
    }
    altAlone = false;
    if (e.key === "Escape") {
      if (sticky) {
        sticky = false;
        setInspecting();
      } else if (selected) closePanel();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Alt") {
      altDown = false;
      if (altAlone) sticky = !sticky;
      altAlone = false;
      setInspecting();
      e.preventDefault();
    }
  };
  const onBlur = () => {
    altDown = false;
    altAlone = false; // e.g. Alt+Tab away
    setInspecting();
  };
  // Swallow the whole click sequence so the app doesn't react to an inspect click.
  const swallow = (e: Event) => {
    if (e.type === "pointerdown") altAlone = false;
    if (!inspecting() || !hovered || host.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type === "click") select(hovered);
  };
  const onScroll = () => inspecting() && updateHover();

  addEventListener("pointermove", onMove, { capture: true, passive: true });
  addEventListener("keydown", onKeyDown, true);
  addEventListener("keyup", onKeyUp, true);
  addEventListener("blur", onBlur);
  addEventListener("scroll", onScroll, { capture: true, passive: true });
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) addEventListener(type, swallow, true);

  const cleanup = () => {
    request?.abort();
    cancelAnimationFrame(raf);
    removeEventListener("pointermove", onMove, true);
    removeEventListener("keydown", onKeyDown, true);
    removeEventListener("keyup", onKeyUp, true);
    removeEventListener("blur", onBlur);
    removeEventListener("scroll", onScroll, true);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) removeEventListener(type, swallow, true);
    document.documentElement.style.cursor = "";
    host.remove();
    delete w.__reactDetective;
  };
  w.__reactDetective = cleanup;
  return cleanup;
}

async function readStream(url: string, body: object, signal: AbortSignal, onEvent: (ev: any) => void) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {}
    throw new Error(`${res.status} ${message}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

function renderDiff(diff: string): string {
  const lines = diff
    .split("\n")
    .filter((l) => !l.startsWith("--- ") && !l.startsWith("+++ ") && !l.startsWith("Index:") && !l.startsWith("\\ No newline"))
    .map((l) => {
      const cls = l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
      return `<span class="${cls}">${esc(l) || " "}</span>`;
    })
    .join(""); // spans are display:block, so no newlines between them
  const file = diff.match(/^\+\+\+ b\/(.+?)(\t|$)/m)?.[1] ?? "";
  return `<div class="difffile">${esc(file)}</div><pre class="diff">${lines}</pre>`;
}

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Same normalization as the server, so a re-asked question reuses its entry. */
function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** "2026-10-08" → "Oct 8" (adds the year when it isn't this year). */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}
