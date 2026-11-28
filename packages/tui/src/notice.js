/**
 * Notices: errors and the outcome of important operations in a modal with an
 * OK button — a status line at the bottom of a big terminal goes unseen.
 * Routine chatter (refreshed, cancelled, the backup count while browsing)
 * stays in the status line only.
 *
 * The status line keeps the last notice too, after it is closed.
 * Keys: Enter / Esc / Space close it · Ctrl+C quits.
 */
import { state } from "./state.js";

const TITLES = { error: "Error", warn: "Warning", ok: "Done", info: "Notice" };

/** Show `text` in a modal. `kind`: error | warn | ok | info. The caller renders. */
export function notice(text, kind = "info", title = null) {
  const msg = String(text ?? "").trim() || (kind === "error" ? "Something went wrong" : "");
  state.message = msg;
  state.messageKind = kind === "warn" ? "error" : kind;
  state.notice = { text: msg, kind, title: title || TITLES[kind] || TITLES.info };
}

/** An error's message, for notices. */
export const errText = (err) => err?.message || String(err);

export function closeNotice() {
  state.notice = null;
}
