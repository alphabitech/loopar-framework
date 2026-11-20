import { canOn } from "@context/auth-context";

/**
 * Where a list row opens:
 *   - in the portal, the record's print format when the user may print it:
 *     the customer-facing version (the one emailed and approved), not the form;
 *   - the form (`update`) for who may edit the record;
 *   - else the read-only `view` (entities whose records only the app's flows
 *     write — Entity `read_only` — or a user who may only read them).
 */
export const recordAction = (Entity, row = null, { portal = false } = {}) => {
  const name = Entity?.name;
  if (portal && name && !Entity.is_single && !Entity.is_builder && canOn(name, "print", row)) return "print";
  return Entity?.read_only || (name && !canOn(name, "update", row)) ? "view" : "update";
};

export const recordLink = (Entity, name, row = null, opts) =>
  `${recordAction(Entity, row, opts)}?name=${encodeURIComponent(name)}`;
