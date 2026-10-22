import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";
import { blobHash, KnowledgeStore } from "../src/server/store.ts";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  return { root, git, write };
}

test("our fingerprint is git's blob id", () => {
  const { root, git, write } = repo();
  write("src/A.tsx", "export const A = () => <div />;\n");
  assert.equal(new KnowledgeStore(root).hashFile("src/A.tsx"), git("hash-object", "src/A.tsx").trim());
  assert.equal(blobHash(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"); // git's well-known empty blob
});

test("history, blame, head, dirty state and recovering old versions", async () => {
  const { root, git, write } = repo();
  const g = new Git(root);
  assert.equal(await g.isRepo(), true);
  assert.equal(await g.head(), null, "no HEAD before the first commit");

  write("src/useUsers.ts", "export const delay = 300;\n");
  git("add", ".");
  git("commit", "-q", "-m", "Add users hook", "-m", "Fake API until the backend exists.");
  const v1 = new KnowledgeStore(root).hashFile("src/useUsers.ts")!;

  write("src/useUsers.ts", "export const delay = 800; // debounce typing\n");
  git("commit", "-qam", "Slow down search to debounce typing");

  const commits = await g.recentCommits("src/useUsers.ts");
  assert.deepEqual(commits.map((c) => c.subject), ["Slow down search to debounce typing", "Add users hook"]);
  assert.equal(commits[0].author, "Ada");

  assert.equal(await g.catBlob(v1), "export const delay = 300;\n");
  assert.equal(await g.catBlob("0".repeat(40)), null);

  const head = await g.head();
  assert.equal(head?.branch, "main");
  assert.equal(await g.isDirty(["src/useUsers.ts"]), false);
  write("src/useUsers.ts", "export const delay = 1000;\n");
  assert.equal(await g.isDirty(["src/useUsers.ts"]), true);

  assert.match(await g.logText("src/useUsers.ts", 10), /Fake API until the backend exists\./);
  assert.match(await g.blameText("src/useUsers.ts", 1, 1), /delay/);
  assert.match(await g.showText(commits[0].sha), /Slow down search[\s\S]*\+export const delay = 800/);
  assert.equal(await g.showText("not-a-sha; rm -rf /"), "Invalid commit hash.");
});

test("outside a repo everything degrades quietly", async () => {
  const g = new Git(fs.mkdtempSync(path.join(os.tmpdir(), "rd-nogit-")));
  assert.equal(await g.isRepo(), false);
  assert.equal(await g.head(), null);
  assert.deepEqual(await g.recentCommits("a.ts"), []);
  assert.equal(await g.isDirty(["a.ts"]), false);
});

test("local snapshots let us diff never-committed versions", () => {
  const { root, write } = repo();
  write("a.ts", "one\n");
  const store = new KnowledgeStore(root);
  const deps = store.snapshot(["a.ts"]);
  store.saveBlobs(deps);
  write("a.ts", "two\n");
  assert.equal(new KnowledgeStore(root).readBlob(deps["a.ts"]), "one\n");
});
