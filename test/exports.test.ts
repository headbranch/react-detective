import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportsOf, importsOf } from "../src/server/exports.ts";
import { KnowledgeStore } from "../src/server/store.ts";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-exports-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const root = project({
  "src/hooks/useUsers.ts": `import type { User } from "../types";
export const PAGE_SIZE = 20;
export function useUsers(query: string): { users: User[]; loading: boolean } {
  return { users: [], loading: false };
}
const format = (u: User) => u.name;
export { format as formatUser };
`,
  "src/types.ts": `export interface User { id: number; name: string }
export type Role = "admin" | "member";
`,
  "src/components/Avatar.tsx": `export default function Avatar({ user }: { user: User }) { return null; }
`,
  "src/components/index.ts": `export { default as Avatar } from "./Avatar";
export * from "../hooks/useUsers";
`,
  "src/App.tsx": `import { useState } from "react";
import { useUsers, PAGE_SIZE } from "./hooks/useUsers";
import type { User } from "./types";
import { Avatar, formatUser } from "./components";
import * as types from "./types";
`,
});

test("lists a file's exports with kinds, signatures and lines", () => {
  const ex = exportsOf(root, "src/hooks/useUsers.ts");
  assert.deepEqual([...ex.keys()], ["PAGE_SIZE", "useUsers", "formatUser"]);
  assert.equal(ex.get("PAGE_SIZE")!.kind, "const");
  assert.equal(ex.get("PAGE_SIZE")!.signature, "20");
  assert.equal(ex.get("useUsers")!.kind, "hook");
  assert.equal(ex.get("useUsers")!.signature, "(query: string) => { users: User[]; loading: boolean }");
  assert.equal(ex.get("useUsers")!.line, 3);
  assert.equal(ex.get("formatUser")!.signature, "(u: User)");
  assert.equal(ex.get("formatUser")!.local, "format");

  const avatar = exportsOf(root, "src/components/Avatar.tsx").get("default")!;
  assert.equal(avatar.kind, "component");
  assert.equal(avatar.local, "Avatar");
});

test("follows re-exports through barrel files to the declaration", () => {
  const ex = exportsOf(root, "src/components/index.ts");
  const avatar = ex.get("Avatar")!;
  assert.equal(avatar.file, "src/components/Avatar.tsx");
  assert.equal(avatar.declaredAs, "default");
  assert.equal(ex.get("useUsers")!.file, "src/hooks/useUsers.ts");
  assert.equal(ex.get("formatUser")!.declaredAs, "formatUser");
});

test("lists what a file imports from project files", () => {
  const imports = importsOf(root, "src/App.tsx");
  assert.deepEqual(imports, [
    { file: "src/hooks/useUsers.ts", names: ["useUsers", "PAGE_SIZE"] },
    { file: "src/types.ts", names: ["User", "*"] },
    { file: "src/components/index.ts", names: ["Avatar", "formatUser"] },
  ]);
});

test("export descriptions are saved with notes and dropped when the file changes", () => {
  const root = project({ "src/a.ts": "export const A = 1;\nexport const B = 2;\n" });
  const store = new KnowledgeStore(root);
  const deps = store.snapshot(["src/a.ts"]);
  store.saveNotes({ "src/a.ts": "Two constants." }, deps, { "src/a.ts": { A: "The first.", B: "  " } });
  assert.deepEqual(new KnowledgeStore(root).validExports("src/a.ts"), { A: "The first." });

  // A later note for the same version keeps descriptions it didn't redo.
  store.saveNotes({ "src/a.ts": "Two constants, again." }, deps, { "src/a.ts": { B: "The second." } });
  assert.deepEqual(new KnowledgeStore(root).validExports("src/a.ts"), { A: "The first.", B: "The second." });

  fs.writeFileSync(path.join(root, "src/a.ts"), "export const A = 3;\n");
  assert.deepEqual(new KnowledgeStore(root).validExports("src/a.ts"), {});
});
