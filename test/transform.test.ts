import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { transformJsx } from "../src/transform.ts";

const root = path.resolve("/proj");
const file = (rel: string) => path.join(root, rel);
const run = (code: string, rel = "src/components/UserCard.tsx") => transformJsx(code, file(rel), root)?.code ?? null;

test("tags host elements with location and enclosing component", () => {
  const out = run(`export function UserCard({ user }: { user: User }) {\n  return <div className="card"><span>{user.name}</span></div>;\n}`)!;
  assert.match(out, /<div data-rd-loc="src\/components\/UserCard.tsx:2:10" data-rd-comp="UserCard" className="card">/);
  assert.match(out, /<span data-rd-loc="src\/components\/UserCard.tsx:2:32" data-rd-comp="UserCard">/);
});

test("leaves composite elements untouched", () => {
  const out = run(`const List = () => <Card title="x"><li>a</li></Card>;`)!;
  assert.match(out, /<Card title="x">/);
  assert.match(out, /<li data-rd-loc="[^"]+" data-rd-comp="List">/);
});

test("names arrow, memo and forwardRef components", () => {
  const out = run(`
    const A = () => <p />;
    const B = memo(() => <p />);
    const C = React.forwardRef(function Inner(props, ref) { return <p ref={ref} />; });
  `)!;
  assert.match(out, /data-rd-comp="A"/);
  assert.match(out, /data-rd-comp="B"/);
  assert.match(out, /data-rd-comp="Inner"/);
});

test("skips inline callbacks to find the real component", () => {
  const out = run(`function TodoList({ items }) { return <ul>{items.map((i) => <li key={i.id}>{i.text}</li>)}</ul>; }`)!;
  assert.equal(out.match(/data-rd-comp="TodoList"/g)?.length, 2);
});

test("anonymous default export takes its name from the file / Next route folder", () => {
  assert.match(run(`export default function () { return <main /> }`, "app/dashboard/page.tsx")!, /data-rd-comp="DashboardPage"/);
  assert.match(run(`export default () => <main />`, "src/user-profile.jsx")!, /data-rd-comp="UserProfile"/);
});

test("ignores node_modules, plain .ts and files without JSX", () => {
  assert.equal(run(`const x = <div />`, "node_modules/lib/index.jsx"), null);
  assert.equal(run(`const y = <T,>(v: T) => v;`, "src/util.ts"), null);
  assert.equal(run(`export const a = 1 < 2;`, "src/a.tsx"), null);
});

test("skips document-level tags and already-tagged elements", () => {
  const out = run(`export default function RootLayout({ children }) { return <html><head><title>x</title></head><body>{children}</body></html> }`, "app/layout.tsx")!;
  assert.doesNotMatch(out, /<html data-rd/);
  assert.doesNotMatch(out, /<title data-rd/);
  assert.match(out, /<body data-rd-loc="app\/layout.tsx:1:\d+" data-rd-comp="RootLayout">/);
  assert.equal(run(`const A = () => <div data-rd-loc="x" />`), null);
});

test("produces a source map", () => {
  const res = transformJsx(`const A = () => <div />`, file("src/a.jsx"), root)!;
  assert.ok(res.map.mappings.length > 0);
});
