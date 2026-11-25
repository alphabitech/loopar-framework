import { Fragment } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import { ActionButton, normalizeActions } from "../chrome/toolbar";
import { useViewOptions } from "../base/view-options";

/**
 * Where a record stands in its process and what comes next — the `flow` view
 * option of a form, drawn between the header and the fields:
 *
 *   flow: {
 *     steps: [{ key, label, hint?, state: "done" | "current" | "todo" | "skipped" }],
 *     next?: {
 *       title, description?,           // what happens now, in plain words
 *       tone?: "default" | "warning" | "danger" | "muted",
 *       actions?: { key: action },     // same descriptors as `actions`; the first `primary` is filled
 *       links?: [{ label, to }],       // related records worth a click (the invoice a credit note credits…)
 *     },
 *   }
 *
 * Steps are information; the actions are the step's own (the header keeps the rest).
 * `flow` may be a function (evaluated on render) or null/undefined (nothing drawn).
 */
const TONES = {
  default: "border-border bg-muted/30",
  muted: "border-border bg-muted/40 text-muted-foreground",
  warning: "border-amber-500/40 bg-amber-500/10",
  danger: "border-red-500/40 bg-red-500/10",
};

function StepDot({ state, index }) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
        state === "done" && "border-primary bg-primary text-primary-foreground",
        state === "current" && "border-primary bg-background text-primary ring-4 ring-primary/15",
        state === "todo" && "border-border bg-background text-muted-foreground",
        state === "skipped" && "border-dashed border-border bg-background text-muted-foreground"
      )}
    >
      {state === "done" ? <CheckIcon className="size-3.5" /> : index + 1}
    </span>
  );
}

function Steps({ steps }) {
  return (
    <ol className="flex min-w-0 items-start gap-2 overflow-x-auto pb-1" aria-label="Progress">
      {steps.map((step, i) => (
        <Fragment key={step.key || step.label}>
          {i > 0 && (
            <li aria-hidden="true" className={cn(
              "mt-3 h-px min-w-6 flex-1",
              ["done", "current"].includes(step.state) ? "bg-primary" : "bg-border",
              step.state === "skipped" && "border-t border-dashed border-border bg-transparent"
            )} />
          )}
          <li className="flex shrink-0 items-start gap-2" aria-current={step.state === "current" ? "step" : undefined}>
            <StepDot state={step.state} index={i} />
            <span className="flex flex-col leading-tight">
              <span className={cn(
                "text-sm",
                step.state === "current" ? "font-semibold text-foreground" : "text-muted-foreground",
                step.state === "done" && "text-foreground",
                step.state === "skipped" && "line-through decoration-muted-foreground/50"
              )}>
                {step.label}
              </span>
              {step.hint && <span className="text-xs text-muted-foreground">{step.hint}</span>}
            </span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function Next({ next }) {
  const actions = normalizeActions(next.actions);
  const primary = actions.find((a) => a.primary);
  const links = (next.links || []).filter((l) => l?.to && l?.label);

  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center", TONES[next.tone] || TONES.default)}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold text-foreground">{next.title}</p>
        {next.description && <p className="text-sm text-muted-foreground">{next.description}</p>}
        {links.length > 0 && (
          <p className="flex flex-wrap gap-x-3 text-sm">
            {links.map((l) => (
              <Link key={l.to} to={l.to} variant="link" className="h-auto p-0">{l.label}</Link>
            ))}
          </p>
        )}
      </div>
      {actions.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 [&_:is(a,button)]:h-9">
          {/* The step's main action last, where the eye ends (like a dialog's OK). */}
          {actions.filter((a) => a !== primary).map((a) => <ActionButton key={a.key} action={a} variant="outline" />)}
          {primary && <ActionButton action={primary} variant="default" />}
        </div>
      )}
    </div>
  );
}

export function DocumentFlow() {
  const { flow } = useViewOptions();
  const value = typeof flow === "function" ? flow() : flow;
  if (!value || (!value.steps?.length && !value.next)) return null;

  return (
    <section data-print-hide className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      {value.steps?.length > 0 && <Steps steps={value.steps} />}
      {value.next && <Next next={value.next} />}
    </section>
  );
}
