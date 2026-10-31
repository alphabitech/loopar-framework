/**
 * useFormDraft — autosave + restore of unsaved form work (see draft-store).
 *
 * Lifecycle, tied to react-hook-form's dirty state so the save flow needs no
 * changes:
 *   mount    → a stored draft for this user+document is offered back:
 *              silently when the reload was the app's own (new version) and
 *              nothing conflicts, otherwise through a confirm (restore/discard).
 *              Until that decision, autosave stays off so the draft can't be
 *              overwritten by the pristine form.
 *   editing  → debounced write of the DIRTY fields only.
 *   saved    → FormController.send resets the form (keepValues) → not dirty →
 *              the draft is removed (plus an explicit afterSave removal).
 *   unload / app-triggered reload / unmount → synchronous flush.
 *
 * Only for authenticated users on a saveable document (Entity + meta.action),
 * never in the auth workspace, never for sensitive fields. A form can opt out
 * with `docRef.drafts = false`.
 */
import { useEffect, useMemo, useRef } from "react";
import { loopar } from "loopar";
import Emitter from "@services/emitter/emitter";
import { elementsDict } from "@global/element-definition";
import { draftStore, draftKey, collectFields, sanitizeValue } from "./draft-store.js";
import { versionWatch } from "./version-watch.js";

const AUTOSAVE_DELAY = 500;

/** Emitted when the user discards a form draft; self-managed inputs (designer) drop theirs too. */
export const FORM_DRAFT_DISCARD = "form-draft:discard";

const ownsDraft = (el) => !!elementsDict[el?.element]?.def?.ownsDraft;

function draftIdentity(docRef) {
  if (typeof window === "undefined" || !docRef || docRef.drafts === false) return null;
  const Document = docRef.Document || {};
  const entity = Document.Entity?.name;
  if (!entity || !Document.meta?.action) return null;
  if (loopar.workspace === "auth") return null;
  const user = loopar.user?.name || globalThis.__user__;
  if (!user) return null;
  const name = Document.isNew ? null : (docRef.__DOCUMENT_NAME__ || null);
  return { site: globalThis.__site__ || null, user, entity, name, path: window.location.pathname };
}

function ago(ts) {
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (min < 1) return "moments ago";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function useFormDraft({ form, docRef, STRUCTURE, watchedValues }) {
  // Read during render so react-hook-form keeps these proxied fields updated.
  const { isDirty, dirtyFields } = form.formState;

  const id = draftIdentity(docRef);
  const key = id ? draftKey(id) : null;

  const fields = useMemo(() => {
    const fileElements = [globalThis.IMAGE_INPUT, globalThis.FILE_INPUT].filter(Boolean);
    const f = collectFields(STRUCTURE || [], fileElements, ownsDraft);
    // Never stored nor restored by the form draft.
    f.skip = new Set([...f.sensitive, ...f.selfManaged]);
    return f;
  }, [STRUCTURE]);

  const readyRef = useRef(false);
  const baseRef = useRef(form.formState.defaultValues?.__updated_at__ ?? null);

  const persist = (reason = "edit") => {
    if (!id || !readyRef.current) return;
    const values = {};
    for (const name of Object.keys(form.formState.dirtyFields || {})) {
      if (fields.skip.has(name)) continue;
      const v = sanitizeValue(form.getValues(name));
      if (v !== undefined) values[name] = v;
    }
    if (!Object.keys(values).length) {
      draftStore.remove(key);
      return;
    }
    draftStore.write(key, {
      ...id,
      base: baseRef.current,
      reason,
      build: versionWatch.latest || versionWatch.booted,
      values,
    });
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // Restore (once per document key).
  useEffect(() => {
    readyRef.current = false;
    if (!key) return;

    const draft = draftStore.read(key);
    if (!draft) { readyRef.current = true; return; }

    const restorable = {};
    const dropped = [];
    for (const [name, value] of Object.entries(draft.values)) {
      if (fields.skip.has(name)) continue; // owned elsewhere (or a secret): ignore silently
      if (fields.all.has(name)) restorable[name] = value;
      else dropped.push(name);
    }
    if (!Object.keys(restorable).length) {
      draftStore.remove(key);
      readyRef.current = true;
      return;
    }

    const current = baseRef.current;
    const conflict = !!(draft.base && current && String(draft.base) !== String(current));

    const apply = () => {
      for (const [name, value] of Object.entries(restorable)) {
        form.setValue(name, value, { shouldDirty: true, shouldTouch: true });
      }
      readyRef.current = true;
      persistRef.current("edit");
      loopar.notify({
        type: conflict ? "warning" : "success",
        title: "Unsaved changes restored",
        message: conflict
          ? "This record changed on the server after you started editing. Review before saving."
          : "Your unsaved changes were restored. Save when ready.",
      });
      if (dropped.length) {
        loopar.notify({
          type: "warning",
          title: "Some changes could not be restored",
          message: `These fields no longer exist in this version: ${dropped.join(", ")}`,
        });
      }
    };
    const discard = () => {
      draftStore.remove(key);
      // "Discard" means ALL unsaved work on this record: self-managed inputs
      // may already have restored their own draft on mount — put those fields
      // back to the server value and tell their owners to drop their drafts.
      for (const name of fields.selfManaged) {
        if (form.getFieldState(name).isDirty) form.resetField(name);
      }
      Emitter.emit(FORM_DRAFT_DISCARD, { entity: id.entity, name: docRef?.Document?.name || null });
      readyRef.current = true;
    };

    // Let fields register first; then decide.
    const timer = setTimeout(() => {
      if (versionWatch.lastReload() && !conflict) return apply();
      // Discarding is the destructive choice → slide-to-confirm (no loss by a
      // stray click). Restore is the plain button, and closing the dialog
      // (X / Esc / overlay) also restores — confirm() maps a close without an
      // answer to onCancel: the safe default keeps the work.
      loopar.confirm({
        type: "confirm",
        title: "Unsaved changes found",
        content:
          `You have unsaved changes to this ${id.entity} from ${ago(draft.savedAt)}.` +
          (conflict ? " The record was changed on the server since then — review before saving." : "") +
          " Restore them, or slide to discard them for good.",
        slide: true,
        slideText: "Slide to discard changes",
        slideConfirmedText: "Discarded",
        buttons: [
          { name: "ok", text: "Discard", dismiss: true },
          { name: "cancel", text: "Restore", variant: "primary", dismiss: true },
        ],
        // ok/cancel passed as arguments (not in this object) so confirm()
        // wraps them single-resolution: the close that follows a discard can
        // never also trigger a restore.
      }, discard, apply);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Debounced autosave on every change (and when the dirty state flips, e.g. after a save).
  useEffect(() => {
    if (!key || !readyRef.current) return;
    const timer = setTimeout(() => persistRef.current("edit"), AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [key, watchedValues, isDirty, dirtyFields]);

  // Synchronous flushes: app-triggered reload, tab close/hide, leaving the view.
  useEffect(() => {
    if (!key) return;
    const offReload = versionWatch.beforeReload((reason) => persistRef.current(reason || "update"));
    const onHide = () => persistRef.current("edit");
    window.addEventListener("pagehide", onHide);
    const offSaved = docRef?.onFormEvent?.("afterSave", () => draftStore.remove(key));
    return () => {
      offReload();
      offSaved?.();
      window.removeEventListener("pagehide", onHide);
      persistRef.current("edit");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export default useFormDraft;
