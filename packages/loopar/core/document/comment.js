'use strict';

import { Helpers, coerceDocStatus, DOC_STATUS } from "../../index.js";

const COMMENT_TABLE = "Comment";

/**
 * Insert a comment into the unified `Comment` table.
 *
 * Threading is via `parent` (null = root). The target is polymorphic:
 * (document, documentName) can point at ANY entity record — including a
 * "Document History" audit row, which is how an audit event gets commented
 * without polluting the (immutable) audit log itself.
 *
 * @returns {Promise<string|null>} the new comment's name, or null if invalid.
 */
async function add(loopar, {
  document,
  documentName,
  comment,
  parent = null,
  status,
  guest_name = null,
  guest_email = null,
} = {}) {
  if (!comment || !documentName || !document) return null;

  const name = Helpers.randomString(15);
  await loopar.db.insertRow(COMMENT_TABLE, {
    name,
    document,
    document_name: documentName,
    parent: parent || null,
    // A named guest is the author (a customer acting through a link), whoever's session it runs in.
    user: guest_name ? null : (loopar.currentUser?.name ?? null),
    guest_name,
    guest_email,
    comment,
    status: coerceDocStatus(status),
    created_at: new Date().toISOString(),
  });

  return name;
}

export function setupComments(loopar) {
  loopar.comments = {
    add: (opts) => add(loopar, opts),
    STATUS: DOC_STATUS,
  };
}
