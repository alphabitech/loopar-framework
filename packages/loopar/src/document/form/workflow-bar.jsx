import { useState } from "react";
import loopar from "loopar";
import { Button } from "@cn/components/ui/button";
import { cn } from "@cn/lib/utils";
import { EntryModal } from "@app/entry-modal";

/** Badge colors for workflow states (theme-friendly, light and dark). */
export const STATE_COLORS = {
  gray: "bg-muted text-muted-foreground border-border",
  blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
  amber: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  green: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30",
  red: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30",
  violet: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/30",
};

export function StateBadge({ state, color, className }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
      STATE_COLORS[color] || STATE_COLORS.gray, className)}>
      <span className="size-1.5 rounded-full bg-current" />
      {state}
    </span>
  );
}

/** Flattened field definitions of a doc structure, by name. */
function fieldsByName(docStructure) {
  const out = {};
  const walk = (nodes = []) => nodes.forEach((el) => {
    if (el.data?.name) out[el.data.name] = el;
    walk(el.elements);
  });
  walk(loopar.utils.JSONparse(docStructure, []));
  return out;
}

const SELECT_CLASS = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm";

/** Inputs for a transition's required fields; writes into `values` (a plain object). */
function TransitionFields({ fields, defs, values, current }) {
  return (
    <div className="space-y-3 text-left">
      {fields.map((name) => {
        const el = defs[name] || { element: "input", data: { name } };
        const data = el.data || {};
        const label = data.label || name;
        const options = String(data.options || "").split("\n").filter(Boolean);
        const initial = values[name] ?? current?.[name] ?? "";
        const set = (e) => { values[name] = e.target.value; };
        const id = `wf_${name}`;

        let input;
        if (el.element === "select" && options.length > 1) {
          input = (
            <select id={id} className={SELECT_CLASS} defaultValue={initial} onChange={set}>
              <option value="">Select {label}</option>
              {options.map((o) => {
                const [value, text] = o.split(":");
                return <option key={value} value={value}>{text || value}</option>;
              })}
            </select>
          );
        } else if (el.element === "textarea" || el.element === "markdown_input") {
          input = <textarea id={id} className={cn(SELECT_CLASS, "h-24 py-2")} defaultValue={initial} onChange={set} />;
        } else {
          const type = el.element === "date" ? "date" : el.element === "date_time" ? "datetime-local" : "text";
          input = <input id={id} type={type} className={SELECT_CLASS} defaultValue={initial} onChange={set} />;
        }

        return (
          <label key={name} htmlFor={id} className="block space-y-1.5">
            <span className="text-sm font-medium">{label}</span>
            {input}
          </label>
        );
      })}
    </div>
  );
}

/**
 * Runs a workflow transition: asks the transition's required fields (or its
 * confirm message), calls `{Entity}/transition` and refreshes, or navigates
 * where the transition's method says. Shared by the form and the Kanban board.
 */
export function runTransition({ entity, name, transition, docStructure, current, onDone, onOpen }) {
  const send = (values = {}) => {
    loopar.call(entity, "transition", {
      query: { name },
      body: { action: transition.action, values: JSON.stringify(values) },
      success: (r) => {
        // A document the transition created (worker, opportunity…) opens in
        // a modal when the caller can host one, so the user stays where they
        // are. The caller refreshes when the modal closes: refreshing now
        // would remount the form and drop the modal.
        if (r?.navigate && onOpen) return onOpen(r.navigate, r);
        onDone ? onDone(r) : loopar.refresh();
        if (r?.navigate) loopar.navigate(r.navigate);
      },
    });
  };

  const fields = transition.required_fields || [];
  if (fields.length) {
    const values = {};
    loopar.dialog({
      type: "confirm",
      title: transition.action,
      content: (
        <div className="space-y-3">
          {transition.confirm && <p className="text-sm text-muted-foreground">{transition.confirm}</p>}
          <TransitionFields fields={fields} defs={fieldsByName(docStructure)} values={values} current={current} />
        </div>
      ),
      ok: () => send(values),
    });
    return;
  }

  if (transition.confirm) return loopar.confirm(transition.confirm, () => send());
  send();
}

const VARIANTS = { primary: "default", destructive: "destructive", default: "secondary" };

/**
 * Current state badge + one button per available transition, at the top of
 * the form (not in the AppBar overflow menu: moving the record forward is the
 * main thing to do on it).
 */
export function WorkflowBar({ ctrl }) {
  const Document = ctrl?.Document || {};
  const [opened, setOpened] = useState(null);
  const workflow = Document.workflow;

  if (!workflow || Document.isNew) return null;
  const transitions = workflow.transitions || [];

  const run = (t) => (e) => {
    e.preventDefault();
    runTransition({
      entity: Document.Entity?.name,
      name: Document.name,
      transition: t,
      docStructure: Document.Entity?.doc_structure,
      current: Document.data,
      onOpen: setOpened,
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <span className="text-sm text-muted-foreground">Status</span>
        <StateBadge state={workflow.state} color={workflow.color} />
        {transitions.length > 0 && <span className="mx-1 h-5 w-px bg-border" />}
        {transitions.map((t) => (
          <Button key={t.action} size="sm" variant={VARIANTS[t.style] || "secondary"} onClick={run(t)}>
            {t.action}
          </Button>
        ))}
      </div>
      {opened && <EntryModal initialPath={opened} onClose={() => { setOpened(null); loopar.refresh(); }} />}
    </>
  );
}
