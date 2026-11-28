'use strict';

import fs from "fs";
import path from "pathe";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { loopar, fileManage } from "loopar";

const execFile = promisify(execFileCb);
const FRAMEWORK_APP = "loopar";
const SOURCES_FILE = "app-sources";

/**
 * Where an app's code comes from: the git repository that holds it and the
 * version (tag) its working tree is at. An app's versions are git tags named
 * `<app>@<version>`, created when a commit ships a new installer version —
 * the same name works for apps with their own repository and for the
 * framework, which lives in the monorepo.
 *
 * A server runs one version of each app (its folder); each tenant records
 * which commit its database was installed from (sites/<tenant>/config/
 * app-sources.json), so an installed version never loses its source.
 */

export const tagName = (app, version) => `${app}@${version}`;

/** The repository of an app: its own .git, or the monorepo for the framework. Null without git. */
export function appRepo(app) {
  const appPath = loopar.makePath(loopar.pathRoot, "apps", app);
  if (fs.existsSync(path.join(appPath, ".git"))) {
    return { cwd: appPath, isFramework: false, installerPath: "installer.json" };
  }
  if (app === FRAMEWORK_APP) {
    return { cwd: loopar.pathRoot, isFramework: true, installerPath: "apps/loopar/installer.json" };
  }
  return null;
}

async function git(cwd, args) {
  const { stdout } = await execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return (stdout || "").trim();
}

const quiet = (p) => p.catch(() => "");

/** The installer version committed at `rev` (null when the commit has no installer). */
export async function versionAt(app, rev = "HEAD") {
  const repo = appRepo(app);
  if (!repo) return null;
  try {
    const data = JSON.parse(await git(repo.cwd, ["show", `${rev}:${repo.installerPath}`]));
    return data?.App?.version || null;
  } catch {
    return null;
  }
}

/**
 * The working tree's source: commit, branch (null when pinned to a version,
 * i.e. a detached HEAD) and the version tag at that commit, if any.
 */
export async function headSource(app) {
  const repo = appRepo(app);
  if (!repo) return null;
  const commit = await quiet(git(repo.cwd, ["rev-parse", "HEAD"]));
  if (!commit) return null;
  const branch = await quiet(git(repo.cwd, ["symbolic-ref", "-q", "--short", "HEAD"]));
  const tags = await quiet(git(repo.cwd, ["tag", "--points-at", "HEAD", "--list", `${app}@*`]));
  const tag = tags.split("\n").filter(Boolean).pop() || null;
  return {
    commit,
    short: commit.slice(0, 7),
    branch: branch || null,
    pinned: !branch,
    tag,
    version: tag ? tag.slice(app.length + 1) : null,
  };
}

/** The app's versions (tags), newest first. */
export async function listVersions(app) {
  const repo = appRepo(app);
  if (!repo) return [];
  // Annotated tags point at a tag object: the peeled commit is the one to show.
  const format = "%(refname:short)|%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)|%(creatordate:iso-strict)";
  const out = await quiet(git(repo.cwd, ["tag", "--list", `${app}@*`, "--sort=-v:refname", `--format=${format}`]));
  return out.split("\n").filter(Boolean).map((line) => {
    const [tag, commit, date] = line.split("|");
    return { tag, version: tag.slice(app.length + 1), commit, short: commit.slice(0, 7), date: date || null };
  });
}

/** What each app of this tenant was installed from. */
export function installedSources() {
  return fileManage.getConfigFile(SOURCES_FILE) || {};
}

/** After an install/update: this tenant's database now matches the app's working tree. */
export async function recordInstall(app) {
  if (!loopar.tenantId) return;
  const source = await headSource(app).catch(() => null);
  const header = fileManage.getAppData(app)?.App || {};
  await fileManage.setConfigFile(SOURCES_FILE, {
    ...installedSources(),
    [app]: {
      version: header.version || null,
      commit: source?.commit || null,
      tag: source?.tag || null,
      installed_at: new Date().toISOString(),
    },
  });
}

/**
 * A version made here (development: the designer bumps the app when its
 * entities are saved). The database is ahead of every commit, so the record
 * has no commit until the app is installed or updated from one.
 */
export async function recordDevelopment(app, version) {
  if (!loopar.tenantId) return;
  await fileManage.setConfigFile(SOURCES_FILE, {
    ...installedSources(),
    [app]: { version, commit: null, tag: null, installed_at: new Date().toISOString(), source: "development" },
  });
}

/** After an uninstall. */
export async function forgetInstall(app) {
  if (!loopar.tenantId) return;
  const sources = installedSources();
  if (!(app in sources)) return;
  delete sources[app];
  await fileManage.setConfigFile(SOURCES_FILE, sources);
}
