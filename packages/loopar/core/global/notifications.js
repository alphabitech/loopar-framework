'use strict';

import { KnexORM } from "db-env";
import { loopar as current } from "../loopar.js";

/**
 * In-app notifications: a row per recipient in `Notification`, pushed live to
 * the user's realtime room (`user:<name>`, event `notification`) — the desk's
 * bell shows it at once.
 *
 *   await loopar.notifications.send({
 *     users: "jane@x.com" | [...],          // recipients (the sender is skipped)
 *     subject: "Quote CQ-0001: Approved",
 *     message: "Customer approved",
 *     document: "Quote", documentName: "CQ-0001",   // what it links to
 *   });
 *
 * A second notification for the same record, to the same user and from the
 * same sender, within a few seconds (a transition and its comment) joins the
 * first, unread one.
 *
 * Produced by the framework: workflow transitions and comments made by
 * someone else on a record notify its owner (`__created_by__`).
 */

const ENTITY = "Notification";
const COALESCE_MS = 15000;
const clip = (text, n) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

async function send(loopar, { users, subject, message = "", document = null, documentName = null, from } = {}) {
  if (!loopar.getRef?.(ENTITY, false)) return [];
  const sender = from === undefined ? (loopar.auth?.user?.() ?? null) : from;
  const recipients = [...new Set([users].flat().filter(Boolean))].filter((u) => u !== sender);
  const out = [];

  for (const user of recipients) {
    try {
      const since = new Date(Date.now() - COALESCE_MS).toISOString();
      const recent = document && documentName
        ? await loopar.db.qx()(ENTITY)
            .where({ user, document, document_name: documentName, is_read: 0 })
            .where((b) => (sender ? b.where({ from_user: sender }) : b.whereNull("from_user")))
            .where("created_at", ">=", since)
            .orderBy("id", "desc").first()
        : null;

      let row;
      if (recent) {
        row = { ...recent, subject: clip(subject, 140) || recent.subject, message: clip([recent.message, message].filter(Boolean).join(" · "), 500) };
        await loopar.db.qx()(ENTITY).where({ id: recent.id }).update({ subject: row.subject, message: row.message });
      } else {
        row = {
          name: loopar.utils.randomString?.(15) ?? Math.random().toString(36).slice(2, 17),
          user, subject: clip(subject, 140), message: clip(message, 500),
          document, document_name: documentName, from_user: sender,
          is_read: 0, created_at: new Date().toISOString(),
        };
        await loopar.db.insertRow(ENTITY, row);
      }
      loopar.emitTo(`user:${user}`, "notification", {
        name: row.name, subject: row.subject, message: row.message,
        document: row.document, document_name: row.document_name, from_user: row.from_user,
        created_at: row.created_at, coalesced: !!recent,
      });
      out.push(row.name);
    } catch (e) {
      console.warn(`[notifications] could not notify ${user}:`, e.message);
    }
  }
  return out;
}

/** Who owns record `name` of `document` (its creator), or null. */
export async function ownerOf(loopar, document, name) {
  if (!document || !name || !loopar.getRef?.(document, false)) return null;
  try {
    return await loopar.db.getValue(document, "__created_by__", name, { ifNotFound: null });
  } catch {
    return null;
  }
}

/** A comment by someone else on a record tells the record's owner. */
async function onComment({ doc } = {}) {
  const loopar = current;
  if (!doc?.document || !doc?.document_name || doc.document === ENTITY) return;
  const owner = await ownerOf(loopar, doc.document, doc.document_name);
  if (!owner || owner === doc.user) return;
  const author = doc.user || doc.guest_name || "Someone";
  await send(loopar, {
    users: owner,
    subject: `${doc.document} ${doc.document_name}`,
    message: `${author}: ${doc.comment}`,
    document: doc.document, documentName: doc.document_name,
    from: doc.user || null,
  });
}

let wired = false;

export function setupNotifications(loopar) {
  loopar.notifications = {
    send: (opts) => send(loopar, opts),
    ownerOf: (document, name) => ownerOf(loopar, document, name),
  };
  if (wired) return;
  wired = true;
  KnexORM.on("afterCreate:Comment", (payload) => {
    onComment(payload).catch((e) => console.warn("[notifications] comment:", e.message));
  });
}
