'use strict';

import fs from 'fs';
import path from 'path';
import { loopar } from 'loopar';
import { parseGithubRemote } from './github-api.js';

/** The acting user's accounts (no tokens), default first. */
export async function listGitAccounts(user = loopar.auth.user()) {
  if (!user) return [];
  const rows = await loopar.db.getAll(
    'Git Account',
    ['name', 'provider', 'username', 'owners', 'is_default'],
    { __created_by__: user }
  );
  return rows
    .map(r => ({ ...r, is_default: Number(r.is_default) ? 1 : 0, owners: String(r.owners || '').split('\n').filter(Boolean) }))
    .sort((a, b) => b.is_default - a.is_default);
}

/** Load one of the acting user's accounts with its (decrypted) token. */
export async function loadGitAccount(name, user = loopar.auth.user()) {
  const owner = await loopar.db.getValue('Git Account', '__created_by__', name);
  if (!owner || owner !== user) {
    loopar.throw({ status: 404, code: 'GIT_ACCOUNT_NOT_FOUND', title: 'Git', message: `Git account ${name} not found.` });
  }
  const doc = await loopar.getDocument('Git Account', name);
  return {
    name: doc.name,
    username: doc.username,
    token: doc.token,
    author: { name: doc.author_name || doc.username, email: doc.author_email || '' },
  };
}

/**
 * Account to use for `remoteUrl`, for the user performing the action:
 * one whose user/orgs match the repository owner, else their default.
 * null when the user has no account — git then falls back to whatever
 * credentials the machine has (e.g. public repos, local keychain).
 */
export async function resolveGitAccount(remoteUrl, user = loopar.auth.user()) {
  const accounts = await listGitAccounts(user);
  if (!accounts.length) return null;

  const repo = parseGithubRemote(remoteUrl);
  const match = repo && (
    accounts.find(a => a.username?.toLowerCase() === repo.owner.toLowerCase()) ||
    accounts.find(a => a.owners.some(o => o.toLowerCase() === repo.owner.toLowerCase()))
  );
  return await loadGitAccount((match || accounts[0]).name, user);
}

/**
 * GIT_ASKPASS helper: answers git's username/password prompts from env vars
 * set per command, so the token never lands in .git/config, the remote URL
 * or the process arguments. Lives under node_modules/.cache (private to the
 * install, never committed) rather than a shared /tmp.
 */
let askpassPath = null;
export function getAskpassScript() {
  if (askpassPath && fs.existsSync(askpassPath)) return askpassPath;
  const dir = path.join(loopar.pathRoot, 'node_modules', '.cache', 'loopar');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  askpassPath = path.join(dir, 'git-askpass.sh');
  fs.writeFileSync(askpassPath,
    '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' "$LOOPAR_GIT_USERNAME" ;;\n  *) printf \'%s\\n\' "$LOOPAR_GIT_TOKEN" ;;\nesac\n',
    { mode: 0o700 });
  fs.chmodSync(askpassPath, 0o700);
  return askpassPath;
}
