'use strict';

import { loopar } from 'loopar';

const API = 'https://api.github.com';

function fail(status, code, message) {
  loopar.throw({ status, code, title: 'GitHub', message });
}

async function request(token, method, path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'loopar',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(502, 'GITHUB_UNREACHABLE', `Could not reach GitHub: ${e.message}`);
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

/**
 * Who the token belongs to and what it can reach. Throws when the token is
 * invalid. Emails/orgs are best-effort: fine-grained tokens may not grant
 * them, which must not block saving the account.
 */
export async function inspectToken(token) {
  const me = await request(token, 'GET', '/user');
  if (me.status === 401) fail(401, 'INVALID_TOKEN', 'GitHub rejected the token (invalid or expired).');
  if (!me.ok) fail(me.status, 'GITHUB_ERROR', me.data?.message || `GitHub returned ${me.status}`);

  const login = me.data.login;

  let email = me.data.email || null;
  const emails = await request(token, 'GET', '/user/emails');
  if (emails.ok && Array.isArray(emails.data)) {
    email = (emails.data.find(e => e.primary && e.verified) || emails.data[0])?.email || email;
  }
  email ||= `${me.data.id}+${login}@users.noreply.github.com`;

  const orgs = await request(token, 'GET', '/user/orgs?per_page=100');
  const orgLogins = orgs.ok && Array.isArray(orgs.data) ? orgs.data.map(o => o.login) : [];

  return {
    login,
    name: me.data.name || login,
    email,
    owners: [login, ...orgLogins],
    // Only set for tokens with an expiration date.
    expiresAt: me.headers.get('github-authentication-token-expiration') || null,
  };
}

/** Repository info, or null when it doesn't exist (or the token can't see it). */
export async function getRepository(token, owner, repo) {
  const res = await request(token, 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (res.status === 404) return null;
  if (!res.ok) fail(res.status, 'GITHUB_ERROR', res.data?.message || `GitHub returned ${res.status}`);
  return res.data;
}

/** Create `owner/repo` (under the user, or under an organization). */
export async function createRepository(token, { owner, repo, isPrivate = true, username }) {
  const path = owner === username ? '/user/repos' : `/orgs/${encodeURIComponent(owner)}/repos`;
  const res = await request(token, 'POST', path, { name: repo, private: !!isPrivate, auto_init: false });
  if (!res.ok) {
    const detail = res.data?.errors?.map(e => e.message).filter(Boolean).join('; ');
    fail(res.status, 'REPO_CREATE_FAILED',
      `Could not create ${owner}/${repo}: ${res.data?.message || res.status}${detail ? ` (${detail})` : ''}`);
  }
  return res.data;
}

/** owner/repo from a GitHub remote URL (https or ssh), or null. */
export function parseGithubRemote(url) {
  const m = String(url || '').trim()
    .match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}
