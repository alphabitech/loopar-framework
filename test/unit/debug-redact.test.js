import { test } from "node:test";
import assert from "node:assert/strict";
import { redactBindings, redactObject, redactUrl, scrubText, pickHeaders, REDACTED } from "../../packages/loopar/core/debug/redact.js";

test("redactBindings(): insert columns map positionally, multi-row included", () => {
  const sql = "insert into `tbl_user` (`name`, `password`, `email`) values (?, ?, ?), (?, ?, ?)";
  assert.deepEqual(
    redactBindings(sql, ["a", "p1", "a@x", "b", "p2", "b@x"]),
    ["a", REDACTED, "a@x", "b", REDACTED, "b@x"],
  );
});

test("redactBindings(): `col = ?` / `$n` placeholders by column name", () => {
  assert.deepEqual(
    redactBindings('update "user" set "password" = $1, "name" = $2 where "id" = $3', ["x", "n", 1]),
    [REDACTED, "n", 1],
  );
  assert.deepEqual(
    redactBindings("select * from t where `token_hash` = ? and name in (?, ?)", ["h", "a", "b"]),
    [REDACTED, "a", "b"],
  );
});

test("redactBindings(): a `?` inside a string literal is not a placeholder", () => {
  assert.deepEqual(
    redactBindings("select * from t where note = 'what?' and api_key = ?", ["k"]),
    [REDACTED],
  );
});

test("redactBindings(): secret-shaped values are masked whatever the column", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig";
  assert.deepEqual(redactBindings("select ? as a, ? as b", [jwt, "$argon2id$v=19$m=65536"]), [REDACTED, REDACTED]);
});

test("redactBindings(): long values are clipped, binaries summarized, nulls kept", () => {
  const [long, bin, nil] = redactBindings("select ?, ?, ?", ["x".repeat(500), Buffer.alloc(10), null]);
  assert.match(long, /^x{200}…\(\+300 chars\)$/);
  assert.equal(bin, "[binary 10 bytes]");
  assert.equal(nil, null);
});

test("redactObject(): sensitive keys masked at any depth, bounded", () => {
  const out = redactObject({ email: "a", password: "x", nested: { api_key: "k", ok: [1, 2] }, empty_token: "" });
  assert.deepEqual(out, { email: "a", password: REDACTED, nested: { api_key: REDACTED, ok: [1, 2] }, empty_token: "" });
});

test("pickHeaders(): credentials are never copied", () => {
  const h = pickHeaders({ cookie: "s", authorization: "Bearer x", "x-csrf-token": "c", "user-agent": "ua", host: "h" });
  assert.deepEqual(h, { host: "h", "user-agent": "ua" });
});

test("redactUrl(): one-time links lose their token, code and state; the rest stays", () => {
  assert.equal(redactUrl("/auth/recoveryPassword?token=abc123&page=2"), `/auth/recoveryPassword?token=${REDACTED}&page=2`);
  assert.equal(redactUrl("/auth/oauthCallback?code=xyz&state=s1"), `/auth/oauthCallback?code=${REDACTED}&state=${REDACTED}`);
  assert.equal(redactUrl("/desk/Invoice/list?name=A-1"), "/desk/Invoice/list?name=A-1");
});

test("scrubText(): secrets inside free text (log lines, messages)", () => {
  assert.equal(scrubText("[404] GET /x?reset_token=zzz&page=2"), `[404] GET /x?reset_token=${REDACTED}&page=2`);
  assert.equal(scrubText("hash $argon2id$v=19$m=65536,t=3$abc$def end"), `hash ${REDACTED} end`);
  assert.equal(scrubText("key sk_live_1234567890abcdef!"), `key ${REDACTED}!`);
});

test("redactBindings(): huge bulk inserts keep a bounded sample", () => {
  const sql = "insert into t (a) values " + Array(150).fill("(?)").join(",");
  const out = redactBindings(sql, Array(150).fill(1));
  assert.equal(out.length, 101);
  assert.equal(out[100], "…(+50 bindings)");
});
