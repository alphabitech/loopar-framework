import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../../packages/loopar/core/server/router/request-context.js";
import { listFilters, listPage, clampPage } from "../../packages/loopar/core/document/list-state.js";

const inRequest = (document, query, fn) =>
  requestContext.run({ req: { query, __CONTROLLER__: { document } } }, fn);

test("listFilters(): every non-control query param is a filter, as a raw string", () => {
  inRequest("Customer", { name: "juan", code: "00123", page: "2", preloaded: "true", board: "Open", workspace: "desk" }, () => {
    assert.deepEqual(listFilters("Customer"), { name: "juan", code: "00123" });
  });
});

test("listFilters(): empty values are dropped, repeated params keep the last value", () => {
  inRequest("Customer", { name: "  ", city: ["Boston", "Lynn"] }, () => {
    assert.deepEqual(listFilters("Customer"), { city: "Lynn" });
  });
});

test("listFilters(): exclude removes page-specific params (module page `type`)", () => {
  inRequest("Module", { type: "Entity", name: "user" }, () => {
    assert.deepEqual(listFilters("Module", { exclude: ["type"] }), { name: "user" });
  });
});

test("list state applies only to the entity the request targets", () => {
  inRequest("Invoice", { name: "x", page: "3" }, () => {
    assert.deepEqual(listFilters("Document History"), {});
    assert.equal(listPage("Document History"), 1);
    assert.equal(listPage("Invoice"), 3);
  });
});

test("listPage(): invalid or missing page is 1; outside a request everything is clean", () => {
  inRequest("Customer", { page: "abc" }, () => assert.equal(listPage("Customer"), 1));
  inRequest("Customer", { page: "-4" }, () => assert.equal(listPage("Customer"), 1));
  assert.equal(listPage("Customer"), 1);
  assert.deepEqual(listFilters("Customer"), {});
});

test("clampPage(): out-of-range pages land on the last page, never below 1", () => {
  assert.equal(clampPage(9, 3), 3);
  assert.equal(clampPage(2, 0), 1);
  assert.equal(clampPage(0, 5), 1);
  assert.equal(clampPage(2, 5), 2);
});
