import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "../src/server/env.ts";

test("parses .env files", () => {
  const env = parseEnv(`# comment
export A=1
B = "two words" 
C='x#y'
D=plain # trailing comment
not a line
ANTHROPIC_API_KEY=sk-ant-123
`);
  assert.deepEqual(env, { A: "1", B: "two words", C: "x#y", D: "plain", ANTHROPIC_API_KEY: "sk-ant-123" });
});
