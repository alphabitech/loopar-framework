'use strict';

import { loopar, fileManager } from 'loopar';

const escapeAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Name a kiosk page installs as: the page's name (people can rename it while installing). */
const appName = (page) => String(page || loopar.webApp?.name || 'Kiosk').trim().slice(0, 45);

const iconOf = (webApp) => fileManager.getMappedFiles(webApp?.logo_mini)[0]?.src || null;

/**
 * Web app manifest of a kiosk page, so a phone or tablet can install it as an
 * app (home screen icon, full screen). No `start_url`: browsers then start at
 * the page it was installed from (`/kiosk/station`, a personal `/kiosk/clock?…`).
 */
export function kioskManifest(page) {
  const icon = iconOf(loopar.webApp);
  const name = appName(page);
  return {
    name,
    short_name: name,
    display: 'standalone',
    scope: '/kiosk/',
    background_color: '#ffffff',
    icons: icon ? [{ src: icon, sizes: 'any', type: icon.endsWith('.svg') ? 'image/svg+xml' : 'image/png', purpose: 'any' }] : [],
  };
}

/** <head> tags of a kiosk page: its manifest, plus the iOS equivalents. */
export function kioskHeadTags(page) {
  const name = escapeAttr(appName(page));
  const icon = iconOf(loopar.webApp);
  return [
    `<link rel="manifest" href="/assets/public/kiosk.webmanifest?page=${encodeURIComponent(page || '')}"/>`,
    `<meta name="mobile-web-app-capable" content="yes"/>`,
    `<meta name="apple-mobile-web-app-capable" content="yes"/>`,
    `<meta name="apple-mobile-web-app-title" content="${name}"/>`,
    icon && !icon.endsWith('.svg') ? `<link rel="apple-touch-icon" href="${escapeAttr(icon)}"/>` : '',
  ].join('');
}
