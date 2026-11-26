'use strict';

import loopar, { __ } from "loopar";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@cn/lib/utils";
import { DynamicIcon } from "@icon";
import { FolderDownIcon, Trash2Icon } from "lucide-react";

/**
 * Dependency graph of the apps on this server, from each app's `requires`
 * (installer.json). Layered layout: an app sits one column to the right of
 * the deepest app it requires; edges are SVG curves measured from the DOM.
 * Hover or click an app to follow its chain (what it needs, what needs it).
 * Apps with no relations at all are listed apart.
 */

/** Nodes, edges, columns and the apps without relations. */
export function buildGraph(apps = []) {
  // Every app depends on the framework, said or not: an app with no other
  // requirement hangs from it; one that requires other apps reaches it
  // through them (no extra edge).
  const framework = apps.find((a) => a.is_framework)?.name;
  const requiresOf = (a) => {
    if (a.is_framework) return [];
    const own = (a.requires || []).filter((r) => r !== framework);
    return own.length || !framework ? own : [framework];
  };
  const byName = new Map(apps.map((a) => [a.name, { ...a, requires: requiresOf(a) }]));

  // A requirement that isn't on this server still gets a node: it blocks installs.
  for (const app of [...byName.values()]) {
    for (const r of app.requires) {
      if (!byName.has(r)) byName.set(r, { name: r, requires: [], missing: true });
    }
  }

  const edges = [];
  for (const node of byName.values()) {
    for (const r of node.requires) edges.push({ from: r, to: node.name });
  }

  const related = new Set(edges.flatMap((e) => [e.from, e.to]));

  // Depth = longest chain of requirements (a cycle is cut where it closes).
  const depth = new Map();
  const visiting = new Set();
  const depthOf = (name) => {
    if (depth.has(name)) return depth.get(name);
    if (visiting.has(name)) return 0;
    visiting.add(name);
    const reqs = byName.get(name)?.requires || [];
    const d = reqs.length ? 1 + Math.max(...reqs.map(depthOf)) : 0;
    visiting.delete(name);
    depth.set(name, d);
    return d;
  };

  const columns = [];
  for (const name of related) {
    const d = depthOf(name);
    (columns[d] ||= []).push(name);
  }

  // Order each column by where its requirements sit (fewer crossings);
  // the first column by how many apps depend on it.
  const dependents = (name) => edges.filter((e) => e.from === name).length;
  const position = new Map();
  columns.forEach((col, i) => {
    if (i === 0) {
      col.sort((a, b) => dependents(b) - dependents(a) || a.localeCompare(b));
    } else {
      const center = (name) => {
        const ps = (byName.get(name)?.requires || []).map((r) => position.get(r)).filter((p) => p != null);
        return ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : Infinity;
      };
      col.sort((a, b) => center(a) - center(b) || a.localeCompare(b));
    }
    col.forEach((name, idx) => position.set(name, idx));
  });

  const standalone = [...byName.values()].filter((n) => !related.has(n.name)).map((n) => n.name).sort();

  return { byName, edges, columns: columns.filter(Boolean), standalone };
}

/** Everything `name` needs and everything that needs it. */
function chainOf(name, edges) {
  const chain = new Set([name]);
  const walk = (current, next) => {
    for (const e of edges) {
      const [a, b] = next === "up" ? [e.to, e.from] : [e.from, e.to];
      if (a === current && !chain.has(b)) {
        chain.add(b);
        walk(b, next);
      }
    }
  };
  walk(name, "up");
  walk(name, "down");
  return chain;
}

/** What the node offers: install what's missing here, uninstall what's installed. */
function nodeAction(node) {
  if (node.is_framework || node.missing || node.folder_mismatch) return null;
  if (node.installed) return { verb: "uninstall", label: __("Uninstall"), Icon: Trash2Icon, danger: true };
  if (!node.template_locked) return { verb: "install", label: __("Install"), Icon: FolderDownIcon };
  return null;
}

function AppNode({ node, registerRef, dimmed, active, onHover, onToggle, onAction }) {
  const color = node.missing ? undefined : loopar.bgColor(node.name);
  const act = onAction && nodeAction(node);
  return (
    // A div, not a button: it holds the action button.
    <div
      role="button"
      tabIndex={0}
      ref={(el) => registerRef(node.name, el)}
      onMouseEnter={() => onHover(node.name)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.name)}
      onBlur={() => onHover(null)}
      onClick={() => onToggle(node.name)}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onToggle(node.name); } }}
      title={node.description || node.name}
      className={cn(
        "group/node relative z-10 flex w-60 cursor-pointer items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-left shadow-sm outline-none transition-[opacity,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring",
        node.missing && "border-dashed border-red-500/60",
        active && "border-primary shadow-md ring-1 ring-primary/40",
        dimmed && "opacity-35"
      )}
    >
      <span
        className={cn(
          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-white",
          node.missing && "bg-red-500/15 text-red-500"
        )}
        style={color ? { backgroundColor: color } : undefined}
      >
        {node.icon
          ? <DynamicIcon icon={{ value: node.icon }} className="h-4 w-4" />
          : <span className="text-xs font-semibold">{loopar.utils.avatar(node.name)}</span>}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{node.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {node.missing
            ? <span className="text-red-500">{__("Not on this server")}</span>
            : node.installed
              ? <span className="text-emerald-500">{__("Installed")}</span>
              : __("Not installed")}
          {node.is_template ? ` · ${__("Template")}` : ""}
        </span>
      </span>
      {act && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAction(node.name, act.verb); }}
          title={`${act.label} ${node.name}`}
          aria-label={`${act.label} ${node.name}`}
          className={cn(
            "flex h-7 flex-shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
            act.danger
              ? "border-transparent text-muted-foreground hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-500"
              : "border-primary/40 text-primary hover:bg-primary/10"
          )}
        >
          <act.Icon className="h-3.5 w-3.5" />
          <span className={cn(act.danger && "hidden group-hover/node:inline group-focus-within/node:inline")}>{act.label}</span>
        </button>
      )}
    </div>
  );
}

export function AppDependencies({ ctrl, onAction }) {
  const apps = ctrl?.Document?.dependencies || [];
  const graph = useMemo(() => buildGraph(apps), [apps]);
  const { byName, edges, columns, standalone } = graph;

  const containerRef = useRef(null);
  const nodeRefs = useRef(new Map());
  const [paths, setPaths] = useState([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState(null);
  const [pinned, setPinned] = useState(null);

  const focus = hovered || pinned;
  const chain = useMemo(() => (focus ? chainOf(focus, edges) : null), [focus, edges]);

  const registerRef = (name, el) => {
    if (el) nodeRefs.current.set(name, el);
    else nodeRefs.current.delete(name);
  };

  // Edges are drawn from the nodes' rendered boxes: re-measured on resize.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const origin = container.getBoundingClientRect();
      setSize({ width: container.scrollWidth, height: container.scrollHeight });
      setPaths(edges.map((e) => {
        const a = nodeRefs.current.get(e.from)?.getBoundingClientRect();
        const b = nodeRefs.current.get(e.to)?.getBoundingClientRect();
        if (!a || !b) return null;
        const x1 = a.right - origin.left + container.scrollLeft;
        const y1 = a.top + a.height / 2 - origin.top;
        const x2 = b.left - origin.left + container.scrollLeft;
        const y2 = b.top + b.height / 2 - origin.top;
        const dx = Math.max(24, (x2 - x1) / 2);
        return { ...e, d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}` };
      }).filter(Boolean));
    };

    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    return () => observer?.disconnect();
  }, [edges, columns]);

  const toggle = (name) => setPinned((p) => (p === name ? null : name));

  if (!apps.length) {
    return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{__("No apps found.")}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{__("Each app sits to the right of the apps it requires. Hover or click an app to follow its chain.")}</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border border-dashed border-red-500/60" />{__("Required but not on this server")}
        </span>
      </div>

      {columns.length > 0 ? (
        <div
          ref={containerRef}
          className="relative overflow-x-auto rounded-xl border bg-muted/20 p-6"
          onClick={(e) => { if (e.target === e.currentTarget) setPinned(null); }}
        >
          <svg
            aria-hidden
            className="pointer-events-none absolute left-0 top-0"
            width={size.width}
            height={size.height}
          >
            {paths.map((p) => {
              const lit = chain && chain.has(p.from) && chain.has(p.to);
              return (
                <path
                  key={`${p.from}->${p.to}`}
                  d={p.d}
                  fill="none"
                  strokeWidth={lit ? 2 : 1.5}
                  className={cn(
                    "transition-[stroke,opacity]",
                    lit ? "stroke-primary" : "stroke-border",
                    chain && !lit && "opacity-30",
                    byName.get(p.from)?.missing && "[stroke-dasharray:4_4]"
                  )}
                />
              );
            })}
          </svg>

          <div className="relative flex w-max gap-20">
            {columns.map((col, i) => (
              <div key={i} className="flex flex-col justify-center gap-3">
                <span className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {i === 0 ? (byName.get(col[0])?.is_framework ? __("Framework") : __("Base")) : `${__("Level")} ${i}`}
                </span>
                {col.map((name) => (
                  <AppNode
                    key={name}
                    node={byName.get(name)}
                    registerRef={registerRef}
                    active={focus === name}
                    dimmed={!!chain && !chain.has(name)}
                    onHover={setHovered}
                    onToggle={toggle}
                    onAction={onAction}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {__("No app requires another one yet.")}
        </div>
      )}

      {standalone.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">{__("Without dependencies")}</h3>
          <div className="flex flex-wrap gap-2">
            {standalone.map((name) => {
              const node = byName.get(name);
              const act = onAction && nodeAction(node);
              return (
                <span key={name} title={node.description || name}
                  className={cn("group/chip inline-flex items-center gap-2 rounded-full border bg-card py-1 pl-1 text-xs", act ? "pr-1" : "pr-3")}>
                  <span className="flex h-5 w-5 items-center justify-center rounded-full text-white" style={{ backgroundColor: loopar.bgColor(name) }}>
                    {node.icon ? <DynamicIcon icon={{ value: node.icon }} className="h-3 w-3" /> : <span className="text-[9px] font-semibold">{loopar.utils.avatar(name)}</span>}
                  </span>
                  {name}
                  {node.installed ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" title={__("Installed")} /> : null}
                  {act && (
                    <button
                      type="button"
                      onClick={() => onAction(name, act.verb)}
                      title={`${act.label} ${name}`}
                      aria-label={`${act.label} ${name}`}
                      className={cn(
                        "flex h-5 w-5 items-center justify-center rounded-full transition-colors",
                        act.danger ? "text-muted-foreground hover:bg-red-500/10 hover:text-red-500" : "text-primary hover:bg-primary/10"
                      )}
                    >
                      <act.Icon className="h-3 w-3" />
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
