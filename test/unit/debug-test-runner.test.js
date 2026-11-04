import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTests, listTestFiles } from "../../packages/loopar/core/debug/test-runner.js";

// A throwaway repo with one test file, written to the OS temp dir: a fixture
// under test/ would be picked up (and fail) by the main suite's glob.
const SAMPLE = `
import { test, describe } from "node:test";
import assert from "node:assert/strict";
test("passes", () => assert.equal(1 + 1, 2));
test("fails", () => assert.deepEqual({ a: 1 }, { a: 2 }));
describe("group", () => {
  test("inner passes", () => {});
  test.skip("inner skipped", () => {});
});
test("prints", () => { console.log("hello from the fixture"); });
`;

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-runner-"));
  fs.mkdirSync(path.join(root, "test", "unit"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "unit", "sample.test.js"), SAMPLE);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("listTestFiles(): repo-relative files with their suite", () => {
  assert.deepEqual(listTestFiles(root), [{ file: "test/unit/sample.test.js", suite: "unit" }]);
});

test("runTests(): structured counts, failures with assertion detail, captured output", async () => {
  const seen = [];
  const run = runTests({ root, suite: "unit", onEvent: (ev) => seen.push(ev.type) });
  const result = await run.promise;

  assert.equal(result.status, "failed");
  assert.deepEqual(result.counts, { tests: 5, pass: 3, fail: 1, skip: 1, todo: 0, cancelled: 0 });
  assert.equal(result.files[0].file, "test/unit/sample.test.js");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, "fails");
  assert.equal(result.failures[0].error.actual, "{ a: 1 }");
  assert.equal(result.failures[0].error.expected, "{ a: 2 }");
  assert.ok(result.tests.find((t) => t.name === "inner passes").path.includes("group"));
  assert.ok(result.output.some((o) => o.text.includes("hello from the fixture")));
  assert.ok(seen.includes("done"));
});

test("runTests(): only files of the repo can be selected", () => {
  assert.throws(() => runTests({ root, files: ["../../../etc/passwd"] }), /Not a test file/);
  assert.throws(() => runTests({ root, suite: "nope" }), /Unknown test suite/);
});

test("runTests(): files are reported relative to the repo even through a symlinked root", async (t) => {
  const link = path.join(os.tmpdir(), `loopar-runner-link-${process.pid}`);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(root, link);
  t.after(() => fs.rmSync(link, { force: true }));
  const result = await runTests({ root: link, suite: "unit" }).promise;
  assert.equal(result.files[0].file, "test/unit/sample.test.js");
});
