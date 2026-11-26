/**
 * Version stamp of the tenant's public files (`/assets/public/…`): it changes
 * when a file is added, replaced or removed, so a URL that carries it
 * (`?v=<stamp>`) can be cached for good and still never shows a stale logo or
 * image — a changed file is a new URL for browsers and CDNs alike.
 *
 *   - Server: resolved per request (core/server/assets-version.js registers
 *     the resolver).
 *   - Browser: the page carries `window.__LOOPAR_ASSETS_V__`, the stamp the
 *     server rendered with, so SSR and hydration print the same URLs.
 */
const CLIENT_KEY = "__LOOPAR_ASSETS_V__";
const PUBLIC_PREFIX = "/assets/public/";

// On globalThis, not module state: the SSR bundle carries its own copy of this
// module, separate from the one the server registered the resolver in.
const RESOLVER_KEY = "__looparAssetsVersionResolver__";

export function setAssetsVersionResolver(resolver) {
  globalThis[RESOLVER_KEY] = resolver;
}

export function assetsVersion() {
  if (typeof window !== "undefined") return window[CLIENT_KEY] || "";
  try { return globalThis[RESOLVER_KEY]?.() || ""; } catch { return ""; }
}

/** A stored `src` may carry an old stamp (a form saved the mapped file back): drop it. */
export function unversioned(url) {
  return typeof url === "string" && url.startsWith(PUBLIC_PREFIX) ? url.replace(/\?v=[^&#]*$/, "") : url;
}

/** `url` with the current stamp, for local public files only (never private, remote or data URLs). */
export function versioned(url) {
  if (typeof url !== "string" || !url.startsWith(PUBLIC_PREFIX)) return url;
  const version = assetsVersion();
  const clean = unversioned(url);
  return version && !clean.includes("?") ? `${clean}?v=${version}` : clean;
}
