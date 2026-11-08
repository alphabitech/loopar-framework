/**
 * loopar-aware side of the field write policy (pure rules in
 * global/field-policy.js): who the actor is, the entity's policy map, and the
 * input sanitizer every request boundary uses.
 *
 *   const input = await sanitizeInput('User', this.data, { op: 'update' });
 *   const doc = await loopar.getDocument('User', name, input);
 *
 * Server code that assigns `doc.field = value` after that is trusted (layer A
 * only filters CLIENT input). `protected` / `system` fields are verified again
 * on save (layer B, CoreDocument): changing one needs `doc.authorize(field)`.
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
