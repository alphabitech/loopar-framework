/**
 * Draft store — unsaved form work persisted in the browser so a reload (a new
 * deploy, a crash, a closed tab) never costs the user what they typed.
 *
 * Record (one per user + document):
 *   { v, site, user, entity, name, path, base, reason, savedAt, build, values }
 *     values  only the DIRTY fields, so a restore merges over fresh server
 *             data instead of overwriting fields someone else changed.
 *     base    the record's __updated_at__ when editing began: if the server
 *             copy moved since, the restore warns about a possible conflict.
 *     reason  'edit' (debounced autosave) | 'update' | 'chunk' (flushed right
 *             before an app-triggered reload).
 *
 * Policy (privacy and robustness):
 *   - authenticated users only, keyed by site + user: drafts never cross
 *     accounts, and a DIFFERENT user signing in purges the others' drafts;
 *   - secrets are never written (password-like fields, files — see
 *     isSensitiveField), and values are JSON-sanitized (no File/Blob/functions);
 *   - expire after DRAFT_TTL; at most MAX_DRAFTS kept (oldest evicted);
 *     a record over MAX_DRAFT_CHARS is skipped rather than stored partially;
 *   - every storage access is try/catch: private mode or a full quota degrade
 *     to "no drafts", never to a broken form.
 */

export const DRAFT_PREFIX = "loopar:draft:v1:";
export const DRAFT_VERSION = 1;
export const DRAFT_TTL = 72 * 60 * 60 * 1000;
export const MAX_DRAFTS = 50;
export const MAX_DRAFT_CHARS = 256 * 1024;

// Whole words within snake/kebab/camel names: matches new_pwd, access_token,
// apiKey, card_number — not passenger, compass or tokenizer.
const SENSITIVE_NAME = /password|(^|[^a-z])(pass(wd|phrase|code)?|pwd|secret|token|api_?key|private_?key|pin|otp|mfa|2fa|cvv|cvc|card_?number|credit_?card)([^a-z]|$)/i;

function defaultStorage() {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

/** A field whose value must never reach browser storage. */
export function isSensitiveField(el, fileElements = []) {
  const data = el?.data || {};
  const tags = [el?.element, data.format, data.type, data.inputType].map(v => String(v || "").toLowerCase());
  if (tags.includes("password")) return true;
  if (fileElements.includes(el?.element)) return true;
  return SENSITIVE_NAME.test(String(data.name || ""));
}

/**
 * Walk a form STRUCTURE: every field name, the subset that is sensitive, and
 * the subset that is `selfManaged` — inputs that persist their own unsaved
 * work (`ownsDraft(el)` true, e.g. the designer). One owner per field: the
 * form draft never stores, restores or reports those.
 */
export function collectFields(structure = [], fileElements = [], ownsDraft = () => false) {
  const all = new Set();
  const sensitive = new Set();
  const selfManaged = new Set();
  const walk = (els) => {
    for (const el of els || []) {
      const name = el?.data?.name;
      if (typeof name === "string" && name) {
        all.add(name);
        if (isSensitiveField(el, fileElements)) sensitive.add(name);
        if (ownsDraft(el)) selfManaged.add(name);
      }
      if (el?.elements?.length) walk(el.elements);
    }
  };
  walk(structure);
  return { all, sensitive, selfManaged };
}

/** JSON-safe copy: drops File/Blob/FileList, functions and undefined. */
export function sanitizeValue(value) {
  const isBinary = (v) =>
    (typeof File !== "undefined" && v instanceof File) ||
    (typeof Blob !== "undefined" && v instanceof Blob) ||
    (typeof FileList !== "undefined" && v instanceof FileList);
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => (isBinary(v) || typeof v === "function" ? undefined : v)));
  } catch {
    return undefined;
  }
}

export function draftKey({ site, user, entity, name, path }) {
  const id = name ? `doc:${name}` : `new:${path || ""}`;
  return DRAFT_PREFIX + [site || "-", user, entity, id].map(encodeURIComponent).join(":");
}

export function createDraftStore(storage = defaultStorage(), now = () => Date.now()) {
  const keys = () => {
    if (!storage) return [];
    const out = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(DRAFT_PREFIX)) out.push(k);
      }
    } catch { /* storage unavailable */ }
    return out;
  };

  const parse = (raw) => {
    try {
      const r = JSON.parse(raw);
      return r && r.v === DRAFT_VERSION && r.values && typeof r.values === "object" ? r : null;
    } catch { return null; }
  };

  const remove = (key) => { try { storage?.removeItem(key); } catch { /* ignore */ } };

  const read = (key) => {
    if (!storage) return null;
    let raw = null;
    try { raw = storage.getItem(key); } catch { return null; }
    if (raw == null) return null;
    const record = parse(raw);
    if (!record || now() - (record.savedAt || 0) > DRAFT_TTL) {
      remove(key);
      return null;
    }
    return record;
  };

  /** Oldest-first list of [key, savedAt] (unparseable entries count as oldest). */
  const byAge = () => keys()
    .map((k) => { let r = null; try { r = parse(storage.getItem(k)); } catch { /* */ } return [k, r?.savedAt || 0]; })
    .sort((a, b) => a[1] - b[1]);

  const evict = (count) => byAge().slice(0, count).forEach(([k]) => remove(k));

  const write = (key, record) => {
    if (!storage) return false;
    const full = { ...record, v: DRAFT_VERSION, savedAt: now() };
    let raw;
    try { raw = JSON.stringify(full); } catch { return false; }
    if (raw.length > MAX_DRAFT_CHARS) return false;

    const existing = keys();
    if (!existing.includes(key) && existing.length >= MAX_DRAFTS) evict(existing.length - MAX_DRAFTS + 1);

    try {
      storage.setItem(key, raw);
      return true;
    } catch {
      // Quota: free the oldest few drafts and try once more.
      evict(5);
      try { storage.setItem(key, raw); return true; } catch { return false; }
    }
  };

  /**
   * Housekeeping at boot: drop expired/invalid drafts and — when someone is
   * signed in — every draft of this site that belongs to another user.
   */
  const prune = ({ site, user } = {}) => {
    for (const k of keys()) {
      let r = null;
      try { r = parse(storage.getItem(k)); } catch { /* */ }
      const expired = !r || now() - (r.savedAt || 0) > DRAFT_TTL;
      const foreign = user && r && (r.site || "-") === (site || "-") && r.user !== user;
      if (expired || foreign) remove(k);
    }
  };

  return { read, write, remove, prune, keys };
}

export const draftStore = createDraftStore();
export default draftStore;
