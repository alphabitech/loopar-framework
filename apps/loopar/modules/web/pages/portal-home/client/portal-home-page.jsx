'use strict';

import { useEffect, useState } from 'react';
import { loopar, __ } from 'loopar';
import { Link } from '@link';
import { Button, buttonVariants } from '@cn/components/ui/button';
import { cn } from '@cn/lib/utils';
import { FileText, KeyRound, LayoutDashboard, RefreshCw, ShieldAlert } from 'lucide-react';

/** Portal page: always opens at the top. */
export const config = { restoreScroll: false };

const call = (action) => new Promise((resolve, reject) => {
  loopar.call('Portal Home', action, { freeze: false, success: resolve, error: reject });
});

const TONES = {
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  red: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
  blue: 'bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30',
  gray: 'bg-muted text-muted-foreground border-border',
};

/** Usual status words → tone; anything else is gray. */
const STATUS_TONE = {
  paid: 'green', approved: 'green', accepted: 'green', signed: 'green', completed: 'green', active: 'green',
  sent: 'blue', open: 'blue', pending: 'amber', 'partially paid': 'amber', draft: 'gray',
  overdue: 'red', declined: 'red', rejected: 'red', cancelled: 'gray', canceled: 'gray', expired: 'gray',
};

function Status({ value }) {
  if (!value) return null;
  const tone = STATUS_TONE[String(value).toLowerCase()] || 'gray';
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium', TONES[tone])}>
      <span className="size-1.5 rounded-full bg-current" />
      {__(value)}
    </span>
  );
}

function Section({ section }) {
  const hasStatus = section.rows.some((r) => r.status);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <FileText className="h-4 w-4 text-muted-foreground" /> {__(section.label)}
          <span className="text-xs font-normal text-muted-foreground">({section.total})</span>
        </h2>
        {section.more && <Link to={section.more} variant="ghost" size="sm">{__("View all")}</Link>}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{__("Number")}</th>
              {section.columns.map((c) => (
                <th key={c.name} className={cn('px-4 py-2 font-medium', c.numeric && 'text-right')}>{__(c.label)}</th>
              ))}
              {hasStatus && <th className="px-4 py-2 font-medium">{__("Status")}</th>}
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {section.rows.map((row) => (
              <tr key={row.name} className="border-t">
                <td className="px-4 py-2 font-medium">
                  {row.open ? <a href={row.open} className="underline-offset-4 hover:underline">{row.name}</a> : row.name}
                </td>
                {section.columns.map((c) => (
                  <td key={c.name} className={cn('px-4 py-2', c.numeric && 'text-right tabular-nums')}>{row.cells[c.name] ?? '—'}</td>
                ))}
                {hasStatus && <td className="px-4 py-2"><Status value={row.status} /></td>}
                <td className="px-4 py-2">
                  <div className="flex justify-end gap-2">
                    {row.actions.map((a) => (
                      <a key={a.href} href={a.href} className={buttonVariants({ size: 'sm', variant: a.primary ? 'default' : 'outline' })}>{__(a.label)}</a>
                    ))}
                    {row.open && (
                      <a href={row.open} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>{__("Open")}</a>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function PortalHomePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    setError(null);
    call('summary').then(setData).catch((e) => setError(e?.message || __("We could not load your account.")));
  };

  useEffect(load, []);

  if (error) {
    return (
      <div className="mx-auto max-w-xl space-y-2 rounded-xl border border-border bg-card p-6 text-center">
        <ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return <p className="p-6 text-center text-sm text-muted-foreground">{__("Loading…")}</p>;

  const { account, sections, pages = [] } = data;

  return (
    <div className="space-y-5 py-2">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{__("Hello")}, {account.name}</h1>
          {account.email && <p className="text-sm text-muted-foreground">{account.email}</p>}
        </div>
        <Button size="sm" variant="ghost" onClick={load}><RefreshCw className="mr-1 h-4 w-4" /> {__("Refresh")}</Button>
      </header>

      {account.must_change_password && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <span className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> {__("Choose a password so you can sign in any time.")}</span>
          <Link to="/portal/Profile/update" size="sm">{__("Set password")}</Link>
        </div>
      )}

      {pages.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pages.map((p) => (
            <a key={p.page} href={p.href} className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50">
              <LayoutDashboard className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <span className="min-w-0">
                <span className="block font-semibold group-hover:text-primary">{__(p.label)}</span>
                {p.description && <span className="block text-sm text-muted-foreground">{__(p.description)}</span>}
              </span>
            </a>
          ))}
        </div>
      )}

      {sections.map((s) => <Section key={s.entity} section={s} />)}

      {!sections.length && !pages.length && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {account.desk_user
            ? __("You are signed in with a staff account. This page lists the documents of portal users (customers).")
            : __("You have no documents yet. They will appear here as soon as we share them with you.")}
        </div>
      )}
    </div>
  );
}
