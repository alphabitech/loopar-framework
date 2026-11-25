'use strict';

/**
 * What in a tenant's data breaks referential integrity — read only, nothing
 * is changed (except `fixEmptyConnections`). Run it before enforcing: every
 * issue listed here is a write the ORM would refuse and a foreign key the
 * database couldn't create.
 *
 *   - orphans:    a connection value that names no record of its target
 *                 (`softDeleted`: the record exists but was deleted);
 *   - children:   child rows whose parent no longer exists;
 *   - empty:      connections stored as '' instead of NULL;
 *   - duplicates: target tables with two records under the same name (the
 *                 `name` UNIQUE key, which a foreign key needs, can't be added).
 */

import { loopar } from '../loopar.js';
import { multipleValues } from '../global/element-definition.js';
import { linkIndex } from './referential-integrity.js';

const SINGLE_VALUES = 'Document Single Values';
const SAMPLE = 10;

const isAudited = (entity) => !!loopar.getRef(entity, false)?.is_audited;
const tableOk = async (db, table) => !!table && await db.hasTable(table);

async function existing(db, target, names) {
  if (!names.length) return { live: new Set(), deleted: new Set() };
  const cols = isAudited(target) ? ['name', '__deleted_at__'] : ['name'];
  const rows = await db.qx()(target).whereIn('name', names).select(cols);
  const live = new Set(), deleted = new Set();
  for (const r of rows) (r.__deleted_at__ ? deleted : live).add(String(r.name));
  return { live, deleted };
}

/** Builds the report for the current tenant (`db`: loopar.db by default). */
export async function integrityReport(db = loopar.db) {
  const { outgoing, childParents } = linkIndex();
  const report = { orphans: [], children: [], empty: [], duplicates: [] };
  const targets = new Set();

  for (const [, links] of outgoing) for (const link of links) targets.add(link.target);

  for (const ref of Object.values(loopar.getRefs())) {
    const links = outgoing.get(loopar.utils.toEntityKey(ref.__NAME__));
    if (!links || ref.is_virtual) continue;
    for (const link of links) {
      if (!(await tableOk(db, link.target))) continue;
      if (ref.is_single) {
        await singleIssues(db, ref.__NAME__, link, report);
      } else if (await tableOk(db, ref.__NAME__)) {
        await tableIssues(db, ref.__NAME__, link, report);
      }
    }
  }

  for (const [childKey, parents] of childParents) {
    const child = loopar.getRef(childKey, false)?.__NAME__;
    if (!child || !(await tableOk(db, child))) continue;
    for (const parent of parents) {
      if (!(await tableOk(db, parent))) continue;
      const rows = await db.qx()({ c: child })
        .leftJoin({ p: parent }, 'c.parent_id', 'p.id')
        .where('c.parent_document', parent)
        .whereNull('p.id')
        .select('c.name', 'c.parent_id');
      if (rows.length) report.children.push({ child, parent, count: rows.length, sample: rows.slice(0, SAMPLE).map((r) => r.name) });
    }
  }

  for (const target of targets) {
    if (!(await tableOk(db, target))) continue;
    const rows = await db.qx()(target).select('name').count({ n: '*' }).groupBy('name').havingRaw('count(*) > 1');
    if (rows.length) report.duplicates.push({ entity: target, count: rows.length, sample: rows.slice(0, SAMPLE).map((r) => r.name) });
  }

  report.total = report.orphans.reduce((n, o) => n + o.count, 0)
    + report.children.reduce((n, c) => n + c.count, 0)
    + report.empty.reduce((n, e) => n + e.count, 0)
    + report.duplicates.reduce((n, d) => n + d.count, 0);
  return report;
}

async function tableIssues(db, source, link, report) {
  const col = link.field;
  if (!(await db.qx().schema.hasColumn(source, col))) return;

  const empty = await db.qx()(source).where(col, '').count({ n: '*' }).first();
  if (Number(empty?.n) > 0) report.empty.push({ entity: source, field: col, count: Number(empty.n) });

  if (link.multiple) {
    const rows = await db.qx()(source).whereNotNull(col).whereNot(col, '').select('name', col);
    const names = [...new Set(rows.flatMap((r) => multipleValues(r[col])))];
    const { live, deleted } = await existing(db, link.target, names);
    const bad = rows.filter((r) => multipleValues(r[col]).some((v) => !live.has(v)));
    if (bad.length) {
      report.orphans.push({
        entity: source, field: col, target: link.target, multiple: true, count: bad.length,
        softDeleted: names.filter((n) => deleted.has(n)).length,
        sample: bad.slice(0, SAMPLE).map((r) => ({ name: r.name, value: r[col] })),
      });
    }
    return;
  }

  const audited = isAudited(link.target);
  const rows = await db.qx()({ s: source })
    .leftJoin({ t: link.target }, `s.${col}`, 't.name')
    .whereNotNull(`s.${col}`).whereNot(`s.${col}`, '')
    .where((q) => {
      q.whereNull('t.id');
      if (audited) q.orWhereNotNull('t.__deleted_at__');
    })
    .select('s.name', { value: `s.${col}` }, ...(audited ? [{ deleted: 't.__deleted_at__' }] : []));
  if (rows.length) {
    report.orphans.push({
      entity: source, field: col, target: link.target, count: rows.length,
      softDeleted: rows.filter((r) => r.deleted).length,
      sample: rows.slice(0, SAMPLE).map((r) => ({ name: r.name, value: r.value })),
    });
  }
}

async function singleIssues(db, single, link, report) {
  if (!(await tableOk(db, SINGLE_VALUES))) return;
  const row = await db.qx()(SINGLE_VALUES).where({ document: single, field: link.field }).first('value');
  const value = row?.value;
  if (value === '') report.empty.push({ entity: single, field: link.field, count: 1, single: true });
  const names = link.multiple ? multipleValues(value) : (value ? [String(value)] : []);
  if (!names.length) return;
  const { live } = await existing(db, link.target, names);
  const missing = names.filter((n) => !live.has(n));
  if (missing.length) {
    report.orphans.push({ entity: single, field: link.field, target: link.target, single: true, count: 1, sample: [{ name: single, value: missing.join(', ') }] });
  }
}

/** Stores every '' connection as NULL. Returns the number of rows changed. */
export async function fixEmptyConnections(db = loopar.db) {
  let changed = 0;
  for (const ref of Object.values(loopar.getRefs())) {
    const links = linkIndex().outgoing.get(loopar.utils.toEntityKey(ref.__NAME__));
    if (!links || ref.is_virtual || ref.is_single || !(await tableOk(db, ref.__NAME__))) continue;
    for (const { field, required } of links) {
      if (required || !(await db.qx().schema.hasColumn(ref.__NAME__, field))) continue;
      changed += Number(await db.qx()(ref.__NAME__).where(field, '').update({ [field]: null })) || 0;
    }
  }
  return changed;
}
