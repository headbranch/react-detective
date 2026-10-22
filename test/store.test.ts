import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore, localImports } from "../src/server/store.ts";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

test("explanations stay fresh until any dependency changes", () => {
  const root = project({ "src/A.tsx": "a", "src/useB.ts": "b" });
  const store = new KnowledgeStore(root);
  const deps = store.snapshot(["src/A.tsx", "src/useB.ts"]);
  store.saveExplanation("A", "src/A.tsx", { markdown: "hi", deps, createdAt: 1 });

  const rec = new KnowledgeStore(root).getComponent("A", "src/A.tsx");
  assert.equal(rec.explanation?.markdown, "hi");
  assert.deepEqual(store.check(rec.explanation!.deps), { fresh: true, changed: [] });

  fs.writeFileSync(path.join(root, "src/useB.ts"), "b changed!");
  assert.deepEqual(store.check(rec.explanation!.deps), { fresh: false, changed: ["src/useB.ts"] });

  fs.rmSync(path.join(root, "src/A.tsx"));
  assert.deepEqual(store.check(rec.explanation!.deps).changed, ["src/A.tsx", "src/useB.ts"]);
});

test("line endings don't count as changes", () => {
  const root = project({ "a.ts": "x\ny\n" });
  const store = new KnowledgeStore(root);
  const h = store.hashFile("a.ts");
  fs.writeFileSync(path.join(root, "a.ts"), "x\r\ny\r\n");
  assert.equal(new KnowledgeStore(root).hashFile("a.ts"), h);
});

test("questions are matched loosely and replaced when re-asked", () => {
  const root = project({ "A.tsx": "a" });
  const store = new KnowledgeStore(root);
  const deps = store.snapshot(["A.tsx"]);
  store.saveQuestion("A", "A.tsx", { question: "Why does it re-render?", answer: "old", deps, createdAt: 1 });
  store.saveQuestion("A", "A.tsx", { question: "why does it   re-render", answer: "new", deps, createdAt: 2 });
  const rec = store.getComponent("A", "A.tsx");
  assert.equal(rec.questions.length, 1);
  assert.equal(store.findQuestion(rec, "WHY does it re-render??")?.answer, "new");
});

test("listComponents returns every saved component record", () => {
  const root = project({ "A.tsx": "a", "B.tsx": "b" });
  const store = new KnowledgeStore(root);
  assert.deepEqual(store.listComponents(), []);
  store.saveQuestion("A", "A.tsx", { question: "q1", answer: "a1", deps: store.snapshot(["A.tsx"]), createdAt: 1 });
  store.saveExplanation("B", "B.tsx", { markdown: "b", deps: store.snapshot(["B.tsx"]), createdAt: 2 });
  const recs = new KnowledgeStore(root).listComponents();
  assert.deepEqual(recs.map((r) => r.component).sort(), ["A", "B"]);
  assert.equal(recs.find((r) => r.component === "A")?.questions[0].answer, "a1");
});

test("file notes are only valid for the content they summarized", () => {
  const root = project({ "src/useB.ts": "b" });
  const store = new KnowledgeStore(root);
  store.saveNotes({ "src/useB.ts": "Hook B.", "src/never-read.ts": "made up" }, store.snapshot(["src/useB.ts"]));
  assert.deepEqual(store.validNotes(["src/useB.ts", "src/never-read.ts"]), { "src/useB.ts": "Hook B." });
  fs.writeFileSync(path.join(root, "src/useB.ts"), "b2");
  assert.deepEqual(new KnowledgeStore(root).validNotes(["src/useB.ts"]), {});
  assert.ok(fs.existsSync(path.join(root, ".react-detective", "README.md")));
});

test("localImports resolves relative and @/ imports", () => {
  const root = project({
    "components/Card.tsx": `import { x } from "./util";\nimport type { P } from "@/lib/products";\nimport React from "react";`,
    "components/util.ts": "",
    "lib/products.ts": "",
  });
  assert.deepEqual(localImports(root, "components/Card.tsx").sort(), ["components/util.ts", "lib/products.ts"]);
});
