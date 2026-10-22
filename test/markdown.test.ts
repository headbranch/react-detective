import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/client/markdown.ts";

test("bold can wrap inline code", () => {
  assert.equal(renderMarkdown("**`lastActive` is text.**"), "<p><strong><code>lastActive</code> is text.</strong></p>");
});

test("file references become source links and code is escaped", () => {
  const html = renderMarkdown("See `src/a.tsx:12` and `<b>*x*</b>`");
  assert.match(html, /<a class="src" data-file="src\/a.tsx" data-line="12" data-col="1"><code>src\/a.tsx:12<\/code><\/a>/);
  assert.match(html, /<code>&lt;b&gt;\*x\*&lt;\/b&gt;<\/code>/);
});

test("headings, lists and fences", () => {
  const html = renderMarkdown("## Data flow\n- one\n- two\n\n```ts\nconst a = 1 < 2;\n```");
  assert.equal(html, "<h3>Data flow</h3>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<pre><code>const a = 1 &lt; 2;</code></pre>");
});
