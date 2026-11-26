'use strict';

import { createContext, useContext, useCallback, useRef } from "react";
import loopar, { useRealtime } from "loopar";

let _permSet = null;
let _publicSet = new Set();
let _deniedSet = new Set();
// permKey -> 'own' | 'portal' for grants narrowed to the user's own records
// or to their portal subjects' records (a granted key absent here is 'all').
// Mirrors PermissionManager.scope().
let _scopes = {};
let _userId = null;
// Whether a provider already initialized the sets on this page.
let _ready = false;

const OWNER_FIELD = '__created_by__';

/** Public keys arrive packed as `[[docs], [actions]]` pairs (PermissionManager `compactKeys`). */
function expandKeys(groups) {
  const keys = new Set();
  for (const [docs, actions] of groups ?? []) {
    for (const doc of docs) for (const action of actions) keys.add(`${doc}:${action}`);
  }
  return keys;
}

function initSets({ private: priv, public: pub, denied = [], scopes = {} } = {}) {
  _permSet = priv === null ? null : new Set(priv ?? []);
  _publicSet = expandKeys(pub);
  _deniedSet = new Set(denied);
  _scopes = scopes ?? {};
}

const normDoc = d => String(d ?? '').toLowerCase().replaceAll(" ", "");
const normAct = a => String(a ?? '').toLowerCase();

/**
 * Effective scope of (document, action) for the current user:
 * 'all' | 'own' | 'portal' | null (not permitted). Widest scope wins, like
 * the server ('portal' over 'own').
 */
function permissionScope(document, action) {
  const doc = normDoc(document);
  const act = normAct(action);
  const key = `${doc}:${act}`;

  if (_publicSet.has(key)) return 'all';
  // Denied wins over the Administrator too: the server denies app-source
  // writes to everyone in production (core/auth/source-lock.js).
  if (_deniedSet.has(key)) return null;
  if (_permSet === null) return 'all';          // Administrator

  let result = null;
  for (const k of ['*:*', `${doc}:*`, `*:${act}`, key]) {
    if (!_permSet.has(k)) continue;
    const s = ['own', 'portal'].includes(_scopes[k]) ? _scopes[k] : 'all';
    if (s === 'all') return 'all';
    if (result !== 'portal') result = s;
  }
  return result;
}

function checkPermission(document, action) {
  return permissionScope(document, action) !== null;
}

/**
 * Can the current user perform `action` on this specific `record`?
 * Cosmetic only (hide buttons) — the server is the source of truth.
 * `ownerField` lets an entity that resolves ownership through another
 * column (e.g. 'customer') pass it; `owner` overrides the comparison value.
 */
function checkRecordPermission(document, action, record, { ownerField = OWNER_FIELD, owner } = {}) {
  const scope = permissionScope(document, action);
  if (scope === null) return false;
  if (scope === 'all') return true;
  // The server only hands a 'portal' grant the records of the user's subjects.
  if (scope === 'portal') return true;
  const value = owner ?? record?.[ownerField];
  return value != null && value === _userId;
}

const AuthContext = createContext(null);

export function AuthProvider({ permissions: initialPermissions, userId, children }) {
  const initialized = useRef(false);
  if (!initialized.current) {
    // The permission sets are module state shared by the whole page. In the
    // browser, a later provider mounted without permissions (a modal
    // mini-workspace) reads the page's sets: initializing from nothing would
    // deny everything (`award`/`canOn` false) on the base page until the next
    // reload. The server always initializes: its module state outlives a request.
    if (typeof window === "undefined" || initialPermissions !== undefined || !_ready) {
      _userId = userId ?? null;
      initSets(initialPermissions);
      _ready = true;
    }
    initialized.current = true;
  }

  const refreshPermissions = useCallback(async () => {
    try {
      const data = await loopar.call(
        "Role Permission Manager",
        "getOwnPermissions",
        { query: { user: userId } }
      );
      initSets(data);
    } catch (err) {

      console.error("[AuthProvider] Failed to refresh permissions:", err);
    }
  }, [userId]);

  // One read per burst of events: a read already queued covers later events,
  // and one in flight is followed by a single re-read.
  const refreshState = useRef({ timer: null, running: false, again: false });
  const scheduleRefresh = useCallback(() => {
    const st = refreshState.current;
    if (st.running) { st.again = true; return; }
    if (st.timer) return;
    st.timer = setTimeout(async () => {
      st.timer = null;
      st.running = true;
      await refreshPermissions();
      st.running = false;
      if (st.again) { st.again = false; scheduleRefresh(); }
    }, 300);
  }, [refreshPermissions]);

  useRealtime(`permissionsChanged`, scheduleRefresh);

  const award = useCallback((document, action) => {
    return checkPermission(document, action);
  }, []);

  const scope = useCallback((document, action) => {
    return permissionScope(document, action);
  }, []);

  const canOn = useCallback((document, action, record, opts) => {
    return checkRecordPermission(document, action, record, opts);
  }, []);

  return (
    <AuthContext.Provider value={{ award, scope, canOn, userId }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export { checkPermission as award, permissionScope as scope, checkRecordPermission as canOn };