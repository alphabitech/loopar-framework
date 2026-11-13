'use strict';

/**
 * What a designer-authored link target is allowed to be.
 *
 * A link's `to` comes from a document structure (entity form, page), so it is
 * data, not code: only navigable schemes pass. Anything else carrying a scheme
 * (`javascript:`, `data:`, `vbscript:`, `file:`…) is inert.
 */
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

// Browsers ignore tabs/newlines/control chars inside a scheme ("java\tscript:").
const clean = (to) => String(to ?? '').replace(/[\u0000- \u007f]+/g, '');

const schemeOf = (to) => clean(to).match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase() || null;

/** True when the target leaves the app (another origin, mail, phone). */
export function isExternalTarget(to) {
  const value = clean(to);
  if (value.startsWith('//') || value.startsWith('/\\')) return true;
  const scheme = schemeOf(value);
  return scheme !== null && EXTERNAL_SCHEMES.has(scheme);
}

/** The target as given when it is navigable, or '' when it must not be followed. */
export function safeTarget(to) {
  if (to === null || to === undefined) return '';
  const scheme = schemeOf(to);
  if (scheme !== null && !EXTERNAL_SCHEMES.has(scheme)) return '';
  return String(to);
}
