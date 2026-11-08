'use strict';

import { Link } from "@link";
import { avatarColor } from "../helper";
import { Checkbox } from "./Checkbox.jsx";
import { __ } from "loopar";

/**
 * Header for the selected subject. Role: name, kind, description, counts.
 * User: name, email, and the roles row (chips with a checkbox to assign).
 */
export function SubjectHeader({ subject, roleInfo, userInfo, allRoles = [], userRoles = new Set(), onToggleUserRole, overrides = 0, onClearOverrides, onResetRole }) {
  if (!subject) return null;
  const isUser = subject.type === "user";
  const color = isUser ? "#0ea5e9" : avatarColor(roleInfo?.app || subject.name);

  const kind = isUser
    ? `user · ${(userInfo?.type || "System").toLowerCase()}`
    : roleInfo?.group === "system" ? "system role"
    : roleInfo?.group && roleInfo.group !== "custom" ? `app role · ${roleInfo.group}`
    : "custom role";

  const editLink = isUser ? `/desk/User/update?name=${encodeURIComponent(subject.name)}`
                          : `/desk/Role/update?name=${encodeURIComponent(subject.name)}`;

  return (
    <div className="border-b border-border bg-card">
      <div className="flex items-center gap-3.5 px-5 pt-4 pb-3">
        <span className="w-10 h-10 rounded-xl flex items-center justify-center text-[15px] font-bold text-white flex-shrink-0"
          style={{ background: color }}>{subject.name[0].toUpperCase()}</span>

        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[17px] font-semibold text-foreground truncate">{subject.name}</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary whitespace-nowrap">{kind}</span>
            {roleInfo?.disabled && (
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-border text-muted-foreground">{__("disabled")}</span>
            )}
          </div>
          <span className="text-[12px] text-muted-foreground truncate">
            {isUser ? (userInfo?.email || "") : (roleInfo?.description || "No description")}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-4 text-[12px] text-muted-foreground whitespace-nowrap">
          {isUser ? (
            <>
              <span><b className="text-foreground">{userRoles.size}</b> {__("roles")}</span>
              <span><b className="text-foreground">{overrides}</b> {__("overrides")}</span>
              {overrides > 0 && onClearOverrides && (
                <button onClick={onClearOverrides}
                  title={__("Remove every direct grant and deny of this user, keeping only what its roles provide")}
                  className="px-3 py-1.5 rounded-md border border-amber-500/40 text-amber-500 hover:bg-amber-500/10 transition-colors">
                  {__("Clear overrides")}
                </button>
              )}
            </>
          ) : (
            <>
              <span><b className="text-foreground">{roleInfo?.grants ?? 0}</b> {__("grants")}</span>
              <span><b className="text-foreground">{roleInfo?.users ?? 0}</b> {__("users")}</span>
              {roleInfo?.system && roleInfo?.app && onResetRole && (
                <button onClick={onResetRole}
                  title={`Drop every grant of this role and seed again what the ${roleInfo.app} app defines. Users keep the role.`}
                  className="px-3 py-1.5 rounded-md border border-amber-500/40 text-amber-500 hover:bg-amber-500/10 transition-colors">
                  {__("Reset to defaults")}
                </button>
              )}
            </>
          )}
          <Link to={editLink} award={false}
            className="px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-muted/40 transition-colors">
            {isUser ? "Open user" : "Edit role"}
          </Link>
        </div>
      </div>

      {isUser && (
        <div className="flex items-center gap-2 px-5 pb-3 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mr-1 flex-shrink-0">{__("Roles")}</span>
          {allRoles.map(r => {
            const on = userRoles.has(r.name);
            return (
              <button key={r.name}
                onClick={() => onToggleUserRole?.(r.name, !on)}
                className={`flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border text-[12px] whitespace-nowrap transition-colors flex-shrink-0
                  ${on ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-input"}`}>
                <Checkbox checked={on} partial={false} />
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white"
                  style={{ background: avatarColor(r.app || r.name) }}>{r.name[0].toUpperCase()}</span>
                {r.name}
              </button>
            );
          })}
          <span className="ml-auto text-[11px] text-muted-foreground/80 whitespace-nowrap pl-4 flex-shrink-0">
            {__("Inherited from roles shows dashed; unchecking an inherited cell denies it for this user only.")}
          </span>
        </div>
      )}
    </div>
  );
}
