import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { skeletonCard } from "../src/server/skeleton.ts";
import { warmUpTypes, withCheckedTypes } from "../src/server/tstypes.ts";
import type { OutlineItem } from "../src/server/card.ts";

// Inside the repo (not the system temp folder), so the project's `typescript` is found from it.
const root = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-tstypes-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
write("package.json", "{}");
write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx", module: "esnext", moduleResolution: "bundler", skipLibCheck: true, noEmit: true }, include: ["src"] }));
write("src/lib.ts", `export function useThing(id: number) { return { label: \`#\${id}\`, ready: id > 0 }; }`);
write(
  "src/Thing.tsx",
  `import { useMemo, useSyncExternalStore } from "react";
import { useThing } from "./lib";
declare const subscribe: (cb: () => void) => () => void;
export function Thing({ ids }: { ids: number[] }) {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine);
  const total = ids.reduce((a, b) => a + b, 0);
  const { label } = useThing(total);
  const sorted = useMemo(() => [...ids].sort(), [ids]);
  return null;
}
`,
);

test("types the source can't spell out come from TypeScript's checker; ones it can are kept", async () => {
  const keep = setInterval(() => {}, 1000); // the warm-up timer doesn't hold the process open
  await warmUpTypes(root, 0);
  clearInterval(keep);
  const card = withCheckedTypes(root, "src/Thing.tsx", skeletonCard(root, "src/Thing.tsx", "Thing")!);
  const types = (items: OutlineItem[]): string[] => items.flatMap((o) => [`${o.name.replace(/\(.*$/s, "")}: ${o.type}`, ...types(o.children)]);
  assert.deepEqual(types(card.outline), [
    "online: boolean",
    "total: number",
    // The hook's signature, as read from its source, is kept as it was.
    "useThing: (id: number)",
    "label: string",
    "sorted: number[]",
  ]);
});

test("without the checker (not warmed up, or not a TypeScript project) the card is unchanged", () => {
  const card = skeletonCard(root, "src/Thing.tsx", "Thing")!;
  assert.equal(withCheckedTypes(path.join(root, "elsewhere"), "src/Thing.tsx", card), card);
});
