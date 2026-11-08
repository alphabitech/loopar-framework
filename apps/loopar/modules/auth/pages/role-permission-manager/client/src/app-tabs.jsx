'use strict';

import { Search } from "lucide-react";
import { avatarColor, countAppAssigned, countAppTotal } from "../helper";
import { __ } from "loopar";

export function AppTabs({ permissions, currentApp, onSelect, search, onSearch }) {

  return (
    <div className="flex items-center border-b border-border bg-secondary/80 flex-shrink-0">
      <div className="flex items-center flex-1 min-w-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {Object.entries(permissions).map(([app, docs]) => {
          const color = avatarColor(app);
          const assigned = countAppAssigned(docs);
          const total = countAppTotal(docs);
          const active = currentApp === app;
          return (
            <button key={app} onClick={() => onSelect(app)}
              className={`flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium whitespace-nowrap border-b-2 transition-all flex-shrink-0
                ${active ? "text-foreground border-primary" : "text-muted-foreground border-transparent hover:text-foreground hover:border-border"}`}
              style={{ marginBottom: "-1px" }}>
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
              {app}
              <span className={`text-[10px] px-1 py-0.5 rounded-full border
                ${active ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"}`}>
                {assigned}/{total}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 px-3 border-l border-border flex-shrink-0">
        <Search size={11} className="text-muted-foreground flex-shrink-0" />
        <input
          className="text-[11px] bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground w-28"
          placeholder={__("Filter docs...")}
          value={search}
          onChange={e => onSearch(e.target.value)}
        />
        {search && (
          <button onClick={() => onSearch("")} className="text-muted-foreground hover:text-foreground text-[10px] flex-shrink-0">✕</button>
        )}
      </div>
    </div>
  );
}
