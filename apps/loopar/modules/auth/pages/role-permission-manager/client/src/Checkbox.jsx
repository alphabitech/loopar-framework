import { Minus, X, UserRound, Building2 } from "lucide-react";

/**
 * One grid cell.
 *   checked    – direct grant on this subject (exact key)
 *   inherited  – granted through a wildcard (Doc:* / App:x / *:x) or, in
 *                user mode, through one of the user's roles
 *   scope      – 'all' | 'own' (records the user owns) — amber
 *                | 'customer' (records of the user's customers, portal) — sky
 *   denied     – explicit deny (user mode)
 *   na         – the action doesn't exist for this document
 *   title      – tooltip: where the grant comes from
 */
const NARROW = {
  own: { Icon: UserRound, inherited: "border-amber-500/80 bg-amber-500/10", icon: "text-amber-500", solid: "bg-amber-500 ring-amber-500/30" },
  customer: { Icon: Building2, inherited: "border-sky-500/80 bg-sky-500/10", icon: "text-sky-500", solid: "bg-sky-500 ring-sky-500/30" },
};

export function Checkbox({ checked, partial, na, inherited, denied, scope, title, onClick }) {
  const narrow = NARROW[scope];
  if (na) return (
    <div className="inline-flex items-center justify-center w-8 h-8 cursor-default">
      <Minus size={11} className="text-border" strokeWidth={1.5} />
    </div>
  );

  return (
    <div onClick={onClick} title={title}
      className="inline-flex items-center justify-center w-8 h-8 rounded-md cursor-pointer hover:bg-accent transition-colors group">
      {denied ? (
        <div className="w-4 h-4 rounded-[4px] border-[1.5px] border-destructive bg-destructive/15 flex items-center justify-center">
          <X size={9} className="text-destructive" strokeWidth={2.5} />
        </div>
      ) : inherited && narrow ? (
        <div className={`w-4 h-4 rounded-[4px] border-[1.5px] border-dashed ${narrow.inherited} flex items-center justify-center`}>
          <narrow.Icon size={9} className={narrow.icon} strokeWidth={2.5} />
        </div>
      ) : inherited ? (
        <div className="w-4 h-4 rounded-[4px] border-[1.5px] border-dashed border-primary/60 bg-primary/5 flex items-center justify-center">
          <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
            <path d="M1 3.5L3.5 6L8 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary/60"/>
          </svg>
        </div>
      ) : checked && narrow ? (
        <div className={`w-4 h-4 rounded-[4px] ${narrow.solid} ring-2 flex items-center justify-center shadow-sm`}>
          <narrow.Icon size={10} className="text-white" strokeWidth={2.5} />
        </div>
      ) : checked ? (
        <div className="w-4 h-4 rounded-[4px] bg-primary flex items-center justify-center shadow-sm">
          <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
            <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      ) : partial ? (
        <div className="w-4 h-4 rounded-[4px] border-[1.5px] border-amber-500 bg-amber-500/15 flex items-center justify-center">
          <span className="text-[9px] text-amber-500 font-bold leading-none">—</span>
        </div>
      ) : (
        <div className="w-4 h-4 rounded-[4px] border-[1.5px] border-border group-hover:border-primary/50 transition-colors bg-primary/70" />
      )}
    </div>
  );
}
