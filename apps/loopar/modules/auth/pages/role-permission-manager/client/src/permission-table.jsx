'use strict';

import { useState, useTransition, useMemo, useEffect, useCallback } from "react";
import loopar from "loopar";
import { cap, getOwnActions, makeGridCols, buildPermissionsFromResolved, resolveCell, updateCell, updateColumn, updateAllDoc, permKey, scopeOf, nextScope, SCOPE_LABEL } from "../helper";
import { Checkbox } from "./Checkbox.jsx";
import { OwnChip } from "./own-chip.jsx";
import { AppTabs } from "./app-tabs.jsx";
import { usePersist } from "@services/persist-state";
import { __ } from "loopar";

const EMPTY = { direct: [], inherited: {}, denied: [], scopes: {} };

/**
 * The grid: documents × actions for ONE subject (a role or a user).
 * Every cell is resolved client-side from the server payload
 * (direct / inherited / denied / scopes) so it can show WHERE a grant
 * comes from (a wildcard, an app-level grant, a role) and its scope.
 */
export function PermissionTable({ role, user, catalog, commonActions, manager = "general", refreshKey = 0 }) {
  const [resolved, setResolved] = useState(EMPTY);
  const [permissions, setPermissions] = useState({});
  const [currentApp, setCurrentApp] = usePersist(`${manager}currentApp`, null);
  const [search, setSearch] = usePersist(`${manager}search`, "");
  const [saving, setSaving] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [loading, setLoading] = useState(false);

  const [isRolePending, startRoleTransition] = useTransition();
  const [, startUITransition] = useTransition();
  const [, startExpandTransition] = useTransition();

  const mode = user ? "User" : "Role";
  const entity = user || role;

  const refreshResolved = useCallback(async () => {
    if (!catalog) return;
    if (!entity) {
      startRoleTransition(() => { setResolved(EMPTY); setPermissions(buildPermissionsFromResolved(catalog, EMPTY)); });
      return;
    }
    const data = await loopar.call("Role Permission Manager", "getResolvedPermissions", { query: { role, user } });
    const next = {
      direct: data?.direct ?? data?.assigned ?? [],
      inherited: data?.inherited ?? {},
      denied: data?.denied ?? [],
      scopes: data?.scopes ?? {},
    };
    startRoleTransition(() => {
      setResolved(next);
      setPermissions(buildPermissionsFromResolved(catalog, next));
    });
  }, [catalog, role, user, entity]);

  useEffect(() => {
    if (!catalog) return;
    setLoading(true);
    refreshResolved().finally(() => setLoading(false));
  }, [catalog, role, user, refreshResolved]);

  useEffect(() => {
    if (!refreshKey) return;
    refreshResolved();
  }, [refreshKey, refreshResolved]);

  useEffect(() => {
    if (!currentApp && permissions && Object.keys(permissions).length) setCurrentApp(Object.keys(permissions)[0]);
  }, [permissions, currentApp, setCurrentApp]);

  // ---- server calls (optimistic UI, then re-read the truth) ----------------
  const call = useCallback((action, body, key, revert) => {
    setSaving(key);
    loopar.call("Role Permission Manager", action, {
      body: { mode, entity, ...body },
      success: async () => { setSaving(null); await refreshResolved(); },
      error: () => { revert?.(); setSaving(null); refreshResolved(); },
    });
  }, [mode, entity, refreshResolved]);

  const handleToggle = useCallback((document, action, assign) => {
    setPermissions(prev => updateCell(prev, currentApp, document, action, assign));
    call("toggle", { document, action, assign }, permKey(document, action),
      () => setPermissions(prev => updateCell(prev, currentApp, document, action, !assign)));
  }, [currentApp, call]);

  const handleSetScope = useCallback((document, action, scope) => {
    call("setScope", { document, action, scope }, permKey(document, action));
  }, [call]);

  const handleToggleAll = useCallback((document, assign) => {
    setPermissions(prev => updateAllDoc(prev, currentApp, document, assign));
    call("toggleAll", { document, assign }, `${document}:*`);
  }, [currentApp, call]);

  const handleToggleCol = useCallback((action) => {
    const docs = permissions[currentApp] ?? {};
    let total = 0, assigned = 0;
    for (const acts of Object.values(docs)) if (action in acts) { total++; if (acts[action]) assigned++; }
    const assign = assigned < total;
    setPermissions(prev => updateColumn(prev, currentApp, action, assign));
    call("toggleCol", { app: currentApp, action, assign }, `*:${action}`);
  }, [permissions, currentApp, call]);

  // App-level grant (the "Whole app" row): App:<app>:<action> or App:<app>:*
  const handleToggleApp = useCallback((action, assign, scope) => {
    call("toggleApp", { app: currentApp, action, assign, scope }, `App:${currentApp}:${action}`);
  }, [currentApp, call]);

  const handleSetAppScope = useCallback((action, scope) => {
    call("setScope", { document: `App:${currentApp}`, action, scope }, `App:${currentApp}:${action}`);
  }, [currentApp, call]);

  // ---- derived -------------------------------------------------------------
  const currentDocs = permissions[currentApp] ?? {};

  const hasAnyOwn = useMemo(() =>
    Object.values(currentDocs).some(acts => getOwnActions(acts, commonActions).length > 0),
    [currentDocs, commonActions]
  );

  const gridCols = makeGridCols(commonActions, hasAnyOwn);

  const directKeys = useMemo(() => new Set((resolved.direct ?? []).map(k => k.toLowerCase())), [resolved]);
  const appKeyOf = (action) => permKey(`App:${currentApp}`, action).toLowerCase();
  const appAll = directKeys.has(`app:${String(currentApp).toLowerCase()}:*`);
  const appActionDirect = (action) => directKeys.has(appKeyOf(action));
  const appRowScope = (action) => {
    const s = resolved.scopes ?? {};
    const scopeAt = k => scopeOf(Object.entries(s).find(([sk]) => sk.toLowerCase() === k)?.[1]);
    if (appActionDirect(action)) return scopeAt(appKeyOf(action));
    if (appAll) return scopeAt(`app:${String(currentApp).toLowerCase()}:*`);
    return null;
  };
  // In user mode the app row may also be inherited from a role.
  const appRowInherited = (action) => {
    const inh = resolved.inherited ?? {};
    const find = k => Object.entries(inh).find(([ik]) => ik.toLowerCase() === k)?.[1];
    return find(appKeyOf(action)) || find(`app:${String(currentApp).toLowerCase()}:*`) || null;
  };

  function colState(action) {
    let total = 0, assigned = 0;
    for (const acts of Object.values(currentDocs)) if (action in acts) { total++; if (acts[action]) assigned++; }
    if (!total) return 'none';
    if (assigned === total) return 'all';
    return assigned > 0 ? 'partial' : 'off';
  }

  function docState(acts) {
    const vals = Object.values(acts);
    if (!vals.length) return 'none';
    if (vals.every(Boolean)) return 'all';
    return vals.some(Boolean) ? 'partial' : 'off';
  }

  const filtered = useMemo(() =>
    Object.entries(currentDocs).filter(([doc]) => doc.toLowerCase().includes((search || "").toLowerCase())),
    [currentDocs, search]
  );

  const viaLabel = (cell) => {
    if (cell.kind === 'wildcard') return `via ${cell.via}`;
    if (cell.kind === 'role') return `via ${cell.via.join(', ')}`;
    return null;
  };

  if (loading) return (
    <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
      <div className="w-4 h-4 border border-border border-t-primary rounded-full animate-spin mr-2" />
      {__("Loading permissions...")}
    </div>
  );

  const PILL = {
    own: "bg-amber-500 text-white border-amber-400 shadow opacity-100",
    customer: "bg-sky-500 text-white border-sky-400 shadow opacity-100",
  };
  const ScopePill = ({ scope, visible, onClick }) => {
    const current = scopeOf(scope);
    const next = nextScope(current);
    return (
      <button type="button" title={`Scope: ${SCOPE_LABEL[current]} — click for ${SCOPE_LABEL[next]}`} onClick={(e) => { e.stopPropagation(); onClick(next); }}
        className={`absolute left-1/2 -translate-x-1/2 -bottom-2 z-10 text-[10px] font-semibold leading-none px-1.5 py-[2px] rounded-full border transition-all whitespace-nowrap
          ${PILL[current] ?? `bg-background text-muted-foreground border-border ${visible ? "opacity-100" : "opacity-0 group-hover/cell:opacity-100"}`}`}>
        {current}
      </button>
    );
  };

  return (
    <div className="flex flex-col overflow-hidden flex-1 min-h-0">
      <AppTabs
        permissions={permissions}
        currentApp={currentApp}
        onSelect={app => startUITransition(() => { setCurrentApp(app); setSearch(""); })}
        search={search}
        onSearch={setSearch}
      />

      <div
        className="overflow-auto transition-opacity duration-200 flex-1 min-h-0"
        style={{ opacity: isRolePending ? 0.4 : 1, pointerEvents: isRolePending ? 'none' : 'auto', scrollbarWidth: 'thin' }}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-border bg-secondary text-xs">
          <div className="grid bg-secondary" style={{ gridTemplateColumns: gridCols, minWidth: 'max-content' }}>
            <div className="sticky left-0 z-20 bg-secondary px-4 py-2 border-r border-border flex items-center">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{__("Document")}</span>
            </div>
            {commonActions.map(a => {
              const state = colState(a);
              const color = state === 'all' ? 'text-primary' : state === 'partial' ? 'text-amber-500' : 'text-muted-foreground';
              return (
                <div key={a} className="px-1 py-2 flex flex-col items-center gap-1">
                  <span className={`text-[9px] font-semibold uppercase tracking-wider ${color}`}>{a}</span>
                  <Checkbox checked={state === 'all'} partial={state === 'partial'} onClick={() => handleToggleCol(a)} />
                </div>
              );
            })}
            {hasAnyOwn && (
              <div className="px-3 py-2 flex items-center">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{__("Custom")}</span>
              </div>
            )}
          </div>
        </div>

        {/* Whole-app row (App:<app> grants) */}
        {currentApp && (
          <div className="grid border-b border-border bg-primary/[.04] text-xs" style={{ gridTemplateColumns: gridCols, minWidth: 'max-content' }}>
            <div className="sticky left-0 z-[5] bg-primary/[.04] px-3 py-1.5 border-r border-border flex items-center gap-2 font-medium text-foreground whitespace-nowrap">
              <span className="w-4 flex-shrink-0" />
              <span className="text-[12px]">{__("Whole app")}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary">{__("App:")}{currentApp}</span>
              <button
                onClick={() => handleToggleApp('*', !appAll)}
                title={appAll ? "Remove App:*:* — every action on every document of this app" : "Grant every action on every document of this app (App:*:*)"}
                className={`ml-auto flex-shrink-0 text-[9px] px-1.5 py-0.5 rounded-full border transition-all
                  ${appAll ? "bg-primary/10 text-primary border-primary/25 hover:bg-primary/20" : "bg-transparent text-muted-foreground border-border hover:border-input"}`}>
                {appAll ? "✓ All" : "+ All"}
              </button>
            </div>

            {commonActions.map(action => {
              const key = `App:${currentApp}:${action}`;
              const direct = appActionDirect(action);
              const covered = appAll && !direct;
              const inheritedRoles = !direct && !appAll ? appRowInherited(action) : null;
              const scope = appRowScope(action);
              const cellScope = scope ?? (inheritedRoles ? scopeOf(resolved.scopes?.[appKeyOf(action)]) : null);
              const isSav = saving === key;
              const title = direct ? `Direct: ${key}` : covered ? `via App:${currentApp}:*` : inheritedRoles ? `via ${inheritedRoles.join(', ')}` : `Grant ${action} on every document of ${currentApp}`;
              return (
                <div key={action} className="flex items-center justify-center py-0.5">
                  {isSav
                    ? <div className="inline-flex items-center justify-center w-8 h-8"><div className="w-3 h-3 border border-border border-t-primary rounded-full animate-spin" /></div>
                    : <div className="relative group/cell">
                        <Checkbox
                          checked={direct}
                          inherited={covered || !!inheritedRoles}
                          scope={cellScope}
                          title={title}
                          onClick={() => (covered || inheritedRoles) ? handleToggleApp(action, true) : handleToggleApp(action, !direct)}
                        />
                        {direct && (
                          <ScopePill scope={scope} visible={false}
                            onClick={(next) => handleSetAppScope(action, next)} />
                        )}
                      </div>}
                </div>
              );
            })}
            {hasAnyOwn && <div />}
          </div>
        )}

        {/* Rows */}
        {filtered.length === 0 && (search || "").length > 0 ? (
          <div className="flex items-center justify-center p-12 text-sm text-muted-foreground">
            {__("No documents match")} <strong className="ml-1">"{search}"</strong>
          </div>
        ) : (
          filtered.map(([doc, acts]) => {
            const extras = getOwnActions(acts, commonActions);
            const isExpanded = expanded[doc];
            const extraAssigned = extras.filter(a => acts[a]).length;
            const state = docState(acts);
            const allChecked = state === 'all';

            // Row label: where most of this row comes from (first granted common cell)
            const firstCell = commonActions.map(a => resolveCell(resolved, currentApp, doc, a)).find(c => c.granted && c.kind !== 'direct');
            const rowVia = firstCell ? viaLabel(firstCell) : null;
            const hasOverride = commonActions.some(a => { const c = resolveCell(resolved, currentApp, doc, a); return c.kind === 'direct' || c.kind === 'deny'; });

            return (
              <div key={doc}>
                <div className="grid group border-b border-border/50 hover:bg-primary/[.02] transition-colors text-xs"
                  style={{ gridTemplateColumns: gridCols, minWidth: 'max-content' }}>
                  <div className="sticky left-0 z-[5] bg-card group-hover:bg-primary/[.02] transition-colors px-3 py-1.5 border-r border-border flex items-center gap-1.5 font-medium text-foreground whitespace-nowrap">
                    {extras.length > 0 ? (
                      <button onClick={() => startExpandTransition(() => setExpanded(p => ({ ...p, [doc]: !p[doc] })))}
                        className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
                        <svg width="7" height="7" viewBox="0 0 8 8" fill="none" className={`transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}>
                          <path d="M2 1.5L5.5 4L2 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                    ) : <span className="w-4 flex-shrink-0" />}

                    <span className="truncate text-[12px]">{cap(doc)}</span>

                    {rowVia && !hasOverride && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-border text-muted-foreground truncate max-w-[110px]" title={rowVia}>{rowVia}</span>
                    )}
                    {hasOverride && rowVia && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-amber-500/40 text-amber-500">{__("override")}</span>
                    )}

                    <button onClick={() => handleToggleAll(doc, !allChecked)}
                      className={`ml-auto flex-shrink-0 text-[9px] px-1.5 py-0.5 rounded-full border transition-all
                        ${allChecked ? "bg-primary/10 text-primary border-primary/25 hover:bg-primary/20"
                          : state === 'partial' ? "bg-amber-500/10 text-amber-500 border-amber-500/25 hover:bg-amber-500/20"
                          : "bg-transparent text-muted-foreground border-border hover:border-input"}`}>
                      {allChecked ? "✓ All" : state === 'partial' ? "— Partial" : "+ All"}
                    </button>
                  </div>

                  {commonActions.map(action => {
                    const has = action in acts;
                    const cell = has ? resolveCell(resolved, currentApp, doc, action) : null;
                    const key = permKey(doc, action);
                    const isSav = saving === key;
                    const checked = !!cell?.granted;
                    const isDirect = cell?.kind === 'direct';
                    const isInherited = checked && !isDirect;
                    const isDenied = cell?.kind === 'deny';
                    const canScope = isDirect;
                    const title = !has ? undefined
                      : isDenied ? "Denied for this user"
                      : isDirect ? `Direct grant${cell.scope && cell.scope !== 'all' ? ` · ${SCOPE_LABEL[cell.scope]}` : ""}`
                      : isInherited ? `${viaLabel(cell)}${cell.scope && cell.scope !== 'all' ? ` · ${SCOPE_LABEL[cell.scope]}` : ""}`
                      : "Not granted";

                    return (
                      <div key={action} className="flex items-center justify-center py-0.5">
                        {isSav
                          ? <div className="inline-flex items-center justify-center w-8 h-8"><div className="w-3 h-3 border border-border border-t-primary rounded-full animate-spin" /></div>
                          : <div className="relative group/cell">
                              <Checkbox
                                checked={isDirect}
                                inherited={isInherited}
                                denied={isDenied}
                                scope={cell?.scope}
                                title={title}
                                na={!has}
                                onClick={() => has && handleToggle(doc, action, isDenied ? true : !checked)}
                              />
                              {canScope && (
                                <ScopePill scope={cell.scope} visible={false}
                                  onClick={(next) => handleSetScope(doc, action, next)} />
                              )}
                            </div>}
                      </div>
                    );
                  })}

                  {hasAnyOwn && (
                    <div className="px-3 py-1 flex items-center">
                      {extras.length > 0 && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${extraAssigned > 0 ? "bg-primary/10 text-primary border-primary/25" : "bg-transparent text-muted-foreground border-border"}`}>
                          {extraAssigned}/{extras.length}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {isExpanded && extras.length > 0 && (
                  <div className="border-b border-border/50 bg-muted/20 flex text-xs" style={{ minWidth: 'max-content' }}>
                    <div className="sticky left-0 z-[5] bg-muted/20 px-6 py-2 border-r border-border flex items-center flex-shrink-0" style={{ width: 260 }}>
                      <span className="text-[9px] text-muted-foreground italic uppercase tracking-wider">{__("Custom actions")}</span>
                    </div>
                    <div className="px-3 py-2 flex flex-wrap gap-1.5">
                      {extras.map(action => (
                        <OwnChip key={action} action={action} checked={acts[action]} saving={saving === permKey(doc, action)}
                          onClick={() => handleToggle(doc, action, !acts[action])} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 px-4 py-2 border-t border-border bg-secondary/60 text-[11px] text-muted-foreground flex-shrink-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        <span className="flex items-center gap-1.5"><Checkbox checked /> {__("direct")}</span>
        <span className="flex items-center gap-1.5"><Checkbox inherited /> {__("inherited (App:x · *:x · role)")}</span>
        <span className="flex items-center gap-1.5"><Checkbox checked scope="own" /> {__("own records")}</span>
        <span className="flex items-center gap-1.5"><Checkbox inherited scope="own" /> {__("inherited · own")}</span>
        <span className="flex items-center gap-1.5"><Checkbox checked scope="customer" /> {__("customer's records (portal)")}</span>
        <span className="flex items-center gap-1.5"><Checkbox denied /> {__("denied")}</span>
        <span className="ml-auto whitespace-nowrap">{__("click = toggle · pill = scope · hover = source")}</span>
      </div>
    </div>
  );
}
