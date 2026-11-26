'use strict';

import { ListLayout } from '@loopar/list';
import loopar from "loopar";
import { useEffect, useRef, useState } from "react";

import { Card } from '@cn/components/ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@cn/components/ui/dropdown-menu';
import { cn } from "@cn/lib/utils";

import { titleize } from "inflection";
import {Link} from "@link"
import {Button} from "@cn/components/ui/button";
import { DynamicIcon } from "@icon";
import {
  PlusIcon,
  DownloadIcon,
  RefreshCcwDotIcon,
  FolderDownIcon,
  Trash2Icon,
  CheckCircle2Icon,
  PencilIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  RotateCcwIcon,
  InfinityIcon,
  CloudUploadIcon,
  TriangleAlertIcon,
  LayoutTemplateIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  NetworkIcon,
  DatabaseZapIcon,
} from 'lucide-react';
import { AppDependencies } from './app-dependencies';
import { openJobProgress, useJobEvents, isActiveJob, shouldPoll } from '@@components/job-progress';
import { __ } from "loopar";

const fieldClass = "w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground";

/**
 * Publish form. The dialog's OK button reads `state`, which this component
 * keeps in sync (the dialog API has no form-value channel).
 */
function PublishForm({ appName, accounts, state }) {
  const initial = accounts[0];
  const [account, setAccount] = useState(initial.name);
  const current = accounts.find(a => a.name === account) || initial;
  const [owner, setOwner] = useState(current.username);
  const [repo, setRepo] = useState(appName);
  const [isPrivate, setIsPrivate] = useState(true);

  Object.assign(state, { account, owner, repo, private: isPrivate ? 1 : 0 });

  const owners = current.owners.length ? current.owners : [current.username];

  return (
    <div className="space-y-3 text-left">
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{__("Git account")}</span>
        <select className={fieldClass} value={account} onChange={(e) => {
          const next = accounts.find(a => a.name === e.target.value);
          setAccount(e.target.value);
          setOwner(next?.username || '');
        }}>
          {accounts.map(a => (
            <option key={a.name} value={a.name}>{a.name}{a.is_default ? ' (default)' : ''}</option>
          ))}
        </select>
      </label>
      <div className="flex items-end gap-2">
        <label className="block flex-1 space-y-1">
          <span className="text-xs text-muted-foreground">{__("Owner")}</span>
          <select className={fieldClass} value={owner} onChange={(e) => setOwner(e.target.value)}>
            {owners.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <span className="pb-2 text-muted-foreground">/</span>
        <label className="block flex-1 space-y-1">
          <span className="text-xs text-muted-foreground">{__("Repository")}</span>
          <input className={fieldClass} value={repo} onChange={(e) => setRepo(e.target.value)} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
        {__("Private (only used when the repository is created)")}
      </label>
      <p className="text-xs text-muted-foreground">
        {__("If")} <code>{owner}/{repo}</code> {__("doesn't exist it will be created, then the app is committed and pushed.")}
      </p>
    </div>
  );
}

function compareVersion(a, b) {
  const pa = (a || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = (b || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

const TONES = {
  neutral: 'bg-muted/60 text-muted-foreground ring-border',
  green: 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/25',
  amber: 'bg-amber-500/10 text-amber-500 ring-amber-500/25',
  yellow: 'bg-yellow-500/10 text-yellow-500 ring-yellow-500/25',
  orange: 'bg-orange-500/10 text-orange-500 ring-orange-500/25',
  blue: 'bg-blue-500/10 text-blue-400 ring-blue-500/25',
  violet: 'bg-violet-500/10 text-violet-400 ring-violet-500/25',
};

function Pill({ tone = 'neutral', dot = false, className = '', children }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
      TONES[tone], className
    )}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** One segment of the git button group; tinted when it has pending work. */
function GitSegment({ icon: Icon, label, title, onClick, active, tone = 'blue' }) {
  const activeCls = {
    blue: 'bg-blue-500/10 text-blue-400',
    amber: 'bg-amber-500/10 text-amber-500',
    yellow: 'bg-yellow-500/10 text-yellow-500',
    violet: 'bg-violet-500/10 text-violet-400',
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium transition-colors hover:bg-accent hover:text-foreground',
        active ? activeCls : 'text-muted-foreground'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden @[21rem]:inline">{label}</span>
    </button>
  );
}

/** "https://github.com/owner/repo.git" → "owner/repo" */
function shortRemote(url) {
  if (!url) return '';
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : url;
}

/** The app's own icon on its color, or its initials. */
function AppIcon({ app, color, className = "h-11 w-11" }) {
  return (
    <div
      className={cn("flex flex-shrink-0 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-inset ring-white/10", className)}
      style={{ backgroundColor: color }}
    >
      {app.icon
        ? <DynamicIcon icon={{ value: app.icon }} className="h-6 w-6" />
        : <span className="text-base font-semibold">{loopar.utils.avatar(app.name)}</span>}
    </div>
  );
}

function AppCard({app, action}) {
  const color = loopar.bgColor(app.name);
  const isFramework = !!app.is_framework;
  const isInstalled = !!(app.installed || isFramework);
  const mismatch = !!app.folder_mismatch;
  const needsUpdate = !!app.installed && app.installed_version !== app.version;
  const isRollback = needsUpdate && compareVersion(app.version, app.installed_version) < 0;
  const hasGitDir = !!(app.has_git || isFramework);
  const hasRemote = !!app.remote_url;

  const status = app.repo_status || null;
  const dirtyCount = status?.files?.length || 0;
  const ahead = status?.ahead || 0;
  const behind = status?.behind || 0;
  const branch = status?.branch || '';
  const isDirty = dirtyCount > 0;
  const tracksUpstream = hasRemote && status?.upstream !== false;

  // A mismatched folder can't be resolved by any app operation, so it gets no git/lifecycle actions.
  const repoMode =
    mismatch ? 'blocked' :
    isFramework || (hasGitDir && hasRemote) ? 'full' :
    hasGitDir ? 'local' :
    'none';

  const stateBadge = (() => {
    if (mismatch) return { label: __('Folder mismatch'), tone: 'amber' };
    if (needsUpdate) {
      return isRollback
        ? { label: __('Rollback available'), tone: 'yellow' }
        : { label: __('Update available'), tone: 'orange' };
    }
    if (isDirty) return { label: `${dirtyCount} ${__('uncommitted')}`, tone: 'amber' };
    if (behind > 0) return { label: `${behind} ${__('behind')}`, tone: 'yellow' };
    if (ahead > 0) return { label: `${ahead} ${__('unpushed')}`, tone: 'blue' };
    if (isInstalled) return { label: __('Up to date'), tone: 'green' };
    return null;
  })();

  const remoteLabel = isFramework ? 'monorepo root' : (shortRemote(app.remote_url) || __('local only'));
  const remoteHref = !isFramework && /^https?:\/\//.test(app.remote_url || '') ? app.remote_url.replace(/\.git$/, '') : null;

  const discard = () => action(app.name, 'discard', repoMode === 'full' ? true : { wasInstalled: app.installed });
  const menu = [
    (repoMode === 'full' || repoMode === 'local') && { key: 'discard', label: __('Discard local changes'), icon: RotateCcwIcon, onSelect: discard },
    // Development: a data migration to ship with the app's next version (app-migrations.js).
    hasGitDir && !app.template_locked && { key: 'migration', label: __('New data migration'), icon: DatabaseZapIcon, onSelect: () => newMigration(app.name) },
    app.installed && !isFramework && { key: 'uninstall', label: __('Uninstall'), icon: Trash2Icon, onSelect: () => action(app.name, 'uninstall') },
  ].filter(Boolean);

  return (
    <Card
      className="@container group relative flex h-full min-w-0 flex-col overflow-hidden border-[color:var(--app-border)] shadow-sm transition-[border-color,box-shadow] hover:border-[color:var(--app-border-hover)] hover:shadow-md"
      style={{ '--app-border': loopar.bgColor(app.name, 0.45), '--app-border-hover': loopar.bgColor(app.name, 0.8) }}
    >
      {/* App-colored accent: a top strip plus a faint wash behind the header, so each card reads as its own unit. */}
      <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: color }} />

      <div
        className="flex items-start gap-3 px-4 pb-2 pt-4"
        style={{ backgroundImage: `linear-gradient(to bottom, ${loopar.bgColor(app.name, 0.12)}, transparent)` }}
      >
        <AppIcon app={app} color={color} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-lg font-semibold leading-tight tracking-tight">{app.name}</h3>
            {isFramework && (
              <span title={__("Framework")} className="flex-shrink-0 text-violet-400"><InfinityIcon className="h-4 w-4" /></span>
            )}
            {!!app.is_template && <Pill tone="blue" className="flex-shrink-0">{__("Template")}</Pill>}
          </div>
          <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground" title={app.description || undefined}>
            {app.description || <span className="italic opacity-60">{__("No description")}</span>}
          </p>
        </div>
        {stateBadge && <Pill tone={stateBadge.tone} dot className="flex-shrink-0">{stateBadge.label}</Pill>}
      </div>

      {/* One line of facts: version, install state, branch, remote, sync. */}
      <div className="flex min-w-0 items-center gap-2 px-4 pb-3 text-xs text-muted-foreground">
        <span className="flex-shrink-0 font-mono">v{app.version || '—'}</span>
        {needsUpdate && (
          <span className="flex-shrink-0 font-mono text-orange-500" title={__("Installed version in the database")}>
            db {app.installed_version}
          </span>
        )}
        {isInstalled && !needsUpdate && (
          <span className="inline-flex flex-shrink-0 items-center gap-1 text-emerald-500">
            <CheckCircle2Icon className="h-3 w-3" />{__("Installed")}
          </span>
        )}
        {hasGitDir && !mismatch && (
          <>
            <span className="text-border">•</span>
            {branch && (
              <span className="inline-flex flex-shrink-0 items-center gap-1 font-mono text-foreground/80">
                <GitBranchIcon className="h-3 w-3" />{branch}
              </span>
            )}
            {remoteHref ? (
              <a href={remoteHref} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:text-foreground hover:underline" title={app.remote_url}>
                {remoteLabel}
              </a>
            ) : (
              <span className="min-w-0 truncate">{remoteLabel}</span>
            )}
            {status && (
              <span className="ml-auto flex flex-shrink-0 items-center gap-2 font-mono text-[11px]">
                {hasRemote && status.upstream === false && <span className="text-amber-500">{__("no upstream")}</span>}
                {tracksUpstream && (
                  <>
                    <span className={ahead > 0 ? 'text-blue-400' : ''} title={__("Commits ahead")}>↑{ahead}</span>
                    <span className={behind > 0 ? 'text-yellow-500' : ''} title={__("Commits behind")}>↓{behind}</span>
                  </>
                )}
              </span>
            )}
          </>
        )}
      </div>

      {mismatch && (
        <div className="mx-4 mb-3 flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500 ring-1 ring-inset ring-amber-500/20">
          <TriangleAlertIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <p className="min-w-0 break-words">
            {__("Folder")} <code className="font-mono">apps/{app.folder}</code> {__("must be renamed to")} <code className="font-mono">apps/{app.name}</code> {__("to manage this app.")}
          </p>
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
        {!!app.template_host && !mismatch && (
          <Button size="sm" variant="primeblue" className="h-8" onClick={() => publishDemo(app)}
            title={__("Install this template here (if needed) and serve it on its own domain")}>
            <LayoutTemplateIcon className="mr-1.5 h-4 w-4" /> {__("Publish demo")}
          </Button>
        )}
        {!isInstalled && !mismatch && !app.template_locked && (
          <Button size="sm" variant={app.is_template ? 'secondary' : 'primeblue'} className="h-8" onClick={() => action(app.name, 'install')}
            title={app.is_template ? __('Install the template itself (development only: to edit the template)') : undefined}>
            <FolderDownIcon className="mr-1.5 h-4 w-4" /> {__("Install")}
          </Button>
        )}
        {needsUpdate && !mismatch && (
          <Button
            size="sm"
            className={cn('h-8 text-white', isRollback ? 'bg-yellow-600 hover:bg-yellow-600/80' : 'bg-orange-500 hover:bg-orange-500/80')}
            onClick={() => action(app.name, 'reinstall')}
            title={isRollback
              ? `Rollback DB to ${app.version} (currently ${app.installed_version})`
              : `Update DB to ${app.version} (currently ${app.installed_version})`}
          >
            {isRollback
              ? <><RotateCcwIcon className="mr-1.5 h-4 w-4" /> {__("Rollback")}</>
              : <><RefreshCcwDotIcon className="mr-1.5 h-4 w-4" /> {__("Update")}</>}
          </Button>
        )}

        {repoMode === 'full' && (
          <div className="inline-flex divide-x divide-border overflow-hidden rounded-md ring-1 ring-inset ring-border">
            <GitSegment icon={ArrowDownToLineIcon} label={__("Pull")} tone="yellow" active={behind > 0}
              title={isFramework ? 'Pull framework from remote' : 'Pull from remote'}
              onClick={() => action(app.name, 'pull')} />
            <GitSegment icon={GitCommitHorizontalIcon} label={__("Commit")} tone="amber" active={isDirty}
              title={isFramework ? 'Commit framework changes' : 'Commit local changes'}
              onClick={() => action(app.name, 'commit')} />
            <GitSegment icon={ArrowUpFromLineIcon} label={__("Push")} tone="blue" active={ahead > 0}
              title={isFramework ? 'Push framework to remote' : 'Push to remote'}
              onClick={() => action(app.name, 'push')} />
          </div>
        )}

        {repoMode === 'local' && (
          <div className="inline-flex divide-x divide-border overflow-hidden rounded-md ring-1 ring-inset ring-border">
            <GitSegment icon={GitCommitHorizontalIcon} label={__("Commit")} tone="amber" active={isDirty}
              title={__("Commit local changes")} onClick={() => action(app.name, 'commit')} />
            <GitSegment icon={CloudUploadIcon} label={__("Publish")} tone="violet" active
              title={__("Connect to a remote and push existing history")} onClick={() => action(app.name, 'publish')} />
          </div>
        )}

        {repoMode === 'none' && (
          <Button size="sm" variant="ghost" className="h-8 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
            title={__("Initialize git, link to a remote, and push the initial commit")}
            onClick={() => action(app.name, 'publish')}>
            <CloudUploadIcon className="mr-1.5 h-4 w-4" /> {__("Publish")}
          </Button>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          {isInstalled && (
            <Link
              variant="ghost"
              inModal
              onSaved={() => loopar.refresh()}
              to={`/desk/App/update?name=${encodeURIComponent(app.name)}`}
              title={__("Edit")}
              className="h-8 w-8 justify-center p-0 text-muted-foreground hover:text-foreground"
            >
              <PencilIcon className="h-4 w-4" />
            </Link>
          )}
          {menu.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={__("More")}
                  aria-label={__("More")}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <MoreHorizontalIcon className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {menu.map((m) => (
                  <DropdownMenuItem key={m.key} onSelect={m.onSelect} className="gap-2 text-destructive focus:text-destructive [&_svg]:size-4">
                    <m.icon />{m.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </Card>
  )
}

/**
 * Publish-demo form (same pattern as PublishForm: the dialog's OK reads `state`).
 * Template host tenant only: the template itself is the demo, served on its domain.
 */
function PublishDemoForm({ app, state }) {
  const [domain, setDomain] = useState(app.default_demo_domain || '');

  Object.assign(state, { domain: domain.trim().toLowerCase() });

  return (
    <div className="space-y-3 text-left">
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{__("Domain")}</span>
        <input className={fieldClass} value={domain} onChange={(e) => setDomain(e.target.value)} />
      </label>
      <p className="text-xs text-muted-foreground">
        {app.installed ? <><code>{app.name}</code> {__("is installed here;")} </> : <><code>{app.name}</code> {__("(and the apps it requires) is installed here;")} </>}
        {__("it is served on")} <code>{domain || '…'}</code>{__(", added to this tenant's Domains (it must point to this server). Updating the template updates the demo.")}
      </p>
    </div>
  );
}

function publishDemo(app) {
  const state = {};
  loopar.dialog({
    type: "confirm",
    title: `Publish demo of ${app.name}`,
    content: <PublishDemoForm app={app} state={state} />,
    size: "md",
    ok: () => {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$|^[a-z0-9.-]+\.localhost$/.test(state.domain || '')) {
        return loopar.throw("Enter the demo's domain, e.g. construction-demo.loopar.build");
      }
      const result = loopar.call('App Manager', 'publishDemo', { body: { template: app.name, ...state } });
      result?.then?.(() => setTimeout(() => loopar.refresh(), 600)).catch(() => {});
    },
  });
}

/** A new, empty data migration file for the app (it runs on each site at the app's next update). */
function newMigration(appName) {
  loopar.prompt({
    title: `${__("New data migration")} · ${appName}`,
    label: __("What does it do with the existing data?"),
    placeholder: __("e.g. Customer: split full_name into first_name and last_name"),
    ok: (description) => {
      loopar.call('App Manager', 'newMigration', { body: { app_name: appName, description }, query: { app_name: appName } })
        .then((r) => r?.notice && loopar.notify(r.notice, 'success'))
        .catch(() => {});
    },
    validate: (description) => {
      if (!description || !description.trim()) return loopar.throw(__("Describe what the migration does."));
      return true;
    },
  });
}

function cloneApp() {
  loopar.prompt({
    title: "Get App",
    label: "Enter the Github URL of the app you want to install",
    placeholder: "Github URL",
    ok: (gitRepo) => {
      loopar.call('App Manager', 'clone', { body: { git_repo: gitRepo } });
    },
    validate: (gitRepo) => {
      if (!gitRepo || gitRepo.length === 0) return loopar.throw("Please enter a valid Github URL");
      return true;
    },
  });
}

function sendAppAction(appName, action, optsOrSlide = false) {
  const opts = typeof optsOrSlide === 'object' && optsOrSlide !== null
    ? optsOrSlide
    : { slide: optsOrSlide };
  const slide = !!opts.slide;
  const wasInstalled = !!opts.wasInstalled;
  const isFramework = appName === 'loopar';

  const GIT_VERBS = ['pull', 'push', 'commit', 'discard', 'publish'];
  // Install / update / uninstall answer with a background job: follow it.
  const JOB_VERBS = ['install', 'reinstall', 'uninstall'];
  const dispatch = (verb, body, ctx = {}) => {
    const result = loopar.call("App Manager", verb, {
      body,
      query: { app_name: appName },
      // Job verbs answer at once with the job; its modal is the feedback, so
      // no loading overlay (the job's own work can delay the answer a bit).
      ...(JOB_VERBS.includes(verb) ? { freeze: false } : {}),
    });
    if (!result || typeof result.then !== 'function') return;

    // Failures are non-2xx: http.jsx toasts them and the promise rejects.
    if (JOB_VERBS.includes(verb)) {
      result.then((r) => {
        if (!r?.job) return;
        trackStarted?.(r.job);
        openJobProgress(r.job, { entity: 'App Manager' });
      }).catch(() => {});
      return;
    }
    if (!GIT_VERBS.includes(verb)) return;
    result.then((r) => {
      // A pull that changed files starts a build: its output is a job too.
      if (r?.build_job) openJobProgress(r.build_job, { entity: 'App Manager' });
      setTimeout(() => loopar.refresh(), 600);
    }).catch(() => {});
  };

  if (action === 'commit') {
    return loopar.call('App Manager', 'diff', {
      body: { app_name: appName },
      query: { app_name: appName },
    }).then((diff) => {
      const files = Array.isArray(diff.files) ? diff.files : [];

      if (files.length === 0) {
        return loopar.confirm(
          `Nothing to commit in ${isFramework ? 'monorepo' : appName}. Working tree is already clean.`,
          () => {}
        );
      }

      const MAX_ROWS = 30;
      const head = files.slice(0, MAX_ROWS).map((f) => {
        const status = `<span class='inline-block w-6 font-mono text-xs text-zinc-400'>${f.status || '?'}</span>`;
        const stats = (f.insertions || f.deletions)
          ? ` <span class='text-xs'><span class='text-green-500'>+${f.insertions}</span> <span class='text-red-500'>-${f.deletions}</span></span>`
          : '';
        return `<div class='font-mono text-xs leading-relaxed'>${status}${f.path}${stats}</div>`;
      }).join('');
      const more = files.length > MAX_ROWS
        ? `<div class='mt-1 text-xs italic text-zinc-500'>…and ${files.length - MAX_ROWS} more</div>`
        : '';

      const branchLine = diff.branch
        ? `<div class='mb-2 text-xs text-zinc-500'>on branch <strong>${diff.branch}</strong></div>`
        : '';
      const lastLine = (diff.recent_commits && diff.recent_commits[0])
        ? `<div class='mt-2 border-t border-zinc-700 pt-2 text-xs text-zinc-500'>Last commit: <code>${diff.recent_commits[0].sha}</code> ${diff.recent_commits[0].subject || ''}</div>`
        : '';

      const summary = `
        ${branchLine}
        <strong>${files.length} file${files.length === 1 ? '' : 's'} to commit:</strong>
        <div class='mt-2 max-h-64 overflow-y-auto rounded border border-zinc-800 bg-black/30 p-2'>${head}${more}</div>
        ${lastLine}
      `;

      loopar.dialog({
        type: "confirm",
        title: `Commit ${isFramework ? 'framework' : appName}`,
        content: summary,
        size: "lg",
      },  () => {
        loopar.prompt({
          title: `Commit ${isFramework ? 'framework' : appName}`,
          label: 'Commit message',
          placeholder: 'Describe your changes',
          initialValue: diff.suggested_message || '',
          ok: (message) => {
            dispatch('commit', { app_name: appName, message });
          },
          validate: (message) => {
            if (!message || message.trim().length === 0) {
              return loopar.throw('Commit message is required');
            }
            return true;
          },
        });
      });
    }).catch(() => {}); // error already toasted by http.jsx
  }

  if (action === 'publish') {
    const promptUrl = () => loopar.prompt({
      title: `Publish ${appName} to remote`,
      label: 'Remote repository URL (uses this machine\'s git credentials)',
      placeholder: 'https://github.com/user/repo.git',
      ok: (remote_url) => {
        dispatch('publish', { app_name: appName, remote_url });
      },
      validate: (remote_url) => {
        if (!remote_url || remote_url.trim().length === 0) {
          return loopar.throw('Remote URL is required');
        }
        return true;
      },
    });

    return loopar.call('App Manager', 'gitAccounts', {
      query: { app_name: appName },
    }).then(({ accounts = [] } = {}) => {
      if (!accounts.length) {
        return loopar.dialog({
          type: "confirm",
          title: `Publish ${appName}`,
          content: `You have no Git Account yet. Add one (a GitHub access token) to publish with your own identity, or use a remote URL with this machine's credentials.`,
          buttons: [
            { name: "account", text: "Add Git Account", variant: "default", dismiss: true,
              onClick: () => loopar.navigate('/desk/Git Account/create') },
            { name: "url", text: "Use a URL", variant: "secondary", dismiss: true, onClick: promptUrl },
          ],
        });
      }

      const state = {};
      loopar.dialog({
        type: "confirm",
        title: `Publish ${appName}`,
        content: <PublishForm appName={appName} accounts={accounts} state={state} />,
        size: "md",
        ok: () => {
          if (!state.repo || !state.repo.trim()) return loopar.throw('Repository name is required');
          dispatch('publish', { app_name: appName, ...state });
        },
      });
    }).catch(() => {}); // error already toasted by http.jsx
  }

  // Uninstall: if installed apps need this one, offer to take them too,
  // listing every app that will go (one job, the dependents first).
  if (action === 'uninstall' && !opts.dependentsChecked) {
    return loopar.call('App Manager', 'dependents', { query: { app_name: appName }, freeze: false })
      .then(({ dependents = [] } = {}) => {
        if (!dependents.length) return sendAppAction(appName, action, { ...opts, dependentsChecked: true });
        const all = [...dependents, appName];
        loopar.confirm({
          title: `Uninstall ${appName} and ${dependents.length} dependent app${dependents.length > 1 ? 's' : ''}?`,
          content: `${dependents.map((d) => `<strong>${d}</strong>`).join(', ')} ${dependents.length > 1 ? 'require' : 'requires'} ${appName}: `
            + `uninstalling it uninstalls ${dependents.length > 1 ? 'them' : 'it'} too, in this order: ${all.join(' → ')}.`
            + `<br/><br/><strong class='text-red-500'>All data and Documents of these ${all.length} apps will be deleted.</strong> A safety snapshot is taken first.`,
          slide: true,
          slideText: `Slide to uninstall ${all.length} apps`,
          ok: () => dispatch('uninstall', { app_name: appName, cascade: 1 }),
        });
      })
      .catch(() => {}); // error already toasted by http.jsx
  }

  const confirmMessages = {
    uninstall: `<br/><br/><strong class='text-red-500'>All data and Documents related to ${appName} will be deleted.</strong> A safety snapshot is taken first.`,
    pull: isFramework
      ? `<span class='text-amber-500'>This pulls the whole framework. After completion the tenant must restart (nodemon will reload in dev) to apply changes. Local uncommitted changes anywhere in the monorepo will block this operation.</span>`
      : `<span class='text-amber-500'>Local uncommitted changes in this app will block this operation. Commit, push, or <code>git reset --hard</code> first.</span>`,
    push: `<span class='text-amber-500'>Working tree must be clean and up-to-date with remote.</span>`,
    discard: `<strong class='text-red-500'>This is destructive and cannot be undone.</strong> All uncommitted changes${isFramework ? ' anywhere in the monorepo' : ` in apps/${appName}`} will be lost, and untracked files will be removed.`,
  };

  const verbs = {
    install: 'install',
    reinstall: 'reinstall',
    uninstall: 'uninstall',
    pull: 'pull from remote for',
    push: 'push to remote from',
    discard: 'DISCARD all local changes for',
  };

  const verb = verbs[action] || action;
  const trailing = confirmMessages[action] || '';

  loopar.confirm({
    title: `${titleize(action)} ${appName}?`,
    content: trailing,
    slide: slide,
    slideText: `Slide to ${action} ${appName}`,
    ok: () => {
      dispatch(action, { app_name: appName }, { wasInstalled });
    },
  });
}


/** Redraws the desk's sidebar and search index from the server, without a page load. */
function refreshDeskMenu() {
  loopar.call('App Manager', 'deskMenu', { freeze: false, notifyError: false })
    .then((menu) => { if (menu?.menu_data) loopar.emit('workspace-meta', menu); })
    .catch(() => {});
}

/** Set by the mounted ActiveJobs: hands it the jobs started from a card. */
let trackStarted = null;

/**
 * The user's install/update/uninstall jobs still running: a strip above the
 * cards (they reopen their progress), and what happens when each one ends
 * (toast; the list refreshes, or the page reloads after a framework update).
 */
function ActiveJobs() {
  const [jobs, setJobs] = useState([]);
  const handled = useRef(new Set());
  const lastEvent = useRef(0);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  // Once per job, whichever reports the end first (realtime or a poll).
  const onEnded = (job) => {
    if (!job?.id || handled.current.has(job.id)) return;
    handled.current.add(job.id);
    if (job.state === 'completed') {
      loopar.notify(`${job.title}: ${__("done")}`, 'success');
      if (job.result?.reload) return setTimeout(() => window.location.reload(), 1200);
    } else if (job.state === 'failed') {
      loopar.notify(`${job.title}: ${job.error || __("failed")}`, 'error');
    }
    if (job.kind === 'app') {
      // The list, and the desk's sidebar (apps and their modules come and go).
      loopar.refresh({ freeze: false });
      refreshDeskMenu();
    }
  };

  const track = (job) => {
    if (!job?.id) return;
    setJobs((prev) => {
      const rest = prev.filter((j) => j.id !== job.id);
      return isActiveJob(job) ? [...rest, job] : rest;
    });
    if (!isActiveJob(job)) onEnded(job);
  };

  useEffect(() => {
    const read = () => loopar.call('App Manager', 'jobs', { freeze: false, notifyError: false })
      .then((r) => {
        const active = r?.jobs || [];
        // A job we were showing that is no longer active ended: ask how.
        for (const gone of jobsRef.current.filter((j) => !active.some((a) => a.id === j.id))) {
          loopar.call('App Manager', 'job', { query: { id: gone.id }, freeze: false, notifyError: false })
            .then((res) => res?.job && track(res.job))
            .catch(() => track({ ...gone, state: 'failed', error: __("interrupted: the server restarted while it ran") }));
        }
        setJobs(active);
      })
      .catch(() => {});
    read();
    // Safety net for realtime: while something runs, re-read when the socket
    // is down, or after a long silence when it is up.
    const timer = setInterval(() => {
      if (jobsRef.current.length && shouldPoll(lastEvent.current)) read();
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  useJobEvents((event) => {
    lastEvent.current = Date.now();
    track(event);
  });
  // A job started from a card shows in the strip at once (no realtime needed).
  useEffect(() => {
    trackStarted = track;
    return () => { if (trackStarted === track) trackStarted = null; };
  });

  if (!jobs.length) return null;

  return (
    // Sticky under the top bar: the running job stays in sight while scrolling the cards.
    <div className="sticky top-[calc(var(--spacing-header-height)+0.5rem)] z-30 mb-4 space-y-2">
      {jobs.map((job) => {
        const { done = 0, total = 0 } = job.progress || {};
        const percent = job.percent ?? (total ? Math.round((done / total) * 100) : null);
        return (
          <button
            key={job.id}
            type="button"
            onClick={() => openJobProgress(job, { entity: 'App Manager' })}
            className="relative flex w-full items-center gap-3 overflow-hidden rounded-lg border border-primary/30 bg-background/95 px-3 py-2 text-left text-sm shadow-md backdrop-blur transition-colors hover:bg-accent"
          >
            {percent != null && (
              <span aria-hidden className="absolute inset-y-0 left-0 bg-primary/10 transition-[width] duration-500" style={{ width: `${percent}%` }} />
            )}
            <Loader2Icon className="relative h-4 w-4 flex-shrink-0 animate-spin text-primary" />
            <span className="relative flex-shrink-0 font-medium">{job.title}</span>
            <span className="relative min-w-0 flex-1 truncate text-muted-foreground">{job.step}</span>
            {percent != null && <span className="relative flex-shrink-0 font-mono text-xs text-muted-foreground">{percent}%</span>}
            <span className="relative flex-shrink-0 text-xs text-primary">{__("View")}</span>
          </button>
        );
      })}
    </div>
  );
}

// Built on render: their labels are translated in the request's language.
const actions = () => ({
  addApp: {
    label: __("Add App"), icon: PlusIcon, primary: true,
    to: "/desk/App/create", inModal: true, onSaved: () => loopar.refresh(),
  },
  // Get App only needs the repository URL: a prompt, not a form.
  getApp: { label: __("Get App"), icon: DownloadIcon, onClick: () => cloneApp() },
});

const gridTemplate = (app) => <AppCard app={app} action={sendAppAction} />;

export const config = {
  hasSelectAll: false,
  hasSelectRow: false,
  // Apps are managed from their cards, not opened as records.
  openRecords: false,
  customViews: {
    Dependencies: {
      icon: <NetworkIcon />,
      label: () => __("Dependencies"),
      render: (ctrl) => <AppDependencies ctrl={ctrl} onAction={sendAppAction} />,
    },
  },
};

export default function AppManagerList() {
  return (
    <ListLayout actions={actions()} gridTemplate={gridTemplate} gridMinWidth="24rem">
      <ActiveJobs />
    </ListLayout>
  );
}
