import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp, fetchPublicUrl } from "../../packages/loopar/core/global/storage/upload-guard.js";

test("isPrivateIp: IPv4-mapped IPv6 in dotted and hex form", () => {
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:7f00:1"), true);      // 127.0.0.1
  assert.equal(isPrivateIp("::ffff:a9fe:a9fe"), true);   // 169.254.169.254 (metadata)
  assert.equal(isPrivateIp("::ffff:5db8:d822"), false);  // 93.184.216.34
  assert.equal(isPrivateIp("93.184.216.34"), false);
});

test("fetchPublicUrl: a redirect to an internal address is refused", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, redirect: init?.redirect });
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } });
  };
  try {
    await assert.rejects(() => fetchPublicUrl("http://93.184.216.34/image.png"), /disallowed address/);
    assert.equal(calls.length, 1);               // the internal hop was never requested
    assert.equal(calls[0].redirect, "manual");   // redirects are not followed blindly
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchPublicUrl: public redirects are followed, capped", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return n < 3
      ? new Response(null, { status: 301, headers: { location: `http://93.184.216.34/hop${n}` } })
      : new Response("ok", { status: 200 });
  };
  try {
    const res = await fetchPublicUrl("http://93.184.216.34/start");
    assert.equal(res.status, 200);
    assert.equal(n, 3);

    n = -100; // always redirect
    await assert.rejects(() => fetchPublicUrl("http://93.184.216.34/loop", {}, { maxRedirects: 2 }), /too many times/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
