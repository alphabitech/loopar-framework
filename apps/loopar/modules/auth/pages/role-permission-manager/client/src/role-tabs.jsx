'use strict';

import { Plus } from "lucide-react";
import { Link } from "@link";
import { avatarColor } from "../helper";
import { Checkbox } from "./Checkbox.jsx";
import {useEffect, useState} from "react"
import { loopar } from "loopar";
import { __ } from "loopar";

export function RoleTabs({ onSelect, role, user, userRoles = new Set(), onToggleUserRole, permissions, onCreateEntity }) {
  const [roles, setRoles] = useState([])
  const [roleTotals, setRoleTotals] = useState({})
  const loadRoles = async () => {
    const allRoles = await loopar.db.getAll("Role");
    setRoles(allRoles);
    const totals = await Promise.all(
      allRoles.map(async ({ name }) => [
        name,
        await loopar.db.count("Permission", { filter: { relation: "Role", relation_name: name } })
      ])
    );
    setRoleTotals(Object.fromEntries(totals));
  }

  useEffect(() => {
    loadRoles();
  }, [])

  return (
    <div className="flex items-center border-b border-border bg-card flex-shrink-0"
      style={{ scrollbarWidth: 'none' }}>
      <div className="flex items-center flex-1 min-w-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {roles.map(({ name }) => {
          const active = !user && role === name;
          const color = avatarColor(name);
          const total = roleTotals[name] ?? null;
          const assignedToUser = userRoles.has(name);

          return (
            <Link
              key={name} to={`view?role=${name}`} 
              onClick={() => !user && onSelect(name)} 
              active={active} 
              award={false}
              className={`flex items-center gap-2 px-4 py-3 text-xs font-medium whitespace-nowrap border-b-2 transition-all flex-shrink-0 cursor-pointer
                ${active
                  ? "text-foreground border-primary bg-primary/[.02]"
                  : "text-muted-foreground border-transparent hover:text-foreground hover:border-border hover:bg-muted/20"}`}
              style={{ marginBottom: "-1px" }}
            >
              {!!user && (
                <Checkbox
                  checked={assignedToUser}
                  partial={false}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleUserRole(name, !assignedToUser);
                  }}
                />
              )}

              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
                style={{ background: color }}>{name[0].toUpperCase()}</span>
              {name}
              {active && total !== null && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary">{total}</span>
              )}
            </Link>
          );
        })}
      </div>
      {onCreateEntity && (
        <button onClick={onCreateEntity}
          className="flex-shrink-0 flex items-center gap-1 px-3 py-2 mx-2 text-[11px] font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors cursor-pointer">
          <Plus size={11} /> {__("Role")}
        </button>
      )}
    </div>
  );
}