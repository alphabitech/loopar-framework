'use strict';

import {
  loopar,
  parseDocument,
  isAuditableEntity,
  coerceDocStatus,
  CREATED_BY_COLUMN,
  AUDIT_COLUMN_SET,
} from "loopar";
import EventEmitter from "events";
import Connector from "./core/knex/connector.js";
import { safeDefaultForType } from "./core/knex/core.js";
import { applyCondition } from "./core/knex/op-translator.js";

const isAuditColumnName = f => AUDIT_COLUMN_SET.has(f);

export class KnexORM extends Connector {
  executionTimeInsertedIds = {};

  static _bus = new EventEmitter();
  static _pipeline = new Map();

  static on(event, handler) {
    if (event.startsWith("before")) {
      const handlers = KnexORM._pipeline.get(event) || [];
      handlers.push(handler);
      KnexORM._pipeline.set(event, handlers);
    } else {
      KnexORM._bus.on(event, handler);
    }
  }

  static off(event, handler) {
    if (event.startsWith("before")) {
      const handlers = KnexORM._pipeline.get(event) || [];
      KnexORM._pipeline.set(event, handlers.filter(h => h !== handler));
    } else {
      KnexORM._bus.off(event, handler);
    }
  }

  static once(event, handler) {
    if (event.startsWith("before_")) {
      const wrapper = async (payload) => {
        await handler(payload);
        KnexORM.off(event, wrapper);
      };
      KnexORM.on(event, wrapper);
    } else {
      KnexORM._bus.once(event, handler);
    }
  }

  async #emitBefore(event, payload) {
    // Stamp the tenant on every event payload. The bus is STATIC (process-
    // global): today each process serves one tenant so this is redundant,
    // but any future shared-process mode needs listeners to be able to
    // filter by tenant — and having it now means handlers can already be
    // written tenant-aware.
    payload = { tenant: loopar.tenantId, ...payload };
    const document = payload?.document;
    const events = [event, document ? `${event}:${document}` : null].filter(Boolean);

    for (const ev of events) {
      const handlers = KnexORM._pipeline.get(ev) || [];
      for (const handler of handlers) {
        await handler(payload);
      }
    }
  }

  #emitAfter(event, payload) {
    // Same tenant stamp as #emitBefore — see comment there.
    payload = { tenant: loopar.tenantId, ...payload };

    // after* listeners are fire-and-forget and may query (Document History
    // inserts a row). Emitted mid-transaction they race endTransaction and
    // hit "Transaction query already complete". Queue them and dispatch once
    // the commit lands; drop them on rollback (the change never happened).
    if (this.transaction) {
      this.txState().after.push([event, payload]);
      return;
    }
    KnexORM.#dispatchAfter(event, payload);
  }

  static #dispatchAfter(event, payload) {
    const document = payload?.document;
    KnexORM._bus.emit(event, payload);
    if (document) KnexORM._bus.emit(`${event}:${document}`, payload);
  }

  async endTransaction() {
    // The queue lives with the transaction: a rollback drops both.
    const pending = this.txState()?.after ?? [];
    await super.endTransaction(); // throws (and rolls back) on commit failure → pending dropped
    for (const [event, payload] of pending) KnexORM.#dispatchAfter(event, payload);
  }

  dbFielTypeCanHaveDefaultValue(fieldType) {
    return [
      "varchar", "text", "int", "bigint", "tinyint", "smallint",
      "mediumint", "float", "double", "decimal",
      "date", "datetime", "timestamp", "time", "year",
    ].includes(fieldType);
  }

  isValidDefaultValue(value, type) {
    if (value === null) return true;
    switch (type) {
      case "int": case "bigint": case "tinyint": case "smallint":
      case "mediumint": case "float": case "double": case "decimal":
        return !isNaN(value);
      case "date": case "datetime": case "timestamp": case "time": case "year":
        return !isNaN(Date.parse(value));
      default:
        return true;
    }
  }

  buildWhereCb(condition) {
    if (!condition) return null;
    const hasContent =
      Object.keys(condition).length > 0 ||
      Object.getOwnPropertySymbols(condition).length > 0;
    if (!hasContent) return null;
    return (qb) => applyCondition(qb, condition);
  }

  async WHERE(condition = null) {
    const cb = this.buildWhereCb(condition);
    if (!cb) return { sql: "", bindings: [] };
    const probe = this.knex.queryBuilder().table("__loopar_where_probe__").where(cb);
    const compiled = probe.toSQL();
    const match = compiled.sql.match(/\bwhere\b\s+(.+)$/i);
    return {
      sql:      match ? match[1] : "",
      bindings: compiled.bindings || [],
    };
  }

  makePagination() {
    return this.pagination || {
      page: 1, pageSize: 5, totalPages: 4,
      totalRecords: 1, sortBy: "id", sortOrder: "asc",
    };
  }

  setPage(page) {
    if (this.pagination) {
      this.pagination.page = page;
    } else {
      this.pagination = { ...this.makePagination(), page };
    }
  }

  getParseData(data) {
    const STRING_LITERAL_MAP = { null: null, undefined: null, true: true, false: false };
    return Object.entries(data).reduce((acc, [key, value]) => {
      if (value === undefined) { acc[key] = null; return acc; }
      if (value !== null && typeof value === "object") { acc[key] = JSON.stringify(value); return acc; }
      if (typeof value === "string" && Object.prototype.hasOwnProperty.call(STRING_LITERAL_MAP, value)) {
        acc[key] = STRING_LITERAL_MAP[value];
        return acc;
      }
      acc[key] = value;
      return acc;
    }, {});
  }

  #canonicalizeEavValue(value) {
    if (value == null) return null;
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      return Number.isInteger(value) ? String(value) : String(value);
    }
    if (typeof value === "string") {
      if (/^-?\d+(\.\d+)?$/.test(value)) {
        const num = Number(value);
        if (Number.isFinite(num) && Number.isInteger(num)) return String(num);
      }
      return value;
    }
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  async #padOrphanColumns(document, data) {
    const colMap   = await this.getTableColumns(document);
    const dataKeys = new Set(Object.keys(data).map(k => k.toLowerCase()));

    for (const [colLower, meta] of colMap) {
      if (dataKeys.has(colLower)) continue;

      if (this.#isSqlFunctionDefault(meta.default)) {
        continue;
      }

      if (meta.default !== null && meta.default !== undefined) {
        data[meta.name] = this.#unquoteSqlDefault(meta.default);
      } else if (meta.nullable) {
        data[meta.name] = null;
      } else {
        data[meta.name] = safeDefaultForType(meta.type);
      }
    }

    return data;
  }

  /**
   * Table introspection returns string defaults as SQL literals — SQLite's
   * dflt_value for `DEFAULT 'all'` is the 5-char string `'all'` (quotes
   * included). Padding a missing column with that literal stores the quotes.
   */
  #unquoteSqlDefault(value) {
    if (typeof value !== "string") return value;
    const v = value.trim();
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
      return v.slice(1, -1).replace(/''/g, "'");
    }
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      return v.slice(1, -1);
    }
    return value;
  }

  #isSqlFunctionDefault(value) {
    if (typeof value !== "string") return false;
    const v = value.trim().toLowerCase();
    if (!v) return false;
    if (/^current_(timestamp|date|time)\b/.test(v)) return true;
    if (/^[a-z_][a-z0-9_]*\s*\(/.test(v)) return true;
    return false;
  }

  #isAuditable(document) {
    return isAuditableEntity(loopar.getRef?.(document));
  }

  async insertRow(document, data = {}, isSingle = false) {
    data = this.getParseData(data);

    if (!isSingle) {
      data = await this.filterToTableColumns(document, data);
      data = await this.#padOrphanColumns(document, data);

      if (this.#isAuditable(document)) {
        const now = this.qx().fn.now();
        if (data.__created_at__ == null) data.__created_at__ = now;
        if (data.__updated_at__ == null) data.__updated_at__ = now;
        data.__document_status__ = coerceDocStatus(data.__document_status__);
        await this.#stampCreatedBy(document, data);
      }
    }

    await this.#emitBefore("beforeCreate", { document, doc: data });

    if (isSingle) {
      // `Document Single Values` is in EXCLUDED_AUDIT_TABLES so it doesn't
      // own audit columns. We can't stamp __document_status__ on the
      // payload — the column literally doesn't exist on the table and the
      // INSERT raises "table has no column". The EAV row's "state" is the
      // owning single-doc's responsibility, not the value row's.
      const tbl = "Document Single Values";
      for (const [field, value] of Object.entries(data)) {
        const rowName = `${document}-${field}`;
        const payload = {
          document,
          field,
          value: this.#canonicalizeEavValue(value),
        };

        const existing = await this.qx()(tbl).where({ name: rowName }).first();
        if (existing) {
          await this.qx()(tbl).where({ name: rowName }).update(payload);
        } else {
          await this.qx()(tbl).insert({ name: rowName, ...payload });
        }
      }
    } else {
      if (this.#isAuditable(document) && data.name) {
        const stale = await this.qx()(document)
          .where({ name: data.name })
          .whereNotNull("__deleted_at__")
          .first();

        if (stale) {
          const restorePayload = { ...data, __deleted_at__: null };
          delete restorePayload.id;
          await this.qx()(document).where({ id: stale.id }).update(restorePayload);
          data.id = stale.id;
          data.__restored__ = true;
          this.#emitAfter("afterCreate", { document, doc: data });
          console.log([`[insertRow] restored soft-deleted ${document}:${data.name} (id=${stale.id})`]);
          return;
        }
      }

      const nextId    = parseInt(await this.nextId(document)) || 1;
      const currentId = parseInt(data.id) || 0;
      data.id = currentId && currentId >= nextId ? currentId : nextId;

      await this.qx()(document).insert(data);
    }

    this.#emitAfter("afterCreate", { document, doc: data });
  }

  async maxId(document) {
    const result = await this.qx()(document).max("id as max").first();
    return result?.max || 0;
  }

  async nextId(document) {
    const maxId   = await this.maxId(document);
    const tracked = this.executionTimeInsertedIds[document] || 0;
    this.executionTimeInsertedIds[document] = Math.max(maxId, tracked) + 1;
    return this.executionTimeInsertedIds[document];
  }

  async setValue(...args) {
    const a = loopar.utils.args(["document", "field", "value", "name"], args);
    const { document, field, value, name } = a;

    const condition = typeof name === "object" && name !== null
      ? { ...name }
      : (name ? { name } : {});

    const cb = this.buildWhereCb(condition);
    let qb = this.qx()(document).update({ [field]: value });
    if (cb) qb = qb.where(cb);
    await qb;
  }

  /**
   * `__created_by__` = username that created the row. Always the request
   * user — a payload value is ignored (it is not a user-editable column), so a
   * client can't forge ownership on create. Outside a request (installer,
   * boot, jobs) there is no user and the column stays NULL. Skipped when the
   * table hasn't been re-installed yet and lacks the column.
   */
  async #stampCreatedBy(document, data) {
    const colMap = await this.getTableColumns(document);
    if (!colMap.has(CREATED_BY_COLUMN)) {
      delete data[CREATED_BY_COLUMN];
      return;
    }
    const user = loopar.auth?.user?.() ?? null;
    data[CREATED_BY_COLUMN] = user;
  }

  async updateRow(document, name, data = {}) {
    data = this.getParseData(data);
    delete data.id;
    // Immutable after insert — never accept it on update.
    delete data[CREATED_BY_COLUMN];
    data = await this.filterToTableColumns(document, data);

    const auditable = this.#isAuditable(document);
    if (auditable) {
      data.__updated_at__ = this.qx().fn.now();
      // `__document_status__` is NOT NULL with DOC_STATUS.ACTIVE default. If
      // a caller sent the key with null/undefined (happens when a doc's
      // __DATA__ has the slot but no value, e.g. valuesToSetDataBase pulled
      // it through getParseData which canonicalises undefined → null), we
      // strip it so the UPDATE leaves the existing row value alone instead
      // of trying to write NULL into a NOT NULL column.
      if ('__document_status__' in data) {
        if (data.__document_status__ == null) {
          delete data.__document_status__;
        } else {
          data.__document_status__ = coerceDocStatus(data.__document_status__);
        }
      }
    }

    let before = null;
    if (auditable) {
      before = await this.qx()(document).where({ name }).first();
    }

    await this.#emitBefore("beforeUpdate", { document, doc: data, before });

    await this.qx()(document)
      .where({ name })
      .update(data);

    this.#emitAfter("afterUpdate", { document, doc: { ...data, name }, before });
  }

  async deleteRow(document, name, opts = {}) {
    if (typeof opts === "boolean") opts = { force: !opts };
    const { force = false } = opts;

    await this.#emitBefore("beforeDelete", { document, doc: { name } });

    const auditable = this.#isAuditable(document);
    if (force || !auditable) {
      await this.qx()(document).where({ name }).delete();
    } else {
      const now = this.qx().fn.now();
      await this.qx()(document).where({ name }).update({
        __deleted_at__: now,
        __updated_at__: now,
      });
    }

    this.#emitAfter("afterDelete", { document, doc: { name } });
  }

  async deleteWhere(document, condition) {
    const doc = await this.getRow(document, condition);
    await this.#emitBefore("beforeDelete", { document, doc });

    const cb = this.buildWhereCb(condition);
    if (!cb) {
      throw new Error("[deleteWhere] condition is required — refusing to delete all rows");
    }

    await this.qx()(document).where(cb).delete();

    this.#emitAfter("afterDelete", { document, doc });
  }

  async getValue(...args) {
    const a = loopar.utils.args(["document", "field", "name"], args);
    const { document, field, name } = a;
    const ifNotFound = a.ifNotFound ?? "throw";
    const includeDeleted  = a.includeDeleted  ?? false;

    try {
      const condition = typeof name === "object" && name !== null
        ? { ...name }
        : (name ? { name } : {});

      const result = await this.getDoc(document, condition, [field], { includeDeleted });
      if (!result) return null;
      return typeof field === "object" ? result : result[field];
    } catch (e) {
      if (ifNotFound === "throw") throw e;
      return ifNotFound;
    }
  }

  async getParseDoc() {
    return parseDocument(arguments[0], await this.getDoc(...arguments));
  }

  async getDoc(...args) {
    const a = loopar.utils.args(["document", "name", "fields"], args);
    let document = a.document;
    const name = a.name;
    let fields = Array.isArray(a.fields) ? a.fields : ["*"];
    const includeDeleted = a.includeDeleted ?? false;

    const ref = typeof document === "object" ? document.__REF__ : loopar.getRef(document);
    document = typeof document === "object" ? document.name : document;
    document = document === "Document" ? "Entity" : document;
    fields = fields[0] === "*"
      ? ref.__FIELDS__
      : fields.filter(field => ref.__FIELDS__.includes(field));

    if (!isAuditableEntity(ref)) {
      fields = fields.filter(f => !isAuditColumnName(f));
    }

    if (!ref.is_single) {
      try {
        const colMap = await this.getTableColumns(document);
        const existing = new Set();
        for (const [, meta] of colMap) existing.add(meta.name);
        fields = fields.filter(f => existing.has(f));
      } catch {
        // If we can't read columns, fall through with the raw fields.
      }
    }

    return await this.getRow({
      table: document,
      id: name,
      fields,
      isSingle: ref.is_single,
      includeDeleted,
    });
  }

  async getRow(...args) {
    const a = loopar.utils.args(["table", "id", "fields"], args);
    const table  = a.table;
    const id = a.id;
    const fields = Array.isArray(a.fields) ? a.fields : ["*"];
    const isSingle = a.isSingle ?? false;
    const includeDeleted = a.includeDeleted ?? false;

    this.setPage(1);
    const condition = id ? (typeof id === "object" ? id : { name: id }) : {};
    const rows = await this.getList({
      document: table,
      fields,
      filter: condition,
      options: { isSingle, includeDeleted },
    });
    return rows.length ? rows[0] : null;
  }

  async getDocEAV(document, fields = ["*"], condition = null, { includeDeleted = false } = {}) {
    const sv = "Document Single Values";

    let qb = this.qx()(sv).select("field", "value").where({ document });

    if (condition && Object.keys(condition).length > 0) {
      for (const [fieldName, fieldValue] of Object.entries(condition)) {
        if (fieldName === "__document_status__") continue;

        qb = qb.whereExists(builder => {
          builder.select(this.knex.raw("1"))
            .from(`${sv} as sub`)
            .whereRaw("sub.document = ?", [document])
            .andWhereRaw("sub.field = ?", [fieldName]);

          if (fieldValue !== null && typeof fieldValue === "object") {
            const sym = Object.getOwnPropertySymbols(fieldValue)[0];
            const desc = sym?.description;
            const v = fieldValue[sym];
            switch (desc) {
              case "ne": builder.andWhereRaw("sub.value != ?", [v]); break;
              case "like": builder.andWhereRaw("sub.value LIKE ?", [v]); break;
              case "in": builder.andWhereIn("sub.value", v); break;
              default: builder.andWhereRaw("sub.value = ?", [v]);
            }
          } else {
            builder.andWhereRaw("sub.value = ?", [fieldValue]);
          }
        });
      }
    }

    if (!includeDeleted) {
      qb = qb.whereNotExists(builder => {
        builder.select(this.knex.raw("1"))
          .from(`${sv} as sub`)
          .whereRaw("sub.document = ?", [document])
          .andWhereRaw("sub.field = ?", ["__deleted_at__"])
          .andWhereRaw("sub.value IS NOT NULL");
      });
    }

    if (fields[0] !== "*") {
      qb = qb.whereIn("field", fields);
    }

    const rows = await qb;

    const reconstructed = rows.reduce((acc, row) => ({ ...acc, [row.field]: row.value }), {});

    if (fields[0] !== "*") {
      const result = {};
      fields.forEach(f => { result[f] = reconstructed[f] !== undefined ? reconstructed[f] : null; });
      return [result];
    }

    return [reconstructed];
  }

  async getList(...args) {
    const a = loopar.utils.args(["document", "fields", "filter", "options"], args);
    const document = a.document;
    const fields = Array.isArray(a.fields) ? a.fields : ["*"];
    const filter = a.filter ?? {};

    const opts = a.options ?? {};
    const isSingle = opts.isSingle ?? a.isSingle ?? false;
    const all = opts.all ?? a.all ?? false;
    const includeDeleted = opts.includeDeleted ?? a.includeDeleted ?? false;

    if (isSingle) return await this.getDocEAV(document, fields, filter, { includeDeleted });

    let qb = this.qx()(document);
    qb = fields[0] === "*" ? qb.select("*") : qb.select(fields);

    const cb = this.buildWhereCb(filter);
    if (cb) qb = qb.where(cb);

    if (!includeDeleted && this.#isAuditable(document)) {
      qb = qb.whereNull("__deleted_at__");
    }

    if (!all) {
      const { page, pageSize } = this.makePagination();
      qb = qb.limit(pageSize).offset((page - 1) * pageSize);
    }

    return await qb;
  }

  async getAll(...args) {
    const a = loopar.utils.args(["document", "fields", "filter", "options"], args);
    return await this.getList({
      ...a,
      options: { ...(a.options ?? {}), all: true },
    });
  }

  async makeFields(fields = ["*"]) {
    return fields.map(f => f === "*" ? f : this.escapeId(f)).join(", ");
  }

  async hasEntity(constructor, document) {
    if (!constructor) {
      const ref   = loopar.getRef(document);
      constructor = ref?.__REF__?.name || "Entity";
    }
    return (await this.count(constructor, { name: document })) > 0;
  }

  async count(document, condition) {
    if (!condition) return 0;
    document  = document === "Document" ? "Entity" : document;
    condition = typeof condition === "object" ? condition : { name: condition };

    let qb = this.qx()(document).count({ count: "id" });
    const cb = this.buildWhereCb(condition);
    if (cb) qb = qb.where(cb);

    const result = await qb.first();
    return Number(result?.count || 0);
  }

  async rawQuery(sql, replacements = []) {
    const result = await this.qx().raw(sql, replacements);
    return Array.isArray(result) ? result : (result?.rows ?? result?.[0] ?? result);
  }
}

// Bridge ORM-level write events to loopar's `${doc}.changed` channel
// so generic listeners (Realtime, cache-invalidation, etc.) don't have
// to subscribe to before/afterCreate/Update/Delete individually.
KnexORM.on("afterCreate", ({ document }) => loopar.emit(`${document}.changed`));
KnexORM.on("afterUpdate", ({ document }) => loopar.emit(`${document}.changed`));
KnexORM.on("afterDelete", ({ document }) => loopar.emit(`${document}.changed`));
