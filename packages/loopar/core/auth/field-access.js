/**
 * loopar-aware side of the field write policy (pure rules in
 * global/field-policy.js): who the actor is, the entity's policy map, and the
 * input filter.
 *
 * Layer A is applied by the DOCUMENT, not by controllers: during an HTTP
 * request, the `data` handed to loopar.newDocument() / loopar.getDocument()
 * is treated as client input and filtered by the entity's policy
 * (guardConstructorInput, called from document-manage.js). A controller can't
 * forget it. What server code assigns afterwards (`doc.field = value`) is
 * trusted; `protected` / `system` fields are verified again on save (layer B,
 * CoreDocument): changing one needs `doc.authorize(field)`.
 *
 * Constructor data built by server code that must keep restricted fields:
 *   loopar.newDocument('X', trustedInput({ status: 'Approved', ... }))
 * or assign those fields after construction. Outside requests (jobs, CLI,
 * installer) constructor data is server code and is not filtered.
 */
import { loopar } from '../loopar.js';
import { getRequest } from '../server/router/request-context.js';
import { filterInput, renderLock } from '../global/field-policy.js';

const PASSWORD_MASK = '********';

/** { fieldName: rule } of an entity (empty when it restricts nothing). */
export function policyMapOf(entity) {
  if (!entity) return {};
  const name = typeof entity === 'string' ? entity : (entity.__NAME__ || entity.name);
  return loopar.getRef(name)?.__WRITE_POLICY__ || {};
}

const needsRoles = (map) => Object.values(map).some((rule) => rule.roles?.length);

/**
 * The acting user: { user, isAdmin, roles }. Roles are read only when a rule
 * needs them, once per request.
 */
export async function currentActor(map = null, user = loopar.auth?.user?.()) {
  if (!user) return { user: null, isAdmin: false, roles: [] };
  if (user === 'Administrator') return { user, isAdmin: true, roles: [] };
  if (map && !needsRoles(map)) return { user, isAdmin: false, roles: [] };

  const req = getRequest();
  const cacheKey = `__ACTOR_ROLES__${user}`;
  if (req && Array.isArray(req[cacheKey])) return { user, isAdmin: false, roles: req[cacheKey] };

  let roles = [];
  try {
    roles = (await loopar.db.getAll('User Role', ['role'], { user })).map((r) => r.role).filter(Boolean);
  } catch {
    roles = [];
  }
  if (req) req[cacheKey] = roles;
  return { user, isAdmin: false, roles };
}

// Objects server code vouches for (identity based: a spread copy is not trusted).
const TRUSTED = new WeakSet();

/** Marks constructor data as built by server code: no layer-A filtering. */
export function trustedInput(data) {
  if (data && typeof data === 'object') TRUSTED.add(data);
  return data;
}

export const isTrustedInput = (data) => !!data && typeof data === 'object' && TRUSTED.has(data);

const debug = () => ['1', 'true'].includes(String(process.env.LOOPAR_FIELD_POLICY_DEBUG || '').toLowerCase());

/**
 * Layer A: client input without the fields the actor may not write.
 * `op`: 'create' | 'update'. `authorized`: protected fields a verified flow
 * already cleared. Returns a new object (the input is not mutated).
 */
export async function sanitizeInput(entity, data, { op = 'update', authorized = [] } = {}) {
  if (!data || typeof data !== 'object') return data;
  const map = policyMapOf(entity);
  if (!Object.keys(map).length) return data;

  const actor = await currentActor(map);
  const { data: clean, dropped } = filterInput(map, data, { op, actor, authorized, passwordMask: PASSWORD_MASK });

  if (dropped.length && debug()) {
    const name = typeof entity === 'string' ? entity : entity?.name;
    console.warn(`[field-policy] ${name} (${op}) input dropped: ${dropped.map((d) => `${d.field}:${d.reason}`).join(', ')} — user=${actor.user || 'guest'}`);
  }
  return clean;
}

/**
 * Layer A at the document boundary (document-manage newDocument/getDocument).
 * Inside an HTTP request, constructor `data` is client input unless marked
 * with trustedInput(). Dropped fields fall back to the stored value when the
 * record exists (`original`), so a filtered update never blanks a column.
 */
export async function guardConstructorInput(entity, data, { op = 'create', original = null } = {}) {
  if (!data || typeof data !== 'object' || TRUSTED.has(data)) return data;
  if (loopar.installing || !getRequest()) return data;

  const map = policyMapOf(entity);
  if (!Object.keys(map).length) return data;

  const actor = await currentActor(map);
  const { data: clean, dropped } = filterInput(map, data, { op, actor, passwordMask: PASSWORD_MASK });
  if (!dropped.length) return data;

  if (original) {
    for (const { field } of dropped) {
      if (map[field]?.element !== 'password' && field in original) clean[field] = original[field];
    }
  }

  if (debug()) {
    const name = typeof entity === 'string' ? entity : entity?.name;
    console.warn(`[field-policy] ${name} (${op}) input dropped: ${dropped.map((d) => `${d.field}:${d.reason}`).join(', ')} — user=${actor.user || 'guest'}`);
  }
  return clean;
}

/**
 * The doc_structure with each restricted field pinned for this actor:
 * `readonly: 1`, plus `protected_change: 1` where the verified "Change" flow
 * applies. Same source as the server enforcement, so the form never offers
 * an edit the save would drop.
 */
export async function lockStructure(entity, structure, { isNew = false } = {}) {
  const map = policyMapOf(entity);
  if (!Object.keys(map).length || !Array.isArray(structure)) return structure;
  const actor = await currentActor(map);

  const pin = (nodes = []) => nodes.map((el) => {
    const name = el?.data?.name;
    const rule = name ? map[name] : null;
    const lock = rule ? renderLock({ ...rule, name }, { isNew, actor }) : null;
    return {
      ...el,
      ...(lock ? { data: { ...el.data, ...lock, write_policy: rule.policy } } : {}),
      ...(el.elements ? { elements: pin(el.elements) } : {}),
    };
  });
  return pin(structure);
}
