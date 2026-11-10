import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, EyeOff, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import loopar from "loopar";
import Icon from "@icon";
import { cn } from "@cn/lib/utils";
import { useDesigner } from "@context/designer-context";
import { elementsDict } from "@global/element-definition";
import { getNodeKey } from "@global/prune-doc-structure";
import { __ } from "@global/i18n";

// Same hues the canvas uses for layout outlines (section → row → col).
const ICON_TONE = {
  section: "text-sky-600 dark:text-sky-400",
  row: "text-amber-600 dark:text-amber-400",
  grid: "text-amber-600 dark:text-amber-400",
  col: "text-emerald-600 dark:text-emerald-400",
};

const INDENT = 12;

const canContain = (element) => global.elementIsDroppable(element);

const snippetOf = (data = {}) => {
  const raw = data.label || data.title || data.text || data.name || "";
  return String(raw).replace(/[#*_`>\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
};

const flatten = (elements, collapsed, depth = 0, parentKey = null, out = []) => {
  (elements || []).forEach((el, index) => {
    if (!el?.data) return;
    const key = getNodeKey(el);
    const children = (el.elements || []).filter(c => c?.data);
    out.push({ key, el, depth, parentKey, index, hasChildren: children.length > 0 });
    if (children.length && !collapsed.has(key)) flatten(children, collapsed, depth + 1, key, out);
  });
  return out;
};

const ancestorsOf = (elements, key, trail = []) => {
  for (const el of elements || []) {
    if (!el?.data) continue;
    const k = getNodeKey(el);
    if (k === key) return trail;
    const found = ancestorsOf(el.elements, key, [...trail, k]);
    if (found) return found;
  }
  return null;
};

const canvasNode = (key) =>
  key ? document.querySelector(`[data-node-key="${CSS.escape(key)}"]`) : null;

export function Navigator() {
  const { metaTree, updatingElement, selectElement, moveElement } = useDesigner();
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [drop, setDrop] = useState(null); // { key, position }
  const draggingRef = useRef(null);
  const listRef = useRef(null);
  const hoverRef = useRef(null);

  const selectedKey = updatingElement ? getNodeKey(updatingElement) : null;
  const rows = useMemo(() => flatten(metaTree, collapsed), [metaTree, collapsed]);
  const parentOf = useMemo(() => {
    const map = {};
    const walk = (elements, parent) => (elements || []).forEach(el => {
      if (!el?.data) return;
      const k = getNodeKey(el);
      map[k] = parent;
      walk(el.elements, el);
    });
    walk(metaTree, null);
    return map;
  }, [metaTree]);

  // Reveal the selected node: expand its ancestors and scroll its row into view.
  useEffect(() => {
    if (!selectedKey) return;
    const ancestors = ancestorsOf(metaTree, selectedKey) || [];
    if (ancestors.some(k => collapsed.has(k))) {
      setCollapsed(prev => {
        const next = new Set(prev);
        ancestors.forEach(k => next.delete(k));
        return next;
      });
      return;
    }
    const row = listRef.current?.querySelector(`[data-nav-key="${CSS.escape(selectedKey)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedKey, metaTree, collapsed]);

  // Canvas highlight while hovering a row (inline, no re-render of the canvas).
  const clearHover = useCallback(() => {
    const prev = hoverRef.current;
    if (prev) {
      prev.el.style.outline = prev.outline;
      prev.el.style.outlineOffset = prev.outlineOffset;
    }
    hoverRef.current = null;
  }, []);

  const hoverCanvas = useCallback((key) => {
    clearHover();
    const el = canvasNode(key);
    if (!el) return;
    hoverRef.current = { el, outline: el.style.outline, outlineOffset: el.style.outlineOffset };
    el.style.outline = "2px solid var(--color-primary)";
    el.style.outlineOffset = "2px";
  }, [clearHover]);

  useEffect(() => clearHover, [clearHover]);

  const toggle = (key) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const collapseAll = () => setCollapsed(new Set(rows.filter(r => r.hasChildren).map(r => r.key)));
  const expandAll = () => setCollapsed(new Set());

  const select = (key) => {
    selectElement(key);
    const el = canvasNode(key);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 80 || r.top > window.innerHeight - 80) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  // Whether `dragged` may become a child of `parentEl` (null = page root).
  // Elements that declare a parent (col → row, tab → tabs) only live there;
  // anything else goes into any container, as on the canvas.
  const allowedIn = (dragged, parentEl) => {
    const draggedDef = elementsDict[dragged.element]?.def || {};
    const parentElement = parentEl?.element ?? null;
    if (draggedDef.parent && draggedDef.parent !== parentElement) return false;
    if (parentEl && !canContain(parentElement)) return false;
    return true;
  };

  const isDescendant = (key, ofKey) => {
    let p = parentOf[key];
    while (p) {
      const pk = getNodeKey(p);
      if (pk === ofKey) return true;
      p = parentOf[pk];
    }
    return false;
  };

  const resolveDrop = (e, row) => {
    const dragged = draggingRef.current;
    if (!dragged || dragged.key === row.key || isDescendant(row.key, dragged.key)) return null;

    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const container = canContain(row.el.element);
    const parentEl = parentOf[row.key] || null;

    const candidates = container
      ? (y < 0.25 ? ["before", "inside"] : y > 0.75 ? ["after", "inside"] : ["inside", y < 0.5 ? "before" : "after"])
      : [y < 0.5 ? "before" : "after"];

    for (const position of candidates) {
      const target = position === "inside" ? row.el : parentEl;
      if (allowedIn(dragged.el, target)) return { key: row.key, position };
    }
    return null;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-10 flex items-center gap-1 bg-background dark:bg-background-dark px-3 py-2">
        <span className="text-sm font-semibold">{__("Navigator")}</span>
        <span className="text-xs text-muted-foreground">{rows.length}</span>
        <button
          type="button"
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={__("Expand all")}
          onClick={expandAll}
        >
          <ChevronsUpDown className="h-4 w-4"/>
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={__("Collapse all")}
          onClick={collapseAll}
        >
          <ChevronsDownUp className="h-4 w-4"/>
        </button>
      </div>

      <div
        ref={listRef}
        role="tree"
        className="flex flex-col pb-4"
        onMouseLeave={clearHover}
      >
        {rows.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">{__("This page has no elements yet.")}</p>
        )}
        {rows.map(row => {
          const { key, el, depth, hasChildren } = row;
          const def = elementsDict[el.element]?.def || {};
          const isSelected = key === selectedKey;
          const isCollapsed = collapsed.has(key);
          const hidden = [true, "true", 1, "1"].includes(el.data?.hidden);
          const snippet = snippetOf(el.data);
          const dropHere = drop?.key === key ? drop.position : null;

          return (
            <div
              key={key}
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={hasChildren ? !isCollapsed : undefined}
              data-nav-key={key}
              draggable
              className={cn(
                "group relative flex h-7 shrink-0 cursor-pointer select-none items-center gap-1 pr-2 text-sm",
                isSelected ? "bg-primary/15 text-foreground" : "hover:bg-muted",
                dropHere === "inside" && "bg-primary/10 ring-1 ring-inset ring-primary",
                hidden && "opacity-50"
              )}
              style={{ paddingLeft: 4 + depth * INDENT }}
              onClick={() => select(key)}
              onMouseEnter={() => hoverCanvas(key)}
              onDragStart={(e) => {
                draggingRef.current = { key, el };
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", key);
                clearHover();
              }}
              onDragOver={(e) => {
                const target = resolveDrop(e, row);
                if (!target) {
                  drop?.key === key && setDrop(null);
                  return;
                }
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (drop?.key !== target.key || drop?.position !== target.position) setDrop(target);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget) && drop?.key === key) setDrop(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const dragged = draggingRef.current;
                const target = drop;
                setDrop(null);
                draggingRef.current = null;
                if (!dragged || !target) return;
                moveElement(dragged.key, target.key, target.position);
                if (target.position === "inside") {
                  setCollapsed(prev => {
                    const next = new Set(prev);
                    next.delete(target.key);
                    return next;
                  });
                }
              }}
              onDragEnd={() => {
                draggingRef.current = null;
                setDrop(null);
              }}
            >
              {(dropHere === "before" || dropHere === "after") && (
                <span
                  className={cn(
                    "pointer-events-none absolute right-1 h-0.5 rounded-full bg-primary",
                    dropHere === "before" ? "-top-px" : "-bottom-px"
                  )}
                  style={{ left: 4 + depth * INDENT }}
                />
              )}
              <span
                className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground", hasChildren && "hover:bg-muted-foreground/20")}
                onClick={(e) => {
                  if (!hasChildren) return;
                  e.stopPropagation();
                  toggle(key);
                }}
              >
                {hasChildren && (
                  <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", !isCollapsed && "rotate-90")}/>
                )}
              </span>
              <Icon
                data={{ icon: def.icon || "Box" }}
                className={cn("h-3.5 w-3.5 shrink-0", ICON_TONE[el.element] || "text-muted-foreground")}
              />
              <span className="shrink-0">{loopar.utils.Capitalize(String(el.element || "").replaceAll("_", " "))}</span>
              {snippet && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">{snippet}</span>
              )}
              {hidden && <EyeOff className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground"/>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
