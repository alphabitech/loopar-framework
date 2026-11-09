'use strict';

/**
 * Provider registry for social login.
 *
 * This is the ONLY file in Loopar that imports `arctic`. Each provider entry
 * normalizes arctic's provider-specific API to a common shape consumed by the
 * Auth controller, so the controller never branches on the provider:
 *
 *   client(cfg, redirectURI)            -> arctic provider instance
 *   authUrl(client, { state, codeVerifier, scopes }) -> URL
 *   exchange(client, { code, codeVerifier })         -> OAuth2Tokens
 *   profile(tokens)                     -> { email, email_verified, name, sub }
 *
 * OIDC providers (Google, and later Apple/Microsoft/Yahoo) read the verified
 * email straight from the id_token. GitHub is OAuth2-only, so it calls the
 * REST API for the primary verified email. Adding a provider = adding one entry
 * here; nothing else in the module changes.
 *
 * Trust model (agreed with Alfredo): we follow the "userinfo / token-endpoint
 * over TLS" pattern — the id_token is decoded (not signature-verified) because
 * it arrives directly from the provider's token endpoint over TLS in the same
 * request. If strict id_token signature validation is ever required (e.g. Apple),
 * swap `decodeIdToken` for a JWKS verify here, in isolation.
 */

import {
  Google,
  GitHub,
  generateState,
  generateCodeVerifier,
  decodeIdToken,
} from 'arctic';

const lower = (v) => String(v ?? '').trim().toLowerCase();

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

export const OAUTH_PROVIDERS = {
  google: {
    label: 'Google',
    usesPKCE: true,
    // Step-up (re-authentication): ask Google for a fresh sign-in, not the
    // silent "already signed in" consent.
    reauthParams: { prompt: 'login', max_age: '0' },
    defaultScopes: ['openid', 'profile', 'email'],
    client: (cfg, redirectURI) => new Google(cfg.client_id, cfg.client_secret, redirectURI),
    authUrl: (client, { state, codeVerifier, scopes }) =>
      client.createAuthorizationURL(state, codeVerifier, scopes),
    exchange: (client, { code, codeVerifier }) =>
      client.validateAuthorizationCode(code, codeVerifier),
    profile: async (tokens) => {
      const claims = decodeIdToken(tokens.idToken());
      return {
        email: lower(claims.email),
        email_verified: truthy(claims.email_verified),
        name: claims.name || null,
        sub: claims.sub != null ? String(claims.sub) : null,
        picture: claims.picture || null,
      };
    },
  },

  github: {
    label: 'GitHub',
    usesPKCE: false,
    defaultScopes: ['read:user', 'user:email'],
    client: (cfg, redirectURI) => new GitHub(cfg.client_id, cfg.client_secret, redirectURI),
    authUrl: (client, { state, scopes }) => client.createAuthorizationURL(state, scopes),
    exchange: (client, { code }) => client.validateAuthorizationCode(code),
    profile: async (tokens) => {
      const headers = {
        Authorization: `Bearer ${tokens.accessToken()}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'loopar-auth',
      };

      const userRes = await fetch('https://api.github.com/user', { headers });
      if (!userRes.ok) throw new Error(`github /user ${userRes.status}`);
      const user = await userRes.json();

      // /user never carries email_verified — pull the primary verified email.
      const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
      const emails = emailsRes.ok ? await emailsRes.json() : [];
      const primary = Array.isArray(emails)
        ? emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified)
        : null;

      return {
        email: lower(primary?.email || user?.email),
        email_verified: !!primary,
        name: user?.name || user?.login || null,
        sub: user?.id != null ? String(user.id) : null,
        picture: user?.avatar_url || null,
      };
    },
  },
};

export function getProvider(name) {
  return OAUTH_PROVIDERS[lower(name)] || null;
}

export function providerKeys() {
  return Object.keys(OAUTH_PROVIDERS);
}

export function providerLabel(name) {
  return OAUTH_PROVIDERS[lower(name)]?.label || name;
}

export { generateState, generateCodeVerifier };
