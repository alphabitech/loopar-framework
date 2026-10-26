'use strict';

/**
 * Gives every child table (form-table rows) its CHILD_POSITION_COLUMN,
 * seeded with `id` so rows keep the order they had. Idempotent and cheap:
 * tables that already have it are skipped, so it runs on every boot.
 */
export async function migrateChildPositions(loopar) {
  if (!loopar.__installed__) return;

  const added = [];
  for (const ref of Object.values(loopar.getRefs() || {})) {
    if (ref.__TYPE__ !== "Entity" || !(ref.is_child === 1 || ref.is_child === true)) continue;
    if (await loopar.db.ensureChildPosition(ref.__NAME__)) added.push(ref.__NAME__);
  }
  if (added.length) console.log(`[child-position] ${loopar.tenantId}: added to ${added.join(", ")}`);
}
