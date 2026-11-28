/**
 * Shared mutable state of the TUI. One plain object — render() draws it,
 * input handlers mutate it, actions read and update it.
 */

export const NO_PM2 = process.env.LOOPAR_TUI_NO_PM2 === "1";

export const state = {
  rows: [], // [{ name, port, domain, env, url, status }]
  selected: 0,
  scroll: 0,
  view: "tenants", // tenants | logs | tests (full-screen tabs; backups live in the tenants panel)
  mode: "list", // list | create (wizard) | destroy | confirm
  danger: null, // "destroy" | "reset" while the name-confirm modal is open
  input: "",
  wizard: null, // { title, steps: [{ key, label, value, validate, default, mask }], idx, onDone }
  confirm: null, // { question, onYes, onNo? }
  message: "",
  messageKind: "info", // info | ok | error
  busy: false,
  coreStatus: null, // pm2 status of loopar-core: 'online' | 'stopped' | null (unknown)

  // Logs tab (managed by logs.js while view === "logs")
  logs: null, // { name|null(=all), lines: [{s,text,at?,p?}], follow, scroll, viewH, paths, procs, live }

  // Tests tab (managed by tests.js): { files, cursor, scroll, picked:Set, handle, detailScroll, listH }
  tests: null,
  testRowStart: 0, // first terminal row (1-based) of the test file list
  backupRowStart: 0, // first terminal row (1-based) of the backups tree (tenants panel)

  // Backups of the selected tenant (managed by backups.js, one cached state per tenant):
  // { tenant, rows, cursor, scroll, listH, destination, remoteError, loading, loaded, head, lineage, tree }
  backups: null,

  // Set by render() on every frame; read by the mouse handler.
  rowRegionStart: 0, // first terminal row (1-based) of the tenant table
  buttonRegions: [], // [{ x1, x2, y, y1?, y2?, action }] — footer buttons AND header tabs
  pressed: null, // action of the button under a mouse press (fires on release)
  focus: "sidebar", // tenants view: "sidebar" (tenants) | "panel" (the selected tenant's children)
  panelTab: "backups", // tenants panel body: "backups" | "logs" (the tenant's own log lines)
  panelLogRowStart: 0, // set by render: 1-based first row of the panel's log lines
  sidebarW: 0, // set by render: width of the tenants sidebar
  panelX: 0, // set by render: 1-based first column of the panel
  tableH: 10, // rows per table page (set by render; PgUp/PgDn use it)
};

/** Button/tab under (x, y). Regions may span several rows (y1..y2). */
export function findButton(x, y) {
  return state.buttonRegions.find((r) =>
    y >= (r.y1 ?? r.y) && y <= (r.y2 ?? r.y) && x >= r.x1 && x <= r.x2) || null;
}
