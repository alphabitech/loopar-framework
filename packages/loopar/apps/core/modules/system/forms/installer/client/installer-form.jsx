import { useEffect, useMemo, useState } from 'react';
import loopar from 'loopar';
import MetaComponent from '@meta-component';
import { Button } from '@cn/components/ui/button';
import { CheckIcon } from 'lucide-react';
import { cn } from '@cn/lib/utils';
import { useForm } from '@loopar/form';
import { __ } from "loopar";

/** The browser's time zone and language, as installer defaults. */
function browserDefaults() {
  if (typeof window === 'undefined') return {};
  let time_zone = '';
  try { time_zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser */ }
  const language = String(navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en';
  return { time_zone, language };
}

const ENGINE_LABELS = {
  mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite', mssql: 'SQL Server',
};

/** Writable field names inside a structure element. */
function fieldNames(element, acc = []) {
  for (const child of element?.elements || []) {
    if (child.data?.name) acc.push(child.data.name);
    fieldNames(child, acc);
  }
  return acc;
}

/**
 * Progress through the wizard. sm+: numbered steps with labels (completed ones
 * jump back). Phones: "Step n of N" over a segmented bar.
 */
function Stepper({ steps, current, onSelect }) {
  return (
    <nav aria-label={__("Installation steps")} className="mb-8">
      <div className="sm:hidden space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {__("Step")} {current + 1} {__("of")} {steps.length}
        </p>
        <div className="flex gap-1.5">
          {steps.map((step, index) => (
            <span
              key={step.key}
              className={cn("h-1.5 flex-1 rounded-full", index <= current ? "bg-primary" : "bg-muted")}
            />
          ))}
        </div>
      </div>

      <ol className="hidden sm:flex items-center gap-3">
        {steps.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={step.key} className="flex items-center gap-3 flex-1 last:flex-none">
              <button
                type="button"
                disabled={!done}
                aria-current={active ? "step" : undefined}
                onClick={() => done && onSelect(index)}
                className={cn("flex items-center gap-2 text-sm", done ? "cursor-pointer" : "cursor-default")}
              >
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium transition-colors",
                    active && "border-primary bg-primary text-primary-foreground",
                    done && "border-primary text-primary",
                    !active && !done && "text-muted-foreground"
                  )}
                >
                  {done ? <CheckIcon className="size-4" /> : index + 1}
                </span>
                <span className={cn("whitespace-nowrap", active ? "font-medium" : "text-muted-foreground")}>
                  {step.label}
                </span>
              </button>
              {index < steps.length - 1 && (
                <span className={cn("h-px flex-1 transition-colors", done ? "bg-primary" : "bg-border")} />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Install wizard: Database → Organization → Administrator. Each top-level
 * card of the Installer form is a step. Nothing is saved until Install: the
 * "Database" step only tests the connection, so the engine can be changed
 * until the very end, and the install applies connection + organization +
 * administrator in one atomic action.
 */
export default function InstallerForm() {
  const { ctrl, getValue, setValue, getFormValues, send } = useForm();
  const data = ctrl.Document?.data || {};

  const steps = useMemo(
    () => (ctrl.__STRUCTURE__ || []).map((element, index) => ({
      key: element.node || element.data?.key || index,
      label: element.data?.label || `Step ${index + 1}`,
      description: element.data?.description || "",
      element,
      fields: fieldNames(element),
    })),
    [ctrl.__STRUCTURE__]
  );

  const [current, setCurrent] = useState(0);
  // A db.config that already reaches its server (provisioned tenants) can be
  // kept: the step shows it instead of asking for credentials again.
  const [keepConnection, setKeepConnection] = useState(!!Number(data.connection_ready));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const defaults = browserDefaults();
    for (const [field, value] of Object.entries(defaults)) {
      if (value && !getValue?.(field)) setValue?.(field, value);
    }
  }, []);

  const isDatabaseStep = (index) => steps[index]?.fields.includes('db_dialect');
  const isLast = current === steps.length - 1;

  const testConnection = async () => {
    const values = getFormValues();
    const body = Object.fromEntries(
      Object.entries(values).filter(([key, value]) => key.startsWith('db_') && value != null)
    );
    await loopar.call('System', 'testConnection', { body, freeze: true });
  };

  const next = async () => {
    const step = steps[current];
    const skipFields = isDatabaseStep(current) && keepConnection;
    if (!skipFields && !(await ctrl.Form.trigger(step.fields))) return;

    setBusy(true);
    try {
      if (isDatabaseStep(current) && !keepConnection) await testConnection();
      setCurrent(current + 1);
    } catch {
      // The request layer already showed the error; stay on this step.
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!(await ctrl.Form.trigger(steps[current].fields))) return;
    setBusy(true);
    try {
      await send({
        action: 'install',
        query: { app_name: 'loopar', connection: keepConnection ? 'current' : 'new' },
      });
    } catch {
      // Error shown by the request layer; the install was rolled back.
    } finally {
      setBusy(false);
    }
  };

  const engine = ENGINE_LABELS[data.db_dialect] || data.db_dialect;
  const server = data.db_dialect === 'sqlite'
    ? 'local file'
    : [data.db_host, data.db_port].filter(Boolean).join(':');

  return (
    <div className="w-full">
      <Stepper steps={steps} current={current} onSelect={setCurrent} />

      {steps.map((step, index) => (
        <section key={step.key} className={cn("space-y-6", index !== current && "hidden")}>
          <header className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">{step.label}</h2>
            {step.description && <p className="text-sm text-muted-foreground">{step.description}</p>}
          </header>
          {isDatabaseStep(index) && keepConnection ? (
            <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
              <p className="text-sm">
                {__("This workspace already has a database connection:")} <strong>{engine}</strong>
                {server ? <> {__("on")} <strong>{server}</strong></> : null}.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => setKeepConnection(false)}>
                {__("Use another connection")}
              </Button>
            </div>
          ) : (
            <MetaComponent elements={step.element.elements} parent={ctrl} />
          )}
        </section>
      ))}

      <div className="mt-8 flex flex-col-reverse gap-2 border-t pt-6 sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          className={cn(current === 0 && "invisible")}
          disabled={current === 0 || busy}
          onClick={() => setCurrent(current - 1)}
        >
          {__("Back")}
        </Button>
        {isLast ? (
          <Button type="button" variant="destructive" disabled={busy} onClick={install}>
            {__("Install")}
          </Button>
        ) : (
          <Button type="button" disabled={busy} onClick={next}>
            {isDatabaseStep(current) && !keepConnection ? 'Test connection and continue' : 'Continue'}
          </Button>
        )}
      </div>
    </div>
  );
}
