import { test } from "node:test";
import assert from "node:assert/strict";
import { lineState, parseLine, readStreams, groupLines } from "../../packages/loopar/core/logging/tenant-log.js";
import { debuggerRowsOf } from "../../packages/loopar/core/logging/debugger-logs.js";

const known = ["gym", "tester"];

test("a stamped line: time and tenant come off; the tenant view drops the stamp", () => {
  const st = lineState({ known, tenant: "gym" });
  const e = parseLine(st, "out", "2026-11-27 19:00:02.000: [gym] hello");
  assert.equal(e.t, "gym");
  assert.equal(e.text, "hello");
  assert.equal(new Date(e.at).getMilliseconds(), 0);
  assert.equal(new Date(e.at).getSeconds(), 2);
});

test("module tags are not tenants; other tenants and core lines never leak", () => {
  const st = lineState({ known, tenant: "gym" });
  assert.equal(parseLine(st, "err", "2026-11-27 19:00:05.000: [Realtime] namespace bella not found"), null);
  assert.equal(parseLine(st, "out", "2026-11-27 19:00:04.000: [tester] GET /desk 200"), null);
  assert.equal(parseLine(st, "out", "2026-11-27 19:00:01.000: Core server listening"), null);
  // "[history]" after the tenant stamp is part of the message
  assert.equal(parseLine(st, "out", "2026-11-27 19:00:06.000: [gym] [history] ok").text, "[history] ok");
});

test("stdout and stderr interleave by time; unstamped lines (cluster chunks) take the previous time", () => {
  const st = lineState({ known, tenant: "gym" });
  const r = readStreams(st, {
    out: ["2026-11-27 19:00:02.000: [gym] first", "2026-11-27 19:00:04.000: [gym] third"],
    err: ["2026-11-27 19:00:03.000: [gym] Error: second", "[gym]     at f (x.js:1:1)"],
  });
  assert.equal(r.timed, true);
  assert.deepEqual(r.merged.map((e) => e.text), ["first", "Error: second", "    at f (x.js:1:1)", "third"]);
});

test("files without the tenant stamp on continuations (older format) still attribute the stack", () => {
  const st = lineState({ known, tenant: "gym" });
  const r = readStreams(st, { out: [], err: ["[gym] Error: boom", "    at f (x.js:1:1)", "[tester] other"] });
  assert.deepEqual(r.err.map((e) => e.text), ["Error: boom", "    at f (x.js:1:1)"]);
});

test("the Debugger groups a stack under its error, in history and live alike", () => {
  const st = lineState({ known, tenant: "gym" });
  const r = readStreams(st, { out: [], err: ["2026-11-27 19:00:03.000: [gym] Error: boom", "2026-11-27 19:00:03.000: [gym]     at f (x.js:1:1)"] });
  const [fromFile] = groupLines(r.err);
  assert.equal(fromFile.text, "Error: boom");
  assert.deepEqual(fromFile.stack, ["    at f (x.js:1:1)"]);
  const [live] = debuggerRowsOf({ at: Date.now(), s: "err", text: "Error: boom\n    at f (x.js:1:1)" });
  assert.equal(live.level, "error");
  assert.equal(live.text, "Error: boom");
  assert.equal(live.stack, "    at f (x.js:1:1)");
});

test("Debugger rows hide secrets", () => {
  const [row] = debuggerRowsOf({ at: Date.now(), s: "out", text: "login ok password=hunter2 token: abc" });
  assert.equal(row.text, "login ok password=[redacted] token: [redacted]");
});
