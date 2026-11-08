'use strict';

import loopar from "loopar";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useCookies } from "@services/cookie";
import { usePersist } from "@services/persist-state";
import { PermissionTable } from "./permission-table.jsx";
import { SubjectRail } from "./subject-rail.jsx";
import { SubjectHeader } from "./subject-header.jsx";
import { __ } from "loopar";

/**
 * Roles & permissions manager.
 *   manager = "general" → full page: subject rail + header + grid
 *   manager = "role"    → embedded in the Role form (subject fixed = role)
 *   manager = "user"    → embedded in the User form (subject fixed = user)
 */
export function RolePermissionManager({ manager = "general", role: initialRole, user: initialUser }) {
  const [catalog, setCatalog] = useCookies("umCatalog", null);
  const [commonActions, setCommonActions] = useState([]);
  const [subjects, setSubjects] = useState(null);
  const [selected, setSelected] = usePersist(`${manager}subject`,
    initialUser ? { type: "user", name: initialUser } : initialRole ? { type: "role", name: initialRole } : null);
  const [userRoles, setUserRoles] = useState(new Set());
  const [refreshKey, setRefreshKey] = useState(0);

  const fixed = manager !== "general";
  const subject = fixed
    ? (initialUser ? { type: "user", name: initialUser } : initialRole ? { type: "role", name: initialRole } : null)
    : selected;
  const user = subject?.type === "user" ? subject.name : null;
  const role = subject?.type === "role" ? subject.name : null;

  useEffect(() => {
    loopar.call("Role Permission Manager", "getAllPerms", {
      success: (data) => { setCommonActions(data.commonActions); setCatalog(data.grouped); }
    });
  }, []);

  const loadSubjects = useCallback(() => {
    loopar.call("Role Permission Manager", "getSubjects", { success: setSubjects });
  }, []);
  useEffect(() => { loadSubjects(); }, [loadSubjects]);

  useEffect(() => {
    if (!user) { setUserRoles(new Set()); return; }
    loopar.call("Role Permission Manager", "getUserRoles", {
      query: { user },
      success: (data) => setUserRoles(new Set(data.map(r => r.role)))
    });
  }, [user]);

  const toggleUserRole = (roleName, assign) => {
    setUserRoles(prev => { const n = new Set(prev); assign ? n.add(roleName) : n.delete(roleName); return n; });
    loopar.call("Role Permission Manager", "toggleUserRole", {
      body: { user, role: roleName, assign },
      success: () => { setRefreshKey(v => v + 1); loadSubjects(); },
      error: () => setUserRoles(prev => { const n = new Set(prev); assign ? n.delete(roleName) : n.add(roleName); return n; })
    });
  };

  const [overrides, setOverrides] = useState(0);
  useEffect(() => {
    if (!user) { setOverrides(0); return; }
    loopar.call("Role Permission Manager", "getResolvedPermissions", {
      query: { user },
      success: (d) => setOverrides((d?.direct?.length ?? 0) + (d?.denied?.length ?? 0)),
    });
  }, [user, refreshKey]);

  const clearOverrides = () => {
    if (!user) return;
    if (!window.confirm(`Remove every direct grant and deny of ${user}? Roles are kept.`)) return;
    loopar.call("Role Permission Manager", "clearOverrides", {
      body: { user },
      success: () => setRefreshKey(v => v + 1),
    });
  };

  const resetRole = () => {
    if (!role) return;
    if (!window.confirm(`Reset "${role}" to the grants its app defines? Every current grant of the role is replaced. Users keep the role.`)) return;
    loopar.call("Role Permission Manager", "resetRole", {
      body: { role },
      success: () => { setRefreshKey(v => v + 1); loadSubjects(); },
    });
  };

  const roleInfo = useMemo(() => subjects?.roles?.find(r => r.name === role) ?? null, [subjects, role]);
  const userInfo = useMemo(() => subjects?.users?.find(u => u.name === user) ?? null, [subjects, user]);

  const header = (
    <SubjectHeader
      subject={subject}
      roleInfo={roleInfo}
      userInfo={userInfo}
      allRoles={subjects?.roles ?? []}
      userRoles={userRoles}
      onToggleUserRole={toggleUserRole}
      overrides={overrides}
      onClearOverrides={clearOverrides}
      onResetRole={resetRole}
    />
  );

  const body = !subject ? (
    <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground py-24 flex-1">
      <p className="text-sm">{__("Select a role or a user to manage its permissions")}</p>
    </div>
  ) : (
    <PermissionTable
      role={role}
      user={user}
      catalog={catalog}
      commonActions={commonActions}
      manager={manager}
      refreshKey={refreshKey}
    />
  );

  if (fixed) {
    return (
      <div className="flex flex-col rounded-xl border border-border bg-card overflow-hidden" style={{ minHeight: 480 }}>
        {header}
        {body}
      </div>
    );
  }

  return (
    <div className="flex rounded-xl border border-border bg-card overflow-hidden"
      style={{ height: "calc(100dvh - var(--header-height, 80px) - 24px)", minHeight: 520 }}>
      <SubjectRail
        subjects={subjects}
        loading={!subjects}
        selected={selected}
        onSelect={setSelected}
        onCreateRole={() => loopar.navigate("/desk/Role/create")}
        onCreateUser={() => loopar.navigate("/desk/User/create")}
      />
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {header}
        {body}
      </div>
    </div>
  );
}
