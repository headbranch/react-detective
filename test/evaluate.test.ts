import { test } from "node:test";
import assert from "node:assert/strict";
import { code, evaluate } from "../src/client/evaluate.ts";

const known = new Map<string, unknown>([
  ["count", 3],
  ["title", "Kitchen sink"],
  ["items", [{ id: 1, text: "milk" }]],
  ["user", { name: "Ada", address: null }],
  ["onSave", "[Function onSave]"],
]);
const value = (text: string) => evaluate(text, known).value;

test("literals, names and property paths", () => {
  assert.equal(value("1000"), 1000);
  assert.equal(value("-1.5"), -1.5);
  assert.equal(value('"theme"'), "theme");
  assert.equal(value("'it\\'s'"), "it's");
  assert.equal(value("true"), true);
  assert.equal(value("null"), null);
  assert.equal(value("count"), 3);
  assert.equal(value("user.name"), "Ada");
  assert.equal(value("items[0].text"), "milk");
  assert.equal(value("items.length"), 1);
  assert.equal(value('user["name"]'), "Ada");
  assert.equal(value("user.address?.city"), undefined);
  assert.equal(value("onSave"), "[Function onSave]");
});

test("object and array literals are worked out part by part; functions show as functions", () => {
  assert.deepEqual(value('{ queryKey: ["fact", count], queryFn: () => fetchFact(count) }'), {
    queryKey: ["fact", 3],
    queryFn: "[Function anonymous]",
  });
  assert.deepEqual(value("{ count, title: title, load() { return 1; }, 'a-b': 2 }"), { count: 3, title: "Kitchen sink", load: "[Function anonymous]", "a-b": 2 });
  assert.deepEqual(value("[...items, count]"), [{ id: 1, text: "milk" }, 3]);
  assert.deepEqual(value("{ ...user, count }"), { name: "Ada", address: null, count: 3 });
  assert.equal(value("async (id) => { await save(id); }"), "[Function anonymous]");
  assert.equal(value("function named() {}"), "[Function anonymous]");
});

test("template strings are filled in", () => {
  assert.equal(value("`${title} (${items.length})`"), "Kitchen sink (1)");
  assert.equal(value("`count: ${count}`"), "count: 3");
});

test("anything else is kept as the code, never guessed", () => {
  assert.deepEqual(evaluate("fetchFact(count)", known), { value: code("fetchFact(count)"), resolved: false });
  assert.deepEqual(evaluate("count + 1", known), { value: code("count + 1"), resolved: false });
  assert.deepEqual(evaluate("unknownName", known), { value: code("unknownName"), resolved: false });
  assert.deepEqual(evaluate("user.missing", known), { value: code("user.missing"), resolved: false });
  // Only the parts it can't work out are kept as code.
  assert.deepEqual(value("{ key: count * 2, id: count, when: a ? b : c }"), { key: code("count * 2"), id: 3, when: code("a ? b : c") });
  assert.deepEqual(value("[count, compute(count)]"), [3, code("compute(count)")]);
  // A template is all or nothing.
  assert.equal(value("`${count + 1} items`"), code("`${count + 1} items`"));
  assert.equal(evaluate("{ a: unknown }", known).resolved, false);
});
