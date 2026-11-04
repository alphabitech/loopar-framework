'use strict';

import { createContext, useContext, useCallback, useRef } from "react";
import loopar, { useRealtime } from "loopar";

let _permSet = null;
let _publicSet = new Set();
let _deniedSet = new Set();
// permKey -> 'own' | 'customer' for grants narrowed to the user's own records
// or to their customers' records (a granted key absent here is 'all').
// Mirrors PermissionManager.scope().
let _scopes = {};
let _userId = null;

const OWNER_FIELD = '__created_by__';

function initSets({ private: priv, public: pub, denied = [], scopes = {} } = {}) {
  _permSet = priv === null ? null : new Set(priv ?? []);
  _publicSet = new Set(pub ?? []);
  _deniedSet = new Set(denied);
  _scopes = scopes ?? {};
}

const normDoc = d => String(d ?? '').toLowerCase().replaceAll(" ", "");
const normAct = a => String(a ?? '').toLowerCase();

/**
 * Effective scope of (document, action) for the current user:
 * 'all' | 'own' | 'customer' | null (not permitted). Widest scope wins, like
 * the server ('customer' over 'own').
 */
function permissionScope(document, action) {
  const doc = normDoc(document);
  const act = normAct(action);
  const key = `${doc}:${act}`;

  if (_publicSet.has(key)) return 'all';
  if (_permSet === null) return 'all';          // Administrator

  if (_deniedSet.has(key)) return null;

  let result = null;
  for (const k of ['*:*', `${doc}:*`, `*:${act}`, key]) {
    if (!_permSet.has(k)) continue;
    const s = ['own', 'customer'].includes(_scopes[k]) ? _scopes[k] : 'all';
    if (s === 'all') return 'all';
    if (result !== 'customer') result = s;
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
  // The server only hands a 'customer' grant the records of the user's customers.
  if (scope === 'customer') return true;
  const value = owner ?? record?.[ownerField];
  return value != null && value === _userId;
}

const AuthContext = createContext(null);

export function AuthProvider({ permissions: initialPermissions, userId, children }) {
  const initialized = useRef(false);
  if (!initialized.current) {
    _userId = userId ?? null;
    initSets(initialPermissions);
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

  useRealtime(`permissionsChanged`, () => {
    refreshPermissions();
  });

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