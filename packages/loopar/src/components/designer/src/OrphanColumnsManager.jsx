import { useState, useEffect, useCallback } from "react";
import loopar from "loopar";
import {
  AlertTriangle,
  Trash2,
  Unlock,
  RotateCcw,
  RefreshCw,
  Database,
  CheckCircle2,
  XCircle,
  Info,
  Clock,
  ShieldOff,
  ShieldCheck,
} from "lucide-react";
import { __ } from "@global/i18n";

const COLUMN_STATES = {
  ORPHAN: "orphan",
  RELEASED: "released",
  RESTORED: "restored",
};

const ACTIONS = {
  RELEASE: "release",
  DROP: "drop",
  RESTORE: "restore",
};


function relativeDate(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const d    = Math.floor(diff / 86_400_000);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

function StatusBadge({ col }) {
  if (col.state === COLUMN_STATES.RELEASED) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded
                       bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
        <ShieldOff size={11} />
        {__("released")}
      </span>
    );
  }
  if (col.state === COLUMN_STATES.RESTORED) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded
                       bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
        <ShieldCheck size={11} />
        {__("pending restore")}
      </span>
    );
  }
  if (!col.nullable) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded
                       bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
        <XCircle size={11} />
        {__("NOT NULL")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded
                     bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
      <CheckCircle2 size={11} />
      {__("nullable")}
    </span>
  );
}

function TypeBadge({ type }) {
  return (
    <code className="text-xs px-1.5 py-0.5 rounded
                     bg-[--color-surface-2,theme(colors.zinc.100)] dark:bg-zinc-800
                     text-[--color-text-muted,theme(colors.zinc.500)]
                     border border-zinc-200 dark:border-zinc-700 font-mono">
      {type}
    </code>
  );
}


const CONFIRM_CONFIG = {
  [ACTIONS.DROP]: {
    icon:       <Trash2 size={36} className="text-red-500" />,
    title:      "Drop column permanently?",
    body: (col, doc) => (
      <>
        <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded font-mono">{col.name}</code>
        {" "}{__("will be permanently removed from")}{" "}
        <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded font-mono">{doc}</code>.
        {" "}<strong className="text-red-500">{__("All data in this column will be lost")}</strong> {__("and this action cannot be undone.")}
      </>
    ),
  },
  [ACTIONS.RELEASE]: {
    icon:       <Unlock size={36} className="text-amber-500" />,
    title:      "Release column constraints?",
    body: (col) => (
      <>
        {__("Removes")} <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded font-mono">NOT NULL</code>,{" "}
        <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded font-mono">DEFAULT</code> {__("and")}{" "}
        <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded font-mono">UNIQUE</code> {__("from")}{" "}
        <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded font-mono">{col.name}</code>.
        {" "}{__("The column stays in the database and data is preserved.")}
      </>
    ),
  },
  [ACTIONS.RESTORE]: {
    icon:       <RotateCcw size={36} className="text-blue-500" />,
    title:      "Restore column to structure?",
    body: (col) => (
      <>
        <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded font-mono">{col.name}</code>
        {" "}{__("will be re-added to the field structure on the next")}{" "}
        <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded font-mono">makeTable</code> {__("call. Existing data is preserved.")}
      </>
    ),
  },
};


function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3
                    text-zinc-400 dark:text-zinc-600">
      <Database size={32} strokeWidth={1.25} />
      <p className="text-sm">{__("No orphan columns found")}</p>
    </div>
  );
}

function ColumnRow({ col, onAction }) {
  const isInactive = col.state !== COLUMN_STATES.ORPHAN;

  return (
    <tr className={`group border-b border-zinc-100 dark:border-zinc-800 last:border-0
                    transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50
                    ${isInactive ? "opacity-50" : ""}`}>

      <td className="py-3 pl-4 pr-3">
        <div className="flex items-center gap-2">
          <code className="text-xs font-mono font-medium text-zinc-800 dark:text-zinc-200">
            {col.name}
          </code>
          {col.default !== null && col.default !== undefined && (
            <span className="text-[10px] text-zinc-400 dark:text-zinc-600">
              {__("default:")} {String(col.default)}
            </span>
          )}
        </div>
      </td>

      <td className="py-3 px-3">
        <TypeBadge type={col.type} />
      </td>

      <td className="py-3 px-3">
        <StatusBadge col={col} />
      </td>

      <td className="py-3 px-3">
        <span className="flex items-center gap-1.5 text-xs text-zinc-400 dark:text-zinc-600">
          <Clock size={11} />
          {relativeDate(col.detected_at)}
        </span>
      </td>

      <td className="py-3 pl-3 pr-4">
        {col.state === COLUMN_STATES.RESTORED ? (
          <span className="text-xs text-zinc-400 italic">{__("queued")}</span>
        ) : (
          <div className="flex items-center gap-1.5 justify-end">
            <button
              disabled={col.state === COLUMN_STATES.RELEASED}
              title={__("Release constraints (NOT NULL, UNIQUE)")}
              onClick={() => onAction(ACTIONS.RELEASE, col)}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg
                         border border-amber-200 dark:border-amber-900/60
                         text-amber-700 dark:text-amber-400
                         hover:bg-amber-50 dark:hover:bg-amber-900/20
                         disabled:opacity-30 disabled:cursor-not-allowed
                         transition-colors"
            >
              <Unlock size={12} />
              {__("Release")}
            </button>

            <button
              title={__("Restore column to field structure")}
              onClick={() => onAction(ACTIONS.RESTORE, col)}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg
                         border border-blue-200 dark:border-blue-900/60
                         text-blue-700 dark:text-blue-400
                         hover:bg-blue-50 dark:hover:bg-blue-900/20
                         transition-colors"
            >
              <RotateCcw size={12} />
              {__("Restore")}
            </button>

            <button
              title={__("Drop column permanently from the table")}
              onClick={() => onAction(ACTIONS.DROP, col)}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg
                         border border-red-200 dark:border-red-900/60
                         text-red-600 dark:text-red-400
                         hover:bg-red-50 dark:hover:bg-red-900/20
                         transition-colors"
            >
              <Trash2 size={12} />
              {__("Drop")}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: COLUMN_STATES.ORPHAN, label: "Active orphans" },
  { key: COLUMN_STATES.RELEASED, label: "Released" },
  { key: COLUMN_STATES.RESTORED, label: "Restored" },
];

function FilterBar({ active, counts, onChange }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {FILTERS.map((f) => {
        const count = f.key === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : (counts[f.key] || 0);
        const isActive = active === f.key;
        return (
          <button
            key={f.key}
            onClick={() => onChange(f.key)}
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border
                        transition-colors
                        ${isActive
                          ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 border-transparent font-medium"
                          : "border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
          >
            {f.label}
            {count > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full
                               ${isActive
                                 ? "bg-white/20 dark:bg-black/20"
                                 : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function OrphanColumnsManager({
  document: doc = "Document",
  columns  = [],
  onRefresh,
  loading  = false,
}) {
  const [cols,    setCols]    = useState(() => columns.map((c, i) => ({ ...c, _id: i })));
  const [filter,  setFilter]  = useState("all");
  const [working, setWorking] = useState(false);

  const loadColumns = () => {
    loopar.call("Entity", "orphanColumns", {
      query: { name: doc },
      success: (c) => {
        setCols(c.map((c, i) => ({ ...c, _id: i })));
      }
    })
  }
  useEffect(() => {
    loadColumns()
  }, []);


  const handleAction = useCallback((action, col) => {
    const confirm = CONFIRM_CONFIG[action];
    confirm.content = confirm.body(col);
    loopar.confirm(confirm, () => handleConfirm(action, col))
  }, []);

  const handleConfirm = useCallback(async (action, col) => {
    setWorking(true);

    try {
      if (action === ACTIONS.RELEASE) {
        loopar.call("Entity", "releaseColumn", {
          query: { name: document, column: col.name },
          success: () => {
            loopar.notify(`Constraints released on "${col.name}"`, "warn")
            loadColumns()
          }
        })
        /* await onRelease?.(col);
        setCols((prev) =>
          prev.map((c) => c._id === col._id ? { ...c, state: COLUMN_STATES.RELEASED, nullable: true } : c)
        );
        loopar.notify(`Constraints released on "${col.name}"`, "warn") */

      } else if (action === ACTIONS.DROP) {
        loopar.call("Entity", "dropColumn", {
          query: { name: document, column: col.name },
          success: () => {
            loopar.notify(`Column "${col.name}" dropped permanently`)
            loadColumns()
          }
        })
        /* await onDrop?.(col);
        setCols((prev) => prev.filter((c) => c._id !== col._id));
        loopar.notify(`Column "${col.name}" dropped permanently`) */

      } else if (action === ACTIONS.RESTORE) {
        loopar.call("Entity", "restoreColumn", {
          query: { name: document, column: col.name },
          success: () => {
            loopar.notify(`"${col.name}" queued for restore`)
            loadColumns()
          }
        })
        /* await onRestore?.(col);
        setCols((prev) =>
          prev.map((c) => c._id === col._id ? { ...c, state: COLUMN_STATES.RESTORED } : c)
        );
        loopar.notify(`"${col.name}" queued for restore`) */
      }
    } catch (err) {
      loopar.notify(err?.message || "Operation failed", "error")
    } finally {
      setWorking(false);
    }
  }, []);

  const counts = cols.reduce((acc, c) => {
    acc[c.state] = (acc[c.state] || 0) + 1;
    return acc;
  }, {});

  const visible = filter === "all" ? cols : cols.filter((c) => c.state === filter);

  const hasBlockers = cols.some(
    (c) => c.state === COLUMN_STATES.ORPHAN && !c.nullable
  );

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800">
              <Database size={16} className="text-zinc-500 dark:text-zinc-400" />
            </div>
            <div>
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {__("Orphan columns")}
              </h2>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                <code className="font-mono">{doc}</code> — {cols.length} {__("column")}{cols.length !== 1 ? "s" : ""} {__("removed from field structure")}
              </p>
            </div>
          </div>

          <button
            onClick={onRefresh}
            disabled={loading || working}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       border border-zinc-200 dark:border-zinc-700
                       text-zinc-500 dark:text-zinc-400
                       hover:bg-zinc-50 dark:hover:bg-zinc-800
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {__("Refresh")}
          </button>
        </div>

        {hasBlockers && (
          <div className="flex items-start gap-2.5 p-3 rounded-lg
                          bg-red-50 dark:bg-red-900/10
                          border border-red-200 dark:border-red-900/40
                          text-red-700 dark:text-red-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p className="text-xs leading-relaxed">
              {__("One or more orphan columns still carry")} <strong>{__("NOT NULL")}</strong> {__("constraints. New records are currently padded at runtime to avoid constraint errors. Use")} <strong>{__("Release")}</strong> {__("to fix the schema, or")} <strong>{__("Drop")}</strong> {__("to remove the column.")}
            </p>
          </div>
        )}

        {(counts[COLUMN_STATES.RELEASED] || 0) > 0 && (
          <div className="flex items-start gap-2.5 p-3 rounded-lg
                          bg-amber-50 dark:bg-amber-900/10
                          border border-amber-200 dark:border-amber-900/40
                          text-amber-700 dark:text-amber-400">
            <Info size={14} className="mt-0.5 shrink-0" />
            <p className="text-xs leading-relaxed">
              {__("Released columns have no constraints but still occupy space in the table. Drop them when you are confident the data is no longer needed.")}
            </p>
          </div>
        )}

        {cols.length > 0 && (
          <FilterBar active={filter} counts={counts} onChange={setFilter} />
        )}

        <div className="ounded-xl border border-zinc-200 dark:border-zinc-800 overflow-x-auto">
          {visible.length === 0 ? (
            <EmptyState />
          ) : (
            <table className="w-full text-left border-collapse min-w-[640px]">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-800/60">
                  {["Column", "Type", "Status", "Detected", "Actions"].map((h) => (
                    <th
                      key={h}
                      className={`text-[11px] font-medium uppercase tracking-wide
                                  text-zinc-400 dark:text-zinc-500
                                  border-b border-zinc-200 dark:border-zinc-800
                                  py-2.5 px-3 first:pl-4 last:pr-4
                                  ${h === "Actions" ? "text-right" : ""}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((col) => (
                  <ColumnRow
                    key={col._id}
                    col={col}
                    onAction={handleAction}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {cols.length > 0 && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-600 leading-relaxed">
            {__("Orphan columns are detected automatically during")}{" "}
            <code className="font-mono">makeTable</code>{__(". Dropped columns cannot be recovered — ensure you have a database backup before dropping.")}
          </p>
        )}
      </div>
    </>
  );
}