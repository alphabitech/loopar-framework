import { test } from "node:test";
import assert from "node:assert/strict";
import { DOC_STATUS, DOC_STATUS_LABEL, coerceDocStatus, AUDIT_COLUMN_NAMES } from "../../packages/loopar/core/global/audit.js";

test("coerceDocStatus() accepts numbers and names, defaults to ACTIVE", () => {
  assert.equal(coerceDocStatus(DOC_STATUS.DRAFT), DOC_STATUS.DRAFT);
  assert.equal(coerceDocStatus("approved"), DOC_STATUS.APPROVED);
  assert.equal(coerceDocStatus(null), DOC_STATUS.ACTIVE);
  assert.equal(coerceDocStatus(999), DOC_STATUS.ACTIVE);
  assert.equal(coerceDocStatus("deleted"), DOC_STATUS.ACTIVE);
});

test("DOC_STATUS_LABEL is the inverse of DOC_STATUS", () => {
  for (const [label, value] of Object.entries(DOC_STATUS)) assert.equal(DOC_STATUS_LABEL[value], label);
});

test("audit columns are the framework-owned set", () => {
  assert.deepEqual([...AUDIT_COLUMN_NAMES].sort(),
    ["__created_at__", "__created_by__", "__deleted_at__", "__document_status__", "__updated_at__"]);
});
