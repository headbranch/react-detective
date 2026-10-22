import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeCallSites } from "../src/server/callsites.ts";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-calls-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const root = project({
  "src/App.tsx": `import { useState } from "react";
import { Card } from "./Card";
import { theme } from "./theme";

export function App({ user }) {
  const [query, setQuery] = useState("");
  const rest = { id: 1 };
  return (
    <main>
      <Card title="Hello" count={3} onPick={setQuery} owner={user.name} theme={theme} disabled {...rest}>
        <b>hi</b> there
      </Card>
      {[1, 2].map((n) => <Card key={n} title={\`#\${n}\`} />)}
    </main>
  );
}

const Other = () => <Card title={query + "!"} />;
`,
});

test("what each call site passes, as written, with where the names it passes are declared", () => {
  const [first] = describeCallSites(root, "Card", [{ ref: "src/App.tsx:10" }]);
  assert.equal(first.parent, "App");
  assert.deepEqual(first.props, [
    { name: "title", value: '"Hello"' },
    { name: "count", value: "3" },
    // A state setter, a prop's property, an import: each traced to its line.
    { name: "onPick", value: "setQuery", line: 6 },
    { name: "owner", value: "user.name", line: 5 },
    { name: "theme", value: "theme", line: 3 },
    { name: "disabled", value: "true" },
    { name: "...", value: "rest", line: 7 },
    { name: "children", value: "<b>hi</b> there" },
  ]);
});

test("names from a callback's parameters, and parents defined as arrow functions", () => {
  const [inList, inOther] = describeCallSites(root, "Card", [{ ref: "src/App.tsx:13" }, { ref: "src/App.tsx:18" }]);
  assert.equal(inList.parent, "App");
  assert.deepEqual(inList.props, [
    { name: "key", value: "n", line: 13 },
    { name: "title", value: "`#${n}`" },
  ]);
  assert.equal(inOther.parent, "Other");
  // Not a plain name: no line.
  assert.deepEqual(inOther.props, [{ name: "title", value: 'query + "!"' }]);
});

test("a ref with no element on its line is left as it is", () => {
  assert.deepEqual(describeCallSites(root, "Card", [{ ref: "src/App.tsx:1" }, { ref: "src/Missing.tsx:3" }]), [{ ref: "src/App.tsx:1" }, { ref: "src/Missing.tsx:3" }]);
});
