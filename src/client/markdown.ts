// Deliberately tiny markdown renderer covering what the agent is asked to produce.
// Inline code that looks like `path/to/file.tsx:12` becomes a clickable source link.

const FILE_REF = /^([\w@.\-/[\]()]+\.(?:[cm]?[jt]sx?|css|scss|json|md))(?::(\d+))?(?::(\d+))?$/;

/** HTML-escapes text for use in markup and attribute values. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Clickable source link for a `path:line[:col]` reference; shows a short label with the full path on hover. */
export function srcLink(ref: string, label?: string): string {
  const m = ref.trim().match(FILE_REF);
  if (!m) return `<code>${esc(ref)}</code>`;
  const text = label ?? `${m[1].split("/").pop()}${m[2] ? `:${m[2]}` : ""}`;
  return `<a class="src ref" data-file="${esc(m[1])}" data-line="${m[2] ?? 1}" data-col="${m[3] ?? 1}" title="${esc(ref)}">${esc(text)}</a>`;
}

export function inline(text: string): string {
  // Swap code spans for placeholders first so emphasis can wrap around them
  // (e.g. **`foo` is bar**) without touching what's inside the code.
  const codes: string[] = [];
  const withSlots = text.replace(/`([^`]+)`/g, (_, code: string) => {
    const m = code.match(FILE_REF);
    codes.push(
      m
        ? `<a class="src" data-file="${esc(m[1])}" data-line="${m[2] ?? 1}" data-col="${m[3] ?? 1}"><code>${esc(code)}</code></a>`
        : `<code>${esc(code)}</code>`,
    );
    return `\u0000${codes.length - 1}\u0000`;
  });
  return esc(withSlots)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      flushPara();
      closeList();
      const body: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length + 1, 5);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)/);
    if (item) {
      flushPara();
      const kind = item[1] ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(item[3])}</li>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    if (list && /^\s{2,}/.test(line)) {
      // continuation of the previous list item
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join("\n");
}
