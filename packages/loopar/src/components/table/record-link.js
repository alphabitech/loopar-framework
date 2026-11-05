/**
 * Where a list row opens: the form (`update`), or the read-only `view` for
 * entities whose records only the app's flows write (Entity `read_only`).
 */
export const recordAction = (Entity) => (Entity?.read_only ? "view" : "update");

export const recordLink = (Entity, name) => `${recordAction(Entity)}?name=${encodeURIComponent(name)}`;
