/**
 * Field write policy — WHO may change a declared field, and THROUGH WHICH path.
 *
 * Unknown keys were never the risk: a Document only defines accessors for the
 * fields of its doc_structure and save() persists only those. The risk is a
 * DECLARED field the actor must not change (User.user_type, mfa_*, oauth_*,
 * a total, a status): `readonly` / `hidden` / `disabled` are UI hints only, so
 * a crafted request could write them. The policy lives in the entity JSON
 * (server side — the client can't alter it) as `data.write_policy`:
 *
 *   editable     default — written from a form by anyone allowed to save it
 *   display_only shown read-only in the form, but client code may fill it
 *                (values computed in the browser); the server accepts it
 *   create_only  only when the record is created
 *   readonly     never from client input; only server code (totals, states)
 *   protected    changed only through a verified flow (re-authentication),
 *                never through the regular form save (email, password)
 *   system       never from client input nor from the protected flow; only
 *                server code that explicitly authorizes it (mfa_*, oauth_*)
 *
 * plus optional `data.write_roles` ("Role A, Role B"): only those roles (and
 * the Administrator user) may write the field from input.
 *
 * Enforced twice:
 *   A. filterInput()   — at the request boundary: client input loses the
 *                        fields it may not write. Server code assigning
 *                        `doc.field = …` afterwards is trusted.
 *   B. guardedChanges() — in Document.save(): a `protected` / `system` field
 *                        whose stored value changed without `doc.authorize()`
 *                        aborts the save, whatever path brought the value.
 *
 * Pure module (no `loopar` import) so it is unit-testable; the loopar-aware
 * wrappers live in core/auth/field-access.js.
 */

export const WRITE_POLICY = Object.freeze({
  EDITABLE: 'editable',
  DISPLAY_ONLY: 'display_only',
  CREATE_ONLY: 'create_only',
  READONLY: 'readonly',
  PROTECTED: 'protected',
  SYSTEM: 'system',
});

const POLICIES = new Set(Object.values(WRITE_POLICY));

/** Policies whose CHANGES save() verifies (layer B). */
export const GUARDED_POLICIES = new Set([WRITE_POLICY.PROTECTED, WRITE_POLICY.SYSTEM]);

/** Effective policy of a field from its `data`. */
export function fieldPolicy(data = {}) {
  const raw = String(data?.write_policy ?? '').trim().toLowerCase();
  return POLICIES.has(raw) ? raw : WRITE_POLICY.EDITABLE;
}

/** `write_roles` as a list ("A, B" or one per line). */
export function fieldRoles(data = {}) {
  const raw = data?.write_roles;
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]/);
  return [...new Set(list.map((r) => String(r).trim()).filter(Boolean))];
}

/**
 * { fieldName: { policy, roles, element } } for every named field of a
 * doc_structure whose write is restricted or displayed read-only. Fields
 * that are plain `editable` with no roles are omitted: absence means
 * "editable".
 */
export function writePolicyMap(structure = []) {
  const out = {};
  const walk = (nodes) => {
    for (const node of nodes || []) {
      const data = node?.data || {};
      const name = data.name;
      if (name) {
        const policy = fieldPolicy(data);
        const roles = fieldRoles(data);
        if (policy !== WRITE_POLICY.EDITABLE || roles.length) {
          out[name] = { policy, roles, element: node.element };
        }
      }
      walk(node?.elements);
    }
  };
  walk(structure);
  return out;
}

/**
 * May `actor` write field `rule` from client input in operation `op`?
 * → { allowed, reason }
 *
 * actor: { isAdmin, roles: string[] }   op: 'create' | 'update'
 * authorized: fields a verified flow already cleared (protected only).
 */
export function canWriteFromInput(rule, { op = 'update', actor = {}, authorized = [] } = {}) {
  if (!rule) return { allowed: true };

  switch (rule.policy) {
    case WRITE_POLICY.SYSTEM:
      return { allowed: false, reason: 'system' };
    case WRITE_POLICY.READONLY:
      return { allowed: false, reason: 'readonly' };
    case WRITE_POLICY.CREATE_ONLY:
      if (op !== 'create') return { allowed: false, reason: 'create_only' };
      break;
    case WRITE_POLICY.PROTECTED:
      // Setting the first value on create is not a "change".
      if (op !== 'create' && !authorized.includes(rule.name)) return { allowed: false, reason: 'protected' };
      break;
    default:
      break;
  }

  if (rule.roles?.length && !actor.isAdmin) {
    const mine = new Set(actor.roles || []);
    if (!rule.roles.some((r) => mine.has(r))) return { allowed: false, reason: 'roles' };
  }

  return { allowed: true };
}

/**
 * Layer A. Returns `{ data, dropped }`: a copy of `data` without the fields
 * the actor may not write. A dropped PASSWORD field is replaced by
 * `passwordMask` ("unchanged" for the save chain) instead of deleted, so
 * paired checks (password === confirm_password) keep working.
 */
export function filterInput(policyMap = {}, data = {}, { op = 'update', actor = {}, authorized = [], passwordMask = '********' } = {}) {
  if (!data || typeof data !== 'object') return { data, dropped: [] };

  const out = { ...data };
  const dropped = [];

  for (const [name, rule] of Object.entries(policyMap)) {
    if (!(name in out)) continue;
    const { allowed, reason } = canWriteFromInput({ ...rule, name }, { op, actor, authorized });
    if (allowed) continue;

    dropped.push({ field: name, reason });
    if (rule.element === 'password') out[name] = passwordMask;
    else delete out[name];
  }

  return { data: out, dropped };
}

/** Values as the database sees them, for change detection. */
export function comparable(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/**
 * Layer B. Guarded (protected / system) fields whose value changed between
 * `original` (as stored) and `current`, and that nobody authorized.
 * Both value maps must already be normalized by the caller (comparable(),
 * secrets decrypted, password masks resolved).
 */
export function guardedChanges(policyMap = {}, original = {}, current = {}, authorized = []) {
  const ok = new Set(authorized);
  const changed = [];
  for (const [name, rule] of Object.entries(policyMap)) {
    if (!GUARDED_POLICIES.has(rule.policy)) continue;
    if (!(name in current) || ok.has(name)) continue;
    if (comparable(current[name]) !== comparable(original?.[name])) changed.push(name);
  }
  return changed;
}

/**
 * How the form should render a field for this actor/record:
 * → null (editable) | { readonly: 1 } | { readonly: 1, protected_change: 1 }
 */
export function renderLock(rule, { isNew = false, actor = {} } = {}) {
  if (!rule) return null;
  if (rule.policy === WRITE_POLICY.DISPLAY_ONLY) return { readonly: 1 };
  const { allowed } = canWriteFromInput({ ...rule, name: rule.name ?? '__render__' }, {
    op: isNew ? 'create' : 'update',
    actor,
    authorized: [],
  });
  if (allowed) return null;
  if (rule.policy === WRITE_POLICY.PROTECTED && !isNew) {
    // Changeable through the verified flow — unless the roles forbid it too.
    const roleCheck = canWriteFromInput({ ...rule, policy: WRITE_POLICY.EDITABLE, name: '__roles__' }, { op: 'update', actor });
    return roleCheck.allowed ? { readonly: 1, protected_change: 1 } : { readonly: 1 };
  }
  return { readonly: 1 };
}
