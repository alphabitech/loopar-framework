'use strict';

export const DOC_STATUS = Object.freeze({
  ACTIVE: 1,
  INACTIVE: 2,
  DRAFT: 3,
  PENDING: 4,
  APPROVED: 5,
  REJECTED: 6,
  ARCHIVED: 7,
});

export const DOC_STATUS_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(DOC_STATUS).map(([k, v]) => [v, k]))
);

export function coerceDocStatus(value) {
  if (value == null) return DOC_STATUS.ACTIVE;
  if (typeof value === "number") {
    return Object.values(DOC_STATUS).includes(value) ? value : DOC_STATUS.ACTIVE;
  }
  if (typeof value === "string") {
    const key = value.toUpperCase();
    if (DOC_STATUS[key] != null) return DOC_STATUS[key];
    if (key === "DELETED") return DOC_STATUS.ACTIVE;
    console.warn(`[audit] unknown __document_status__ value "${value}", defaulting to ACTIVE`);
  }
  return DOC_STATUS.ACTIVE;
}

export const AUDIT_COLUMN_NAMES = Object.freeze([
  "__created_at__",
  "__updated_at__",
  "__deleted_at__",
  "__document_status__",
  "__created_by__",
]);

/**
 * Expected SQL type family per audit column — the single source used by
 * createTable (addAuditColumns) and alterTable (#auditColumnsNeedAlter /
 * #emitAuditColumnDelta) so a column added later (e.g. `__created_by__`)
 * reaches existing tables through the same path.
 */
export const AUDIT_COLUMN_FAMILY = Object.freeze({
  __created_at__: "datetime",
  __updated_at__: "datetime",
  __deleted_at__: "datetime",
  __document_status__: "int",
  __created_by__: "string",
});

/**
 * Order of a child-table row inside its parent (form tables). Framework-owned
 * column of every child table: rows are updated in place, so `id` no longer
 * says where a row goes.
 */
export const CHILD_POSITION_COLUMN = "__position__";

/**
 * Orders a knex query of child rows: by position, rows without one (saved
 * outside their parent) last, then by insertion. Written by hand: knex 3
 * drops the column itself when `nulls` goes in an orderBy array.
 */
export function orderChildRows(qb) {
  return qb.orderByRaw("(?? is null), ??, ??", [CHILD_POSITION_COLUMN, CHILD_POSITION_COLUMN, "id"]);
}

/** Username that created the row. Immutable after insert. */
export const CREATED_BY_COLUMN = "__created_by__";
export const CREATED_BY_LENGTH = 140;

export const AUDIT_COLUMN_SET = new Set(AUDIT_COLUMN_NAMES);

const EXCLUDED_AUDIT_TABLES = new Set([
  "Document Single Values",
  "Document History",
  // Page View — web analytics events.
  "Page View",
]);

export function isAuditableEntity(e) {
  if (!e) return false;
  if (EXCLUDED_AUDIT_TABLES.has(e.__NAME__)) return false;
  if (e.is_static || e.is_child || e.is_single || e.is_virtual) return false;
  if (e.is_audited === false) return false;
  return true;
}

export function addPrimaryKey(table) {
  table.increments("id");
}

/**
 * @param {*} table  - Knex TableBuilder instance from inside the callback
 * @param {*} knex   - Live Knex client; needed for fn.now() / raw defaults
 */
export function addAuditColumns(table, knex) {
  table.timestamp("__created_at__").defaultTo(knex.fn.now());
  table.timestamp("__updated_at__").defaultTo(knex.fn.now());
  table.timestamp("__deleted_at__").nullable();
  table.integer("__document_status__").notNullable().defaultTo(DOC_STATUS.ACTIVE);
  table.string(CREATED_BY_COLUMN, CREATED_BY_LENGTH).nullable().index();
}

export const FRAMEWORK_OWNED_COLUMN_NAMES = Object.freeze([
  "id",
  ...AUDIT_COLUMN_NAMES,
]);

export const FRAMEWORK_OWNED_COLUMN_SET = new Set(FRAMEWORK_OWNED_COLUMN_NAMES);
