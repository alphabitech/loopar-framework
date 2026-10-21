'use strict';

import { ListLayout } from '@loopar/list';
import loopar from "loopar";
import { useState } from "react";

import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter} from '@card';
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
} from 'lucide-react';

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
        <span className="text-xs text-muted-foreground">Git account</span>
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
          <span className="text-xs text-muted-foreground">Owner</span>
          <select className={fieldClass} value={owner} onChange={(e) => setOwner(e.target.value)}>
            {owners.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <span className="pb-2 text-muted-foreground">/</span>
        <label className="block flex-1 space-y-1">
          <span className="text-xs text-muted-foreground">Repository</span>
          <input className={fieldClass} value={repo} onChange={(e) => setRepo(e.target.value)} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
        Private (only used when the repository is created)
      </label>
      <p className="text-xs text-muted-foreground">
        If <code>{owner}/{repo}</code> doesn't exist it will be created, then the app is committed and pushed.
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

/** Square ghost icon button used on the card's right-hand toolbar. */
function IconAction({ icon: Icon, title, onClick, danger = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors',
        danger ? 'hover:bg-red-500/10 hover:text-red-500' : 'hover:bg-accent hover:text-foreground'
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
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

function AppCard({app, action}) {
  const color = loopar.bgColor(app.name);
  const isFramework = app.is_framework ?? (app.name === 'loopar');
  const isInstalled = !!(app.installed || isFramework);
  const mismatch = !!app.folder_mismatch;
  const needsUpdate = app.installed && app.installed_version !== app.version;
  const isRollback = needsUpdate && compareVersion(app.version, app.installed_version) < 0;
  const hasGitDir = app.has_git || isFramework;
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
    if (mismatch) return { label: 'Folder mismatch', tone: 'amber' };
    if (needsUpdate) {
      return isRollback
        ? { label: 'Rollback available', tone: 'yellow' }
        : { label: 'Update available', tone: 'orange' };
    }
    if (isDirty) return { label: `${dirtyCount} uncommitted`, tone: 'amber' };
    if (behind > 0) return { label: `${behind} behind`, tone: 'yellow' };
    if (ahead > 0) return { label: `${ahead} unpushed`, tone: 'blue' };
    if (isInstalled) return { label: 'Up to date', tone: 'green' };
    return null;
  })();

  const remoteLabel = isFramework ? 'monorepo root' : (shortRemote(app.remote_url) || 'local only');
  const remoteHref = !isFramework && /^https?:\/\//.test(app.remote_url || '') ? app.remote_url.replace(/\.git$/, '') : null;

  const discard = () => action(app.name, 'discard', repoMode === 'full' ? true : { wasInstalled: app.installed });

  return (
    <Card className="@container group flex h-full min-w-0 flex-col transition-colors hover:border-foreground/20">
      <CardHeader className="space-y-0 p-4 pb-3">
        <div className="flex items-start gap-3">
          <div
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl shadow-sm ring-1 ring-inset ring-white/10"
            style={{ backgroundColor: color }}
          >
            {app.icon ? (
              <DynamicIcon icon={app.icon} className="h-6 w-6 text-white" />
            ) : (
              <span className="text-lg font-semibold text-white">
                {loopar.utils.avatar(app.name)}
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <CardTitle className="truncate text-base font-semibold leading-tight">{app.name}</CardTitle>
              {isFramework && (
                <span title="Framework" className="flex-shrink-0 text-violet-400"><InfinityIcon className="h-4 w-4" /></span>
              )}
            </div>
            <CardDescription className="mt-1 flex items-center gap-1.5 truncate text-xs">
              <span className="font-mono">v{app.version || '—'}</span>
              {needsUpdate && (
                <span className="font-mono text-orange-500" title="Installed version in the database">
                  (db {app.installed_version})
                </span>
              )}
              <span className="text-border">•</span>
              {isInstalled
                ? <span className="inline-flex items-center gap-1 text-emerald-500"><CheckCircle2Icon className="h-3 w-3" />Installed</span>
                : <span>Not installed</span>}
              {app.autor && <><span className="text-border">•</span><span className="truncate">{app.autor}</span></>}
            </CardDescription>
          </div>

          {stateBadge && <Pill tone={stateBadge.tone} dot className="flex-shrink-0">{stateBadge.label}</Pill>}
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-2 px-4 pb-3 pt-0">
        {mismatch && (
          <div className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500 ring-1 ring-inset ring-amber-500/20">
            <TriangleAlertIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <p className="min-w-0 break-words">
              Folder <code className="font-mono">apps/{app.folder}</code> must be renamed
              to <code className="font-mono">apps/{app.name}</code> to manage this app.
            </p>
          </div>
        )}

        {hasGitDir && !mismatch && (
          <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
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
                {hasRemote && status.upstream === false && <span className="text-amber-500">no upstream</span>}
                {tracksUpstream && (
                  <>
                    <span className={ahead > 0 ? 'text-blue-400' : ''} title="Commits ahead">↑{ahead}</span>
                    <span className={behind > 0 ? 'text-yellow-500' : ''} title="Commits behind">↓{behind}</span>
                  </>
                )}
                {!isDirty && <span className="text-emerald-500">clean</span>}
              </span>
            )}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {!isInstalled && !mismatch && (
            <Button size="sm" variant="primeblue" className="h-8" onClick={() => action(app.name, 'install')}>
              <FolderDownIcon className="mr-1.5 h-4 w-4" /> Install
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
                ? <><RotateCcwIcon className="mr-1.5 h-4 w-4" /> Rollback</>
                : <><RefreshCcwDotIcon className="mr-1.5 h-4 w-4" /> Update</>}
            </Button>
          )}

          {repoMode === 'full' && (
            <div className="inline-flex divide-x divide-border overflow-hidden rounded-md ring-1 ring-inset ring-border">
              <GitSegment icon={ArrowDownToLineIcon} label="Pull" tone="yellow" active={behind > 0}
                title={isFramework ? 'Pull framework from remote' : 'Pull from remote'}
                onClick={() => action(app.name, 'pull')} />
              <GitSegment icon={GitCommitHorizontalIcon} label="Commit" tone="amber" active={isDirty}
                title={isFramework ? 'Commit framework changes' : 'Commit local changes'}
                onClick={() => action(app.name, 'commit')} />
              <GitSegment icon={ArrowUpFromLineIcon} label="Push" tone="blue" active={ahead > 0}
                title={isFramework ? 'Push framework to remote' : 'Push to remote'}
                onClick={() => action(app.name, 'push')} />
            </div>
          )}

          {repoMode === 'local' && (
            <div className="inline-flex divide-x divide-border overflow-hidden rounded-md ring-1 ring-inset ring-border">
              <GitSegment icon={GitCommitHorizontalIcon} label="Commit" tone="amber" active={isDirty}
                title="Commit local changes" onClick={() => action(app.name, 'commit')} />
              <GitSegment icon={CloudUploadIcon} label="Publish" tone="violet" active
                title="Connect to a remote and push existing history" onClick={() => action(app.name, 'publish')} />
            </div>
          )}

          {repoMode === 'none' && (
            <Button size="sm" variant="ghost" className="h-8 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
              title="Initialize git, link to a remote, and push the initial commit"
              onClick={() => action(app.name, 'publish')}>
              <CloudUploadIcon className="mr-1.5 h-4 w-4" /> Publish
            </Button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-0.5">
          {(repoMode === 'full' || repoMode === 'local') && (
            <IconAction icon={RotateCcwIcon} danger title="Discard ALL local changes (destructive)" onClick={discard} />
          )}
          {app.installed && (
            <Link
              variant="ghost"
              to={`/desk/App/update?name=${app.name}`}
              title="Edit"
              className="h-8 w-8 justify-center p-0 text-muted-foreground hover:text-foreground"
            >
              <PencilIcon className="h-4 w-4" />
            </Link>
          )}
          {app.installed && !isFramework && (
            <IconAction icon={Trash2Icon} danger title="Uninstall" onClick={() => action(app.name, 'uninstall')} />
          )}
        </div>
      </CardFooter>
    </Card>
  )
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
  const dispatch = (verb, body, ctx = {}) => {
    const result = loopar.call("App Manager", verb, {
      body,
      query: { app_name: appName },
    });
    if (!GIT_VERBS.includes(verb)) return;
    if (!result || typeof result.then !== 'function') return;

    // Failures are non-2xx: http.jsx toasts them and the promise rejects.
    result.then(() => {
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

  const confirmMessages = {
    uninstall: `<br/><br/><span class='fa fa-circle text-red pr-2'></span> <strong class='text-red'>All data and Documents related to ${appName} will be deleted.</strong>`,
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


const ACTIONS = {
  addApp: (
    <Link
      variant="secondary"
      className="bg-success text-white hover:bg-success/80"
      to="/desk/App/create"
    >
      <PlusIcon className="mr-2"/> Add App
    </Link>
  ),
  getApp: (
    <Button
      variant="primeblue"
      onClick={(e) => {
        e.preventDefault();
        cloneApp();
      }}
    >
      <DownloadIcon className="mr-2"/> Get App
    </Button>
  ),
};

const gridTemplate = (app) => <AppCard app={app} action={sendAppAction} />;

export const config = { onlyGrid: true, hasSearchForm: false, hasSelectAll: false, hasSelectRow: false };

export default function AppManagerView() {
  return <ListLayout actions={ACTIONS} gridTemplate={gridTemplate} />;
}
