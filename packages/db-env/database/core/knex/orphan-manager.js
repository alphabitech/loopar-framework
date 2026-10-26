'use strict';

import { loopar, AUDIT_COLUMN_SET, CHILD_POSITION_COLUMN } from "loopar";

// Built lazily: `loopar` (index.js) imports db-env while it is still
// evaluating, so reading AUDIT_COLUMN_SET at module top-level hits the TDZ.
let immuneColumns = null;
const IMMUNE = () => (immuneColumns ??= new Set(["id", "name", CHILD_POSITION_COLUMN, ...AUDIT_COLUMN_SET]));

export class OrphanManager {
  async getOrphanColumns(orm, document) {
    const ref = loopar.getRef(document);

    if (!ref) {
      console.warn(`[OrphanManager] No ref for "${document}"`);
      return [];
    }
    if (ref.is_single) return [];

    const structureCols = this.collectStructureCols(ref);
    const dbFields = await orm.getTableDescription(document);

    if (!dbFields.length) {
      console.warn(`[OrphanManager] Table for "${document}" not found or empty`);
      return [];
    }

    const detectedAt = new Date().toISOString();

    return dbFields
      .filter(f =>
        !structureCols.has(f.name.toLowerCase()) &&
        !IMMUNE().has(f.name.toLowerCase())
      )
      .map(f => ({
        name: f.name,
        type: f.type,
        nullable: f.nullable,
        default: f.default ?? null,
        primary: f.primary ?? false,
        detected_at: detectedAt,
        state: "orphan",
      }));
  }

  async releaseOrphanColumn(orm, document, columnName) {
    await this.assertOrphan(orm, document, columnName);

    const tableName = orm.tableName(document);
    const col = orm.escapeId(columnName);

    if (orm.isMySQLLike) {
      const rows = await orm.getTableDescription(document);
      const meta = rows.find(r => r.name.toLowerCase() === columnName.toLowerCase());
      const rawType = meta?.type || "VARCHAR(255)";

      await orm.qx().raw(`ALTER TABLE ${tableName} MODIFY COLUMN ${col} ${rawType} NULL`);

    } else if (orm.isPostgresLike) {
      for (const cmd of [
        `ALTER TABLE ${tableName} ALTER COLUMN ${col} DROP NOT NULL`,
        `ALTER TABLE ${tableName} ALTER COLUMN ${col} DROP DEFAULT`,
      ]) {
        try { await orm.qx().raw(cmd); }
        catch (e) { /* already nullable / no default — safe */ }
      }
    } else if (orm.isMSSQL) {
      const rows    = await orm.getTableDescription(document);
      const meta    = rows.find(r => r.name.toLowerCase() === columnName.toLowerCase());
      const rawType = meta?.type || "NVARCHAR(255)";
      await orm.qx().raw(`ALTER TABLE ${tableName} ALTER COLUMN ${col} ${rawType} NULL`);
    } else if (orm.isOracle) {
      try {
        await orm.qx().raw(`ALTER TABLE ${tableName} MODIFY (${col} NULL)`);
      } catch (e) { /* already nullable */ }
    }

    await this.dropColumnIndexes(orm, tableName, columnName);
    orm.invalidateColumnsCache(document);

    console.log(`[OrphanManager] Released "${columnName}" on ${tableName}`);
  }

  async dropOrphanColumn(orm, document, columnName) {
    await this.assertOrphan(orm, document, columnName);

    const tableName = orm.tableName(document);

    if (orm.isSQLiteLike) {
      await this.dropColumnSQLiteRecreate(orm, document, tableName, columnName);
    } else {
      await this.dropColumnIndexes(orm, tableName, columnName);
      await orm.qx().raw(`ALTER TABLE ${tableName} DROP COLUMN ${orm.escapeId(columnName)}`);
    }

    orm.invalidateColumnsCache(document);
    console.log(`[OrphanManager] Dropped "${columnName}" from ${tableName}`);
  }

  /**
   * SQLite < 3.35 doesn't support DROP COLUMN. We recreate the table.
   */
  async dropColumnSQLiteRecreate(orm, document, tableName, columnName) {
    const literalName = tableName.replace(/[`"]/g, "");
    const tmpName = `\`${literalName}_tmp_drop\``;
    const colLower = columnName.toLowerCase();

    const allCols = await orm.getTableDescription(document);
    const keepCols = allCols.filter(f => f.name.toLowerCase() !== colLower);

    if (!keepCols.length) {
      throw new Error(`[OrphanManager] Cannot drop "${columnName}" — it is the only column`);
    }

    const colDefs = keepCols.map(f => {
      const col = `\`${f.name}\``;
      if (f.name.toLowerCase() === "id") {
        return `${col} INTEGER PRIMARY KEY AUTOINCREMENT`;
      }
      let def = `${col} ${f.type || "TEXT"}`;
      if (!f.nullable) def += " NOT NULL";
      if (f.default !== null && f.default !== undefined) def += ` DEFAULT ${f.default}`;
      return def;
    });

    const colList = keepCols.map(f => `\`${f.name}\``).join(", ");
    const createSQL = `CREATE TABLE IF NOT EXISTS ${tmpName} (${colDefs.join(", ")})`;

    try {
      await orm.qx().raw(`SAVEPOINT drop_col`);
      await orm.qx().raw(createSQL);
      await orm.qx().raw(`INSERT INTO ${tmpName} (${colList}) SELECT ${colList} FROM ${tableName}`);
      await orm.qx().raw(`DROP TABLE ${tableName}`);
      await orm.qx().raw(`ALTER TABLE ${tmpName} RENAME TO \`${literalName}\``);
      await orm.qx().raw(`RELEASE SAVEPOINT drop_col`);

      //console.log(`[OrphanManager] SQLite: recreated "${literalName}" without column "${columnName}"`);
    } catch (e) {
      //console.error(`[OrphanManager] SQLite recreation failed:`, e.message);
      try {
        await orm.qx().raw(`ROLLBACK TO SAVEPOINT drop_col`);
        await orm.qx().raw(`DROP TABLE IF EXISTS ${tmpName}`);
      } catch (_) { /* best-effort cleanup */ }
      throw e;
    }
  }

  async restoreOrphanColumn(orm, document, columnName) {
    await this.assertOrphan(orm, document, columnName);

    const dbFields = await orm.getTableDescription(document);
    const meta = dbFields.find(f => f.name.toLowerCase() === columnName.toLowerCase());

    if (!meta) {
      throw new Error(`[OrphanManager] Column "${columnName}" not found in DB for "${document}"`);
    }

    const restoredField = {
      element: "input",
      data: {
        name: meta.name,
        label: meta.name.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
        required: !meta.nullable ? 1 : 0,
        in_list_view: 0,
        format: this.sqlTypeToLooparlFormat(meta.type),
        ...(meta.default !== null && meta.default !== undefined
          ? { default_value: meta.default }
          : {}),
      },
    };

    await loopar.db.restoreOrphanField(document, restoredField);
    orm.invalidateColumnsCache(document);

    //console.log(`[OrphanManager] Queued restore of "${columnName}" into "${document}"`);

    return restoredField;
  }

  async reconcile(orm, tableName, orphans) {
    for (const orphan of orphans) {
      if (orm.isMySQLLike) {
        await this.relaxColumnMySQL(orm, tableName, orphan);
      } else if (orm.isPostgresLike) {
        await this.relaxColumnPostgres(orm, tableName, orphan);
      } else if (orm.isMSSQL) {
        await this.relaxColumnMSSQL(orm, tableName, orphan);
      } else if (orm.isOracle) {
        await this.relaxColumnOracle(orm, tableName, orphan);
      } else {
        // SQLite (or anything that didn't match) — no ALTER COLUMN, fall
        // back to dropping any index/UNIQUE so the column at least stops
        // refusing inserts on uniqueness; NOT NULL gets handled at insert
        // time via padOrphanColumns.
        await this.dropColumnIndexes(orm, tableName, orphan.name);
        //console.log(`[OrphanManager] "${orphan.name}": indexes dropped (NOT NULL handled via insert padding)`);
      }
    }
  }

  async dropColumnIndexes(orm, tableName, columnName) {
    if (orm.isSQLiteLike) {
      await this.dropSQLiteColumnIndexes(orm, tableName, columnName);
    } else {
      await this.dropConventionColumnIndexes(orm, tableName, columnName);
    }
  }

  async dropSQLiteColumnIndexes(orm, tableName, columnName) {
    const literalTable = tableName.replace(/[`"]/g, "");
    const colLower = columnName.toLowerCase();

    const indexes = await orm.qx().raw(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
      [literalTable]
    );

    const rows = Array.isArray(indexes) ? indexes : (indexes?.rows ?? []);
    const patterns = [
      new RegExp(`\\b${colLower}\\b`, "i"),
      new RegExp(`\`${colLower}\``, "i"),
      new RegExp(`"${colLower}"`, "i"),
      new RegExp(`'${colLower}'`, "i"),
    ];

    for (const idx of rows) {
      if (patterns.some(p => p.test(idx.sql || ""))) {
        try {
          await orm.qx().raw(`DROP INDEX IF EXISTS ${orm.escapeId(idx.name)}`);
          //console.log(`[OrphanManager] SQLite: dropped index "${idx.name}" (column: "${columnName}")`);
        } catch (e) {
          //console.error(`[OrphanManager] Could not drop index "${idx.name}":`, e.message);
        }
      }
    }
  }

  async dropConventionColumnIndexes(orm, tableName, columnName) {
    const safeTable = tableName.replace(/[`"]/g, "");
    const candidates = [
      `uniq_${safeTable}_${columnName}`,
      `uniq_${columnName}`,
      `idx_${safeTable}_${columnName}`,
      `idx_${columnName}`,
    ];

    if (orm.isMySQLLike) {
      for (const idx of candidates) {
        try { await orm.qx().raw(`ALTER TABLE ${tableName} DROP INDEX ${orm.escapeId(idx)}`); }
        catch (e) { /* tolerated */ }
      }
    } else if (orm.isMSSQL) {
      // MSSQL puts indexes under a table — DROP INDEX needs the qualified name
      for (const idx of candidates) {
        try { await orm.qx().raw(`DROP INDEX IF EXISTS ${orm.escapeId(idx)} ON ${tableName}`); }
        catch (e) { /* tolerated */ }
      }
    } else {
      // PG, Cockroach, Redshift, Oracle, others — global index namespace
      for (const idx of candidates) {
        try { await orm.qx().raw(`DROP INDEX IF EXISTS ${orm.escapeId(idx)}`); }
        catch (e) { /* tolerated */ }
      }
    }
  }

  async relaxColumnMySQL(orm, tableName, dbField) {
    const col     = orm.escapeId(dbField.name);
    const rawType = dbField.type || "VARCHAR(255)";
    try {
      await orm.qx().raw(`ALTER TABLE ${tableName} MODIFY COLUMN ${col} ${rawType} NULL`);
      //console.log(`[OrphanManager] MySQL relaxed "${dbField.name}"`);
    } catch (e) {
      //console.error(`[OrphanManager] Could not relax "${dbField.name}":`, e.message);
    }
    await this.dropColumnIndexes(orm, tableName, dbField.name);
  }

  async relaxColumnPostgres(orm, tableName, dbField) {
    const col = orm.escapeId(dbField.name);
    for (const cmd of [
      `ALTER TABLE ${tableName} ALTER COLUMN ${col} DROP NOT NULL`,
      `ALTER TABLE ${tableName} ALTER COLUMN ${col} DROP DEFAULT`,
    ]) {
      try { await orm.qx().raw(cmd); }
      catch (e) { /* already nullable / no default */ }
    }
    await this.dropColumnIndexes(orm, tableName, dbField.name);
    //console.log(`[OrphanManager] Postgres relaxed "${dbField.name}"`);
  }

  async relaxColumnMSSQL(orm, tableName, dbField) {
    const col     = orm.escapeId(dbField.name);
    const rawType = dbField.type || "NVARCHAR(255)";
    try {
      // MSSQL ALTER COLUMN must include the type even when only changing NULL.
      await orm.qx().raw(`ALTER TABLE ${tableName} ALTER COLUMN ${col} ${rawType} NULL`);
      //console.log(`[OrphanManager] MSSQL relaxed "${dbField.name}"`);
    } catch (e) {
      //console.error(`[OrphanManager] Could not relax "${dbField.name}":`, e.message);
    }
    await this.dropColumnIndexes(orm, tableName, dbField.name);
  }

  async relaxColumnOracle(orm, tableName, dbField) {
    const col = orm.escapeId(dbField.name);
    try {
      await orm.qx().raw(`ALTER TABLE ${tableName} MODIFY (${col} NULL)`);
      //console.log(`[OrphanManager] Oracle relaxed "${dbField.name}"`);
    } catch (e) { /* already nullable */ }
    await this.dropColumnIndexes(orm, tableName, dbField.name);
  }

  async assertOrphan(orm, document, columnName) {
    if (IMMUNE().has(columnName.toLowerCase())) {
      throw new Error(`Column "${columnName}" is protected and cannot be modified`);
    }
    const orphans  = await this.getOrphanColumns(orm, document);
    const isOrphan = orphans.some(o => o.name.toLowerCase() === columnName.toLowerCase());
    if (!isOrphan) {
      throw new Error(
        `Column "${columnName}" is either still active in the field structure ` +
        `or does not exist in the table`
      );
    }
  }

  async assertSQLiteDropColumnSupport(orm) {
    const result  = await orm.qx().raw("SELECT sqlite_version() as v");
    const rows = Array.isArray(result) ? result : (result?.rows ?? []);
    const version = parseFloat(rows[0]?.v || "0");

    if (version < 3.35) {
      throw new Error(
        `SQLite ${version} does not support DROP COLUMN (requires >= 3.35). ` +
        `Use Release to remove constraints without dropping the column.`
      );
    }
  }

  collectStructureCols(ref) {
    const cols = new Set();
    const fields = ref.__FIELDS__ || [];

    const collect = (field) => {
      if (field?.data?.name) cols.add(field.data.name.toLowerCase());
      if (Array.isArray(field.elements)) field.elements.forEach(collect);
    };

    fields.forEach(f => {
      if (typeof f === "string") cols.add(f.toLowerCase());
      else collect(f);
    });

    return cols;
  }

  sqlTypeToLooparlFormat(rawType) {
    const t = (rawType || "").toUpperCase();
    if (t.includes("INT")) return "INTEGER";
    if (t.includes("FLOAT") || t.includes("REAL")) return "FLOAT";
    if (t.includes("DOUBLE")) return "DOUBLE";
    if (t.includes("DECIMAL") || t.includes("NUMERIC")) return "DECIMAL";
    if (t.includes("BOOL")) return "BOOLEAN";
    if (t.includes("DATE") && t.includes("TIME")) return "DATETIME";
    if (t.includes("DATE")) return "DATE";
    if (t.includes("TIME")) return "TIME";
    if (t.includes("JSON")) return "JSON";
    if (t.includes("TEXT")) return "TEXT";
    return "VARCHAR";
  }
}

export const orphanManager = new OrphanManager();
