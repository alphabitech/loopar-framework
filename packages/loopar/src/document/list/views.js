/** List views available for a list Document, in toggle order. Kanban needs an active workflow. */
export const listViews = (Document) => ["List", "Grid", ...(Document?.workflow ? ["Kanban"] : [])];

/** The view the toggle switches to from `current`. */
export const nextListView = (Document, current) => {
  const views = listViews(Document);
  return views[(views.indexOf(current) + 1) % views.length];
};
