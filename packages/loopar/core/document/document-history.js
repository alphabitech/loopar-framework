'use strict';

import { Helpers, loopar } from "../../index.js";
import { isEncryptedSecret } from '../global/secrets.js';

const isSecretValue = (v) => isEncryptedSecret(v) || (typeof v === 'string' && v.startsWith('$argon2'));

const HISTORY_TABLE = "Document History";

// Entities that ARE auditable (they get framework columns: __deleted_at__,
// __document_status__, …) but must NOT be logged here — logging a comment's
// own create/update would be noise and risks history-of-comments recursion.
// (Decoupled from isAuditableEntity, which gates the columns.)
const NO_HISTORY_LOG = new Set(["Comment"]);

// Pure audit actions. Comments are NOT here — they live in the `Comment`
// entity (see core/document/comment.js), keeping this log immutable.
const ACTIONS = Object.freeze({
  CREATED: "Created",
  UPDATED: "Updated",
  DELETED: "Deleted",
  RESTORED: "Restored",
});


function isTrackable(loopar, document) {
  if (!document) return false;
  if (document === HISTORY_TABLE) return false; // no self-recursion
  if (NO_HISTORY_LOG.has(document)) return false; // auditable, but not logged
  const ref = loopar.getRef?.(document);
  if (!ref) return false;
  // The ref already carries the auditability decision computed at build time
  // (builder.js runs isAuditableEntity with the correct {name, is_audited}
  // shape, so exclusions like "Page View" are already applied → is_audited:0).
  // Passing the ref BACK into isAuditableEntity was the bug: it reads e.name
  // (ref has __NAME__) and e.is_audited === false (ref has 0|1), so nothing
  // was ever excluded and every Page View was logged. Trust the ref flag.
  return ref.is_audited === 1;
}

/**
 * Compute a per-field diff between two row snapshots. Returns null
 * when nothing changed (so the listener can skip writing a no-op
 * Update row).
 *
 * Audit columns are intentionally excluded — every Update changes
 * __updated_at__, including that in the diff would make every entry
 * look the same and drown the real changes in noise.
 */
function buildDiff(before, after) {
  if (!before || !after) return null;
  const SKIP = new Set([
    "__created_at__", "__updated_at__", "__deleted_at__", "__document_status__",
    "__created_by__",
  ]);
  const diff = {};
  for (const key of Object.keys(after)) {
    if (SKIP.has(key)) continue;
    const a = after[key];
    const b = before[key];

    if (JSON.stringify(a) !== JSON.stringify(b)) {
      // Secrets (encrypted or hashed password fields) must not leak into the
      // history timeline: record that they changed, not their values.
      diff[key] = (isSecretValue(a) || isSecretValue(b))
        ? { before: b ? '********' : null, after: a ? '********' : null }
        : { before: b ?? null, after: a ?? null };
    }
  }
  return Object.keys(diff).length ? diff : null;
}

function buildHistoryRow(loopar, { document, doc, action, extras = {} }) {
  // Writes of an app install/update are attributed to whoever ran it, but
  // they are not that person's work: tagged so views like the desk's
  // "recent documents" can leave them out.
  if (loopar.installing) {
    extras = { ...extras, metadata: { ...(extras.metadata || {}), source: 'installer', app: loopar.installingApp } };
  }
  return {
    name: Helpers.randomString(15),
    document,
    document_name: doc?.name ?? doc?.data?.name ?? null,
    action,
    user: loopar.currentUser?.name ?? null,
    event_at: new Date().toISOString(),
    diff: extras.diff ? JSON.stringify(extras.diff)     : null,
    metadata: extras.metadata ? JSON.stringify(extras.metadata) : null,
  };
}

async function writeHistory(loopar, payload) {
  try {
    await loopar.db.insertRow(HISTORY_TABLE, payload);
  } catch (err) {
    console.error(
      `[history] failed to write ${payload.action} for ${payload.document}:` +
      `${payload.document_name}: ${err.message}`
    );
  }
}

/**
 * Wire the listeners. Called once at boot, after the ORM is
 * instantiated. The KnexORM bus is static, so we register against
 * the constructor (KnexORM.on, not this.db.on).
 */
let __historyWired = false;

export function setupDocumentHistory(_boot, KnexORM) {
  if (!__historyWired) {
    __historyWired = true;

  KnexORM.on("afterCreate", async ({ document, doc }) => {
    if (!isTrackable(loopar, document)) return;
    const action = doc?.__restored__ ? ACTIONS.RESTORED : ACTIONS.CREATED;
    delete doc.__restored__;
    await writeHistory(loopar, buildHistoryRow(loopar, { document, doc, action }));
  });

  KnexORM.on("afterUpdate", async ({ document, doc, before }) => {
    if (!isTrackable(loopar, document)) return;
    const diff = buildDiff(before, doc?.data ?? doc);
    if (!diff) return;
    await writeHistory(loopar, buildHistoryRow(loopar, {
      document, doc: doc?.data ?? doc, action: ACTIONS.UPDATED, extras: { diff },
    }));
  });

  KnexORM.on("afterDelete", async ({ document, doc }) => {
    if (!isTrackable(loopar, document)) return;
    await writeHistory(loopar, buildHistoryRow(loopar, {
      document, doc, action: ACTIONS.DELETED,
    }));
  });
  }
  
  _boot.history = {
    ACTIONS,
  };
}

export { ACTIONS };
