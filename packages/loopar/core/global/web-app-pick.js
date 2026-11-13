'use strict';

/**
 * Which installed app serves the workspace's website.
 *
 * The one chosen in System Settings wins while it is still installed.
 * Otherwise — nothing chosen yet, or the chosen app was uninstalled — the
 * first installed app that has a website is taken, so installing a site is
 * enough to publish it. Null when no app has a website.
 *
 * @param {string|null} chosen System Settings' `active_web_app`
 * @param {{id:number,name:string,has_website:any}[]} apps installed apps
 */
export function pickWebApp(chosen, apps = []) {
  const truthy = (v) => v === 1 || v === true || v === '1' || v === 'true';
  const wanted = String(chosen ?? '').trim();
  if (wanted && apps.some(app => app.name === wanted)) return wanted;

  const websites = apps.filter(app => truthy(app.has_website))
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  return websites[0]?.name || null;
}
