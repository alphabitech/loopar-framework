'use strict';

/**
 * Readable code for the Debugger: SQL highlighted with the Prism renderer
 * the framework already ships (prism-react-renderer, as in example-viewer),
 * plus a console-style block for output, stacks and assertion diffs.
 */

import { useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { cn } from "@cn/lib/utils";

// Clauses that start a new line when a statement is shown in full.
const CLAUSE = /(select|from|where|and|or|order by|group by|having|limit|offset|values|set|returning|union(?: all)?|(?:left |right |inner |full |cross )?(?:outer )?join|on conflict|insert into|update|delete from)\b/iy;

/**
 * Light SQL layout: one clause per line, AND/OR indented, only at the top
 * level (nothing inside parentheses or string literals is touched).
 */
export function formatSql(sql) {
  const s = String(sql ?? "").replace(/\s+/g, " ").trim();
  let out = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; out += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === " ") {
      CLAUSE.lastIndex = i + 1;
      const m = CLAUSE.exec(s);
      if (m && out.length) {
        const kw = m[1].toLowerCase();
        out += kw === "and" || kw === "or" ? "\n  " : "\n";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Highlighted SQL. `full` lays it out clause per line; otherwise one clamped line. */
export function SqlCode({ sql, full = false, className }) {
  const code = full ? formatSql(sql) : String(sql ?? "").replace(/\s+/g, " ").trim();
  return (
    <Highlight theme={themes.vsDark} code={code} language="sql">
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          className={cn(
            "m-0 block w-full min-w-0 max-w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed",
            full ? "max-h-80 overflow-auto whitespace-pre-wrap break-words" : "overflow-hidden text-ellipsis whitespace-nowrap",
            className,
          )}
        >
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })} className={full ? undefined : "inline"}>
              {line.map((token, k) => <span key={k} {...getTokenProps({ token })} />)}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

/** SQL that shows one line and opens to the full, laid-out statement on click. */
export function SqlToggle({ sql, className }) {
  const [open, setOpen] = useState(false);
  return (
    <div role="button" tabIndex={0} title={open ? "Collapse" : "Show the full statement"} className={cn("min-w-0 max-w-full cursor-pointer overflow-hidden", className)}
      onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === "Enter") setOpen((o) => !o); }}>
      <SqlCode sql={sql} full={open} />
    </div>
  );
}

const lineTone = (line) => {
  if (/^\s+at\s/.test(line)) return /node:internal|node_modules/.test(line) ? "text-zinc-600" : "text-sky-300";
  if (/^\+(\s|$)/.test(line)) return "text-emerald-400";
  if (/^-(\s|$)/.test(line)) return "text-red-400";
  if (/^(\w*Error\b|AssertionError|Error:)/.test(line)) return "text-red-400 font-semibold";
  if (/^\[(error|warn)\]/i.test(line)) return "text-amber-300";
  return "";
};

/**
 * Terminal-looking block: dark, monospaced, stack frames dimmed (ours
 * highlighted), `+`/`-` diff lines colored. `lines` may be a string.
 */
export function Console({ children, lines, className, maxHeight = "max-h-80" }) {
  const list = lines ?? String(children ?? "").split("\n");
  return (
    <pre className={cn("m-0 min-w-0 max-w-full overflow-auto rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-200", maxHeight, className)}>
      {list.map((l, i) => {
        const line = typeof l === "string" ? { text: l } : l;
        return (
          <div key={i} className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", line.className ?? lineTone(line.text))}>
            {line.prefix && <span className="mr-2 select-none text-zinc-500">{line.prefix}</span>}
            {line.text || " "}
          </div>
        );
      })}
    </pre>
  );
}
