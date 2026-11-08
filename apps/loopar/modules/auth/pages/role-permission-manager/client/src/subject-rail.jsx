'use strict';

import { useMemo, useState } from "react";
import { Search, Plus, ChevronDown } from "lucide-react";
import { avatarColor } from "../helper";
import { __ } from "loopar";

/**
 * Left rail: every subject the manager can edit — roles grouped by
 * system / app / custom, then users. Replaces the role tabs and the
 * user selector.
 *
 *   subjects = { roles: [{name, app, description, group, grants, users, disabled}], users: [{name, email, roles}] }
 *   selected = { type: 'role'|'user', name }
 */
export function SubjectRail({ subjects, selected, onSelect, onCreateRole, onCreateUser, loading }) {
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState({});

  const groups = useMemo(() => {
    const roles = subjects?.roles ?? [];
    const users = subjects?.users ?? [];
    const needle = q.trim().toLowerCase();
    const match = s => !needle || s.toLowerCase().includes(needle);

    const byGroup = new Map();
    for (const r of roles) {
      if (!match(r.name)) continue;
      const g = r.group || "custom";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(r);
    }
    const order = ["system", ...[...byGroup.keys()].filter(g => g !== "system" && g !== "custom").sort(), "custom"];
    const roleGroups = order.filter(g => byGroup.has(g)).map(g => ({
      id: g,
      label: g === "system" ? "System" : g === "custom" ? "Custom" : g,
      items: byGroup.get(g),
    }));
    return { roleGroups, users: users.filter(u => match(u.name) || match(u.email || "")) };
  }, [subjects, q]);

  const toggle = id => setCollapsed(p => ({ ...p, [id]: !p[id] }));

  const Item = ({ type, name, sub, count, color, muted }) => {
    const active = selected?.type === type && selected?.name === name;
    return (
      <button
        onClick={() => onSelect({ type, name })}
        className={`w-full flex items-center gap-2.5 mx-0 px-2.5 py-1.5 rounded-md text-left text-[12px] transition-colors
          ${active
            ? "bg-primary/10 text-foreground ring-1 ring-primary/30"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/40"}
          ${muted ? "opacity-50" : ""}`}>
        <span className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
          style={{ background: color }}>{name[0].toUpperCase()}</span>
        <span className="flex-1 min-w-0">
          <span className="block truncate">{name}</span>
          {sub && <span className="block truncate text-[10px] text-muted-foreground/70">{sub}</span>}
        </span>
        {count != null && <span className="text-[10px] text-muted-foreground/70 tabular-nums">{count}</span>}
      </button>
    );
  };

  const Section = ({ id, label, action, children }) => (
    <div className="mt-2">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <button onClick={() => toggle(id)} className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
          <ChevronDown size={11} className={`transition-transform ${collapsed[id] ? "-rotate-90" : ""}`} />
          {label}
        </button>
        {action && (
          <button onClick={action} title={__("New")} className="text-muted-foreground hover:text-primary">
            <Plus size={12} />
          </button>
        )}
      </div>
      {!collapsed[id] && <div className="px-1.5 flex flex-col gap-0.5">{children}</div>}
    </div>
  );

  return (
    <aside className="w-[236px] flex-shrink-0 border-r border-border bg-secondary/40 flex flex-col overflow-hidden">
      <div className="p-2.5">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-background text-muted-foreground">
          <Search size={12} className="flex-shrink-0" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={__("Search role or user…")}
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px] text-foreground placeholder:text-muted-foreground"
          />
          {q && <button onClick={() => setQ("")} className="text-[10px] hover:text-foreground">✕</button>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-3" style={{ scrollbarWidth: "thin" }}>
        {loading && (
          <div className="px-4 py-6 text-[11px] text-muted-foreground">{__("Loading…")}</div>
        )}

        {groups.roleGroups.map(g => (
          <Section key={g.id} id={g.id} label={g.label} action={g.id === "custom" ? onCreateRole : null}>
            {g.items.map(r => (
              <Item key={r.name} type="role" name={r.name} count={r.grants}
                color={avatarColor(r.app || r.name)} muted={r.disabled} />
            ))}
          </Section>
        ))}
        {!loading && !groups.roleGroups.some(g => g.id === "custom") && (
          <Section id="custom" label={__("Custom")} action={onCreateRole}>
            <div className="px-2.5 py-1 text-[11px] text-muted-foreground/70">{__("No custom roles yet")}</div>
          </Section>
        )}

        <Section id="users" label={__("Users")} action={onCreateUser}>
          {groups.users.map(u => (
            <Item key={u.name} type="user" name={u.name} sub={u.email} color="#0ea5e9" />
          ))}
          {!loading && groups.users.length === 0 && (
            <div className="px-2.5 py-1 text-[11px] text-muted-foreground/70">{__("No users")}</div>
          )}
        </Section>
      </div>
    </aside>
  );
}
