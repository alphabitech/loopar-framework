import fs from "fs";
import path from "pathe";
import { loopar, fileManage, tenant } from "loopar";
import { refreshCaddy } from "../../../../../../bin/tenant/tenant-ops.js";

/**
 * Website templates.
 *
 * A template is an app whose installer.json header carries `is_template: 1`.
 * It holds content only (pages, website settings, sample records) and may
 * `requires` logic apps that stay shared and updatable. In production a
 * template is never installed as is: each site is a copy of it
 * (apps/<site>), owned by one tenant, so the designer can rewrite that
 * site's files without touching the template or other tenants' sites.
 */

export const SITE_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const SKIP = new Set([".git", "node_modules"]);

const appsDir = (...parts) => loopar.makePath(loopar.pathRoot, "apps", ...parts);

/** "a, b" | ["a","b"] → ["a","b"] */
export function parseRequires(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(list.map(v => String(v).trim()).filter(Boolean))];
}

/** installer.json header (`App`) of an app folder, or null. */
export function readAppHeader(appName) {
  if (!appName || !fs.existsSync(appsDir(appName, "installer.json"))) return null;
  return fileManage.getConfigFile("installer", loopar.makePath("apps", appName), {})?.App || null;
}

export const isTemplateHeader = (header) => Number(header?.is_template) === 1;

/** A site created from a template belongs to one tenant only. */
export const belongsToOtherTenant = (header) =>
  !!header?.owner_tenant && header.owner_tenant !== loopar.tenantId;

export function defaultSiteName(tenantId = loopar.tenantId) {
  const base = String(tenantId || "site").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${/^[a-z]/.test(base) ? base : `s-${base}`}-site`.slice(0, 41);
}

/** The app's installer model (its own installer.js, or the core Installer). */
export async function loadInstaller(appName, data = {}) {
  const Installer = await fileManage.importClass(loopar.makePath("apps", appName, "installer.js"), false);
  const model = Installer ? new Installer(data) : await loopar.newDocument("Installer", { ...data, app_name: appName });
  model.app_name ??= appName;
  return model;
}

const fail = (status, code, message) => loopar.throw({ status, code, title: "Create site", message });

function rewrite(value, from, to) {
  if (Array.isArray(value)) return value.map(v => rewrite(v, from, to));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = k === `App:${from}` ? `App:${to}` : k === `Module:${from}` ? `Module:${to}` : k;
      out[key] = rewrite(v, from, to);
    }
    return out;
  }
  if (typeof value === "string") {
    if (value === from) return to;
    return value
      .replaceAll(`/apps/${from}/modules/${from}/`, `/apps/${to}/modules/${to}/`)
      .replaceAll(`/apps/${from}/`, `/apps/${to}/`);
  }
  return value;
}

function jsonFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFiles(p));
    else if (entry.name.endsWith(".json")) out.push(p);
  }
  return out;
}

/**
 * Copies template `template` to apps/<siteName> as a regular app owned by the
 * current tenant: renames the app and its module (same name as the app),
 * points every `app` / `module` / `__root__` at the copy and drops
 * `is_template`. Does not install it. Returns the site name.
 */
export async function createSiteFromTemplate(template, siteName) {
  template = String(template ?? "").trim();
  siteName = String(siteName ?? "").trim().toLowerCase();

  const header = readAppHeader(template);
  if (!header) fail(404, "TEMPLATE_NOT_FOUND", `Template "${template}" was not found.`);
  if (!isTemplateHeader(header)) fail(422, "NOT_A_TEMPLATE", `App "${template}" is not a template.`);
  if (!SITE_NAME_RE.test(siteName)) {
    fail(400, "INVALID_SITE_NAME", `Invalid site name "${siteName}": lowercase letters, numbers and dashes, starting with a letter.`);
  }
  if (siteName === template || fs.existsSync(appsDir(siteName))) {
    fail(409, "SITE_EXISTS", `An app named "${siteName}" already exists.`);
  }

  // Page names stay as in the template; refuse when an app INSTALLED in this
  // tenant already has one of them (e.g. the template itself, or another site
  // made from it). Folders on disk that this tenant doesn't use don't count.
  const installed = new Set(Object.keys(loopar.installedApps || {}).map(a => a.toLowerCase()));
  const inst = fileManage.getConfigFile("installer", loopar.makePath("apps", template), {});
  const taken = Object.keys(inst.documents || {})
    .filter(k => k.startsWith("Page Builder:"))
    .map(k => k.slice("Page Builder:".length))
    .filter(name => {
      const app = loopar.getRef(name)?.__APP__;
      return app && installed.has(String(app).toLowerCase());
    });
  if (taken.length) {
    fail(409, "PAGES_EXIST", `This workspace already has pages named ${taken.map(n => `"${n}"`).join(", ")}. Remove them (or the app that owns them) first.`);
  }

  const dst = appsDir(siteName);
  try {
    fs.cpSync(appsDir(template), dst, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });

    const moduleDir = path.join(dst, "modules", template);
    if (fs.existsSync(moduleDir)) fs.renameSync(moduleDir, path.join(dst, "modules", siteName));

    for (const file of jsonFiles(dst)) {
      const data = rewrite(JSON.parse(fs.readFileSync(file, "utf8")), template, siteName);
      if (path.relative(dst, file) === "installer.json") {
        const { is_template, ...app } = data.App || {};
        data.App = { ...app, name: siteName, template, owner_tenant: loopar.tenantId };
        const appDoc = data.documents?.[`App:${siteName}`];
        if (appDoc) {
          appDoc.name = siteName;
          appDoc.is_template = 0;
        }
      }
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    }
  } catch (e) {
    fs.rmSync(dst, { recursive: true, force: true });
    throw e;
  }

  return siteName;
}

/** Creates the site, installs it (requirements first) and optionally makes it the active website. */
export async function installSiteFromTemplate(template, siteName = defaultSiteName(), { activate = true } = {}) {
  const site = await createSiteFromTemplate(template, siteName);
  // On a failed install the copy stays: it can be retried or uninstalled
  // from the App Manager like any other app.
  const model = await loadInstaller(site);
  await model.install(false);
  if (activate) await activateWebApp(site);
  return site;
}

export async function activateWebApp(appName) {
  const settings = await loopar.getDocument("System Settings");
  settings.active_web_app = appName;
  await settings.save({ validate: false });
  await loopar.build();
}

/**
 * Serves `app` on `domain` from this tenant (Tenant Manager → Domains): the
 * tenant's `sites` map, Caddy routes, and the website cache are refreshed.
 */
export async function addSiteDomain(domain, app) {
  const current = tenant.readTenant(loopar.tenantId)?.sites || {};
  const owner = current[domain];
  if (owner && owner !== app) {
    loopar.throw({ status: 409, code: "DOMAIN_TAKEN", title: "Create site", message: `${domain} already serves "${owner}".` });
  }
  await tenant.saveTenant({ NAME: loopar.tenantId, sites: { ...current, [domain]: app } });
  await refreshCaddy();
  await loopar.build();
}
