import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTypes } from "../src/server/types.ts";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-types-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const files = {
  "src/hooks/useUsers.ts": `export type Role = "admin" | "editor";\n\nexport interface User {\n  id: number;\n  role: Role;\n}\n\nexport function useUsers() {}\n`,
  "src/components/UserCard.tsx": `import type { User } from "../hooks/useUsers";\n\ninterface Props {\n  user: User;\n}\n\nexport function UserCard({ user }: Props) { return <li>{user.id}</li>; }\n`,
};

test("resolves custom types from the component file and its imports, following nested types", () => {
  const root = project(files);
  const defs = resolveTypes(root, "src/components/UserCard.tsx", JSON.stringify({ props: [{ name: "user", type: "User" }] }));
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(byName).sort(), ["Role", "User"]);
  assert.equal(byName.User.kind, "interface");
  assert.equal(byName.User.file, "src/hooks/useUsers.ts");
  assert.equal(byName.User.line, 3);
  assert.match(byName.User.code, /^interface User \{\n  id: number;\n  role: Role;\n\}$/);
  assert.equal(byName.Role.kind, "type");
});

test("finds local types and ignores names that aren't declared types", () => {
  const root = project(files);
  const defs = resolveTypes(root, "src/components/UserCard.tsx", "Props, UserCard, React, Promise");
  assert.deepEqual(defs.map((d) => d.name).sort(), ["Props", "Role", "User"]);
});

test("no file, no types", () => {
  assert.deepEqual(resolveTypes(project(files), undefined, "User"), []);
});
