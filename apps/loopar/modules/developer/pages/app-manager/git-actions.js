'use strict';

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { loopar } from 'loopar';
import { resolveGitAccount, loadGitAccount, getAskpassScript } from './git-accounts.js';
import { getRepository, createRepository } from './github-api.js';

const execFile = promisify(execFileCb);

/**
 * Failures are thrown as typed errors (status + code + title) and rendered by
 * the error middleware. Negative-but-valid outcomes (nothing to push/commit)
 * are returned with `noop: true` — they are not request failures.
 */
function fail(status, code, message, title = 'Git error') {
  loopar.throw({ status, code, title, message });
}

const stderrOf = (e, fallback) => (e?.stderr || e?.message || fallback).toString().trim();

export function getCwdForApp(name) {
  const appPath = loopar.makePath(loopar.pathRoot, 'apps', name);
  const ownGitPath = loopar.makePath(appPath, '.git');
  const hasOwnGit = fs.existsSync(ownGitPath);

  if (name === 'loopar' && !hasOwnGit) {
    return { cwd: loopar.pathRoot, isFramework: true };
  }

  if (!hasOwnGit) {
    fail(404, 'NO_GIT_DIR',
      `App '${name}' has no git repository at ${appPath}. ` +
      `Use 'Get App' to clone it from a remote first.`);
  }

  return { cwd: appPath, isFramework: false };
}

export function getAppVersion(name) {
  try {
    const installerPath = loopar.makePath(loopar.pathRoot, 'apps', name, 'installer.json');
    if (!fs.existsSync(installerPath)) return null;
    const data = JSON.parse(fs.readFileSync(installerPath, 'utf8'));
    return (data && data.App && data.App.version) || null;
  } catch {
    return null;
  }
}

const AUTH_FAILURE = /\b403\b|permission to .* denied|authentication failed|could not read (username|password)|repository not found/i;

/**
 * Run git. With `account`, the command authenticates with that account's
 * token (via GIT_ASKPASS; machine credential helpers are disabled so the
 * keychain can't win) and commits are authored as that account.
 */
async function git(cwd, args, account = null) {
  const opts = { cwd, maxBuffer: 4 * 1024 * 1024 };
  let fullArgs = args;

  if (account) {
    fullArgs = [
      '-c', 'credential.helper=',
      ...(account.author?.name ? ['-c', `user.name=${account.author.name}`] : []),
      ...(account.author?.email ? ['-c', `user.email=${account.author.email}`] : []),
      ...args,
    ];
    opts.env = {
      ...process.env,
      GIT_ASKPASS: getAskpassScript(),
      GIT_TERMINAL_PROMPT: '0',
      LOOPAR_GIT_USERNAME: account.username,
      LOOPAR_GIT_TOKEN: account.token,
    };
  }

  try {
    const { stdout, stderr } = await execFile('git', fullArgs, opts);
    return { stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (e) {
    const detail = stderrOf(e, `git ${args[0]} failed`);
    if (account && AUTH_FAILURE.test(detail)) {
      fail(403, 'GIT_ACCESS_DENIED',
        `The git account ${account.name} has no access to this repository (or its token expired).\n\n${detail}`);
    }
    fail(500, 'GIT_ERROR', detail);
  }
}

/** The acting user's account for the app's origin remote (null when none). */
async function accountFor(cwd) {
  let url = '';
  try {
    url = (await execFile('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim();
  } catch {
    return null;
  }
  return await resolveGitAccount(url);
}

export async function getStatus(cwd) {
  const { stdout: porcelain } = await git(cwd, ['status', '--porcelain']);
  const files = porcelain ? porcelain.split('\n').filter(Boolean).slice(0, 20) : [];
  const clean = files.length === 0;

  let branch = 'HEAD';
  try {
    branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || 'HEAD';
  } catch {}

  let ahead = 0, behind = 0, upstream = true;
  try {
    const { stdout } = await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    const [b, a] = stdout.split(/\s+/).map(n => parseInt(n, 10) || 0);
    behind = b;
    ahead = a;
  } catch {
    // No upstream tracking (never pushed, or pushed without -u).
    upstream = false;
  }

  return { clean, files, ahead, behind, branch, upstream };
}

export async function pullApp(name) {
  const { cwd, isFramework } = getCwdForApp(name);
  const before = (await git(cwd, ['rev-parse', 'HEAD'])).stdout;

  const status = await getStatus(cwd);
  if (!status.clean) {
    fail(409, 'DIRTY',
      `Uncommitted changes detected${isFramework ? ' in monorepo' : ` in apps/${name}`} ` +
      `(${status.files.length} file${status.files.length === 1 ? '' : 's'}). ` +
      `Commit/push them, or 'git reset --hard' to discard.`);
  }

  const pullOut = await git(cwd, ['pull', '--ff-only'], await accountFor(cwd));

  const after = (await git(cwd, ['rev-parse', 'HEAD'])).stdout;
  const changed = before !== after;

  let filesChanged = 0;
  if (changed) {
    try {
      const { stdout } = await git(cwd, ['diff', '--name-only', `${before}..${after}`]);
      filesChanged = stdout ? stdout.split('\n').filter(Boolean).length : 0;
    } catch {}
  }

  return {
    is_framework: isFramework,
    before_sha: before,
    after_sha: after,
    files_changed: filesChanged,
    // The core caches server modules for its whole life (preloaded at boot),
    // so any pulled change — framework or app — needs a core reload.
    needs_restart: changed,
    message: pullOut.stdout || pullOut.stderr || (changed ? 'Pulled.' : 'Already up to date.'),
  };
}

export async function pushApp(name) {
  const { cwd, isFramework } = getCwdForApp(name);
  const status = await getStatus(cwd);

  if (!status.clean) {
    fail(409, 'DIRTY',
      `Uncommitted changes${isFramework ? ' in monorepo' : ` in apps/${name}`}: ` +
      `commit them before pushing.`);
  }
  if (status.behind > 0) {
    fail(409, 'BEHIND', `Local is behind remote by ${status.behind} commit(s). Pull first.`);
  }
  if (status.upstream && status.ahead === 0) {
    return { noop: true, message: 'Nothing to push. Local is in sync with remote.' };
  }

  // No upstream yet (first push, or a publish whose push failed): set it.
  const pushOut = await git(cwd, status.upstream ? ['push'] : ['push', '-u', 'origin', status.branch], await accountFor(cwd));

  return {
    is_framework: isFramework,
    pushed: status.ahead,
    message: pushOut.stdout || pushOut.stderr || `Pushed ${status.ahead} commit(s).`,
  };
}

export async function commitApp(name, message) {
  if (!message || !message.trim()) {
    fail(400, 'NO_MESSAGE', 'Commit message is required.', 'Commit');
  }

  const { cwd, isFramework } = getCwdForApp(name);
  const status = await getStatus(cwd);

  if (status.clean) {
    return {
      noop: true,
      message: `Nothing to commit${isFramework ? ' in monorepo' : ` in apps/${name}`}. Working tree is already clean.`,
    };
  }

  await git(cwd, ['add', '.']);
  const commitOut = await git(cwd, ['commit', '-m', message.trim()], await accountFor(cwd));

  const sha = (await git(cwd, ['rev-parse', 'HEAD'])).stdout;

  return {
    is_framework: isFramework,
    sha,
    files_committed: status.files.length,
    message: commitOut.stdout || `Committed ${status.files.length} file(s).`,
  };
}

export async function discardApp(name) {
  const { cwd, isFramework } = getCwdForApp(name);

  await git(cwd, ['reset', '--hard', 'HEAD']);
  await git(cwd, ['clean', '-fd']);

  return {
    is_framework: isFramework,
    message: `Discarded local changes${isFramework ? ' in monorepo' : ` in apps/${name}`}.`,
  };
}

export async function getRemoteUrl(name) {
  let cwd, isFramework;
  try {
    ({ cwd, isFramework } = getCwdForApp(name));
  } catch {
    return '';
  }
  try {
    const { stdout } = await git(cwd, ['remote', 'get-url', 'origin']);
    return stdout || '';
  } catch {
    return '';
  }
}

/**
 * Connect an app to a remote and push it.
 *  - With `account` (one of the acting user's Git Accounts): the repository
 *    is `owner/repo` on GitHub (owner defaults to the account's user) and is
 *    created through the API when it doesn't exist yet.
 *  - With `remoteUrl` instead: any host, using the machine's credentials.
 */
export async function publishApp(name, { account, owner, repo, isPrivate = true, remoteUrl, message = 'Initial commit' } = {}) {
  if (name === 'loopar') {
    fail(409, 'IS_FRAMEWORK', 'Framework is published with the monorepo, not from App Manager.', 'Publish');
  }

  const appPath = loopar.makePath(loopar.pathRoot, 'apps', name);
  if (!fs.existsSync(appPath)) {
    fail(404, 'NO_DIR', `App directory ${appPath} does not exist.`, 'Publish');
  }

  let acc = null;
  let url;
  let created = false;
  if (account) {
    acc = await loadGitAccount(account);
    owner = String(owner || acc.username).trim();
    repo = String(repo || '').trim().replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
      fail(400, 'INVALID_REPO', 'Repository name may only contain letters, digits, ".", "-" and "_".', 'Publish');
    }
    const existing = await getRepository(acc.token, owner, repo);
    if (!existing) {
      await createRepository(acc.token, { owner, repo, isPrivate, username: acc.username });
      created = true;
    }
    url = `https://github.com/${owner}/${repo}.git`;
  } else if (remoteUrl && remoteUrl.trim()) {
    url = remoteUrl.trim();
  } else {
    fail(400, 'NO_REMOTE', 'Choose a git account and repository (or give a remote URL).', 'Publish');
  }

  const msg = (message || 'Initial commit').trim();
  const hasGit = fs.existsSync(loopar.makePath(appPath, '.git'));

  let hasOrigin = false;
  if (hasGit) {
    try {
      await git(appPath, ['remote', 'get-url', 'origin']);
      hasOrigin = true;
    } catch {
      hasOrigin = false;
    }
  }

  if (hasGit && hasOrigin) {
    fail(409, 'ALREADY_CONNECTED', `'${name}' already has a remote configured. Use Push to send changes.`, 'Publish');
  }

  try {
    if (!hasGit) {
      await git(appPath, ['init']);
      await git(appPath, ['remote', 'add', 'origin', url]);
      await git(appPath, ['add', '.']);
      await git(appPath, ['commit', '-m', msg], acc);
    } else {
      await git(appPath, ['remote', 'add', 'origin', url]);

      let hasHead = true;
      try {
        await git(appPath, ['rev-parse', 'HEAD']);
      } catch {
        hasHead = false;
      }
      if (!hasHead) {
        try {
          await git(appPath, ['add', '.']);
          await git(appPath, ['commit', '-m', msg], acc);
        } catch {
          fail(409, 'EMPTY_REPO', `'${name}' has .git but no commits and nothing stageable. Add content before publishing.`, 'Publish');
        }
      }
    }

    let branch = 'main';
    try {
      branch = (await git(appPath, ['symbolic-ref', '--short', 'HEAD'])).stdout || 'main';
    } catch {}

    await git(appPath, ['push', '-u', 'origin', branch], acc);

    return {
      remote_url: url,
      branch,
      created,
      message: `${created ? `Created ${url}. ` : ''}` + (hasGit
        ? `Connected '${name}' to ${url} and pushed ${branch}.`
        : `Published '${name}' to ${url} on branch ${branch}.`),
    };
  } catch (e) {
    // Roll back the connection so a failed publish (auth, missing repo…)
    // doesn't leave the app looking connected. Local commits are kept; the
    // next Publish just re-adds origin and pushes.
    await execFile('git', ['remote', 'remove', 'origin'], { cwd: appPath }).catch(() => {});
    fail(Number(e.status) || 500, e.code || 'GIT_ERROR',
      `${stderrOf(e, 'Publish failed')}\n\nThe remote was not connected; fix the issue and Publish again.`,
      e.title || 'Publish');
  }
}

export async function getDiff(name) {
  const { cwd, isFramework } = getCwdForApp(name);

  const stats = {};
  try {
    const { stdout } = await git(cwd, ['diff', '--numstat', 'HEAD']);
    if (stdout) {
      for (const line of stdout.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          stats[parts[2]] = {
            insertions: parseInt(parts[0], 10) || 0,
            deletions: parseInt(parts[1], 10) || 0,
          };
        }
      }
    }
  } catch {}

  const files = [];
  const { stdout: porcelain } = await git(cwd, ['status', '--porcelain']);
  if (porcelain) {
    for (const line of porcelain.split('\n').filter(Boolean)) {
      const flag = line.substring(0, 2).trim() || '?';
      const path = line.substring(3).trim();
      const s = stats[path] || { insertions: 0, deletions: 0 };
      files.push({
        status: flag,
        path,
        insertions: s.insertions,
        deletions: s.deletions,
      });
    }
  }

  let branch = 'HEAD';
  try {
    branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || 'HEAD';
  } catch {}

  let recent_commits = [];
  try {
    const { stdout } = await git(cwd, ['log', '--oneline', '-n', '5']);
    if (stdout) {
      recent_commits = stdout.split('\n').filter(Boolean).map(line => {
        const idx = line.indexOf(' ');
        return idx > 0
          ? { sha: line.substring(0, idx), subject: line.substring(idx + 1) }
          : { sha: line, subject: '' };
      });
    }
  } catch {}

  const version = getAppVersion(name);

  return {
    is_framework: isFramework,
    branch,
    clean: files.length === 0,
    files,
    recent_commits,
    version,
    suggested_message: version ? `Update to version ${version}` : null,
  };
}

export async function statusApp(name) {
  const { cwd, isFramework } = getCwdForApp(name);
  const status = await getStatus(cwd);
  return { ...status, is_framework: isFramework };
}
