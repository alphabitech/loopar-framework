import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import {
  pm2Command,
  withPm2,
  startProcess,
  startCoreProcess,
  restartCoreProcess,
  corePort,
  projectName,
  CORE_PROCESS_NAME,
} from './pm2.js';
const {yellow, green, cyan, red, gray} = chalk;
const log = console.log;

/**
 * `yarn serve` → boot THE core (the generator).
 *
 * One tenant-less process serves every tenant in-process. PM2 supervises it.
 * Caddy routes ALL tenant domains to the core port via one catch-all route.
 *
 */
export async function host() {
  const [{ tenants }, { default: CaddyManager }] = await Promise.all([
    import('loopar/bin/tenant/tenant-builder.js'),
    import('loopar/bin/tenant/caddy-manager.js'),
  ]);

  pm2Command('node bin/setup/ensure-site.js', true);

  const started = await withPm2(() => startCoreProcess());
  if (!started) {
    // Most common cause: the core is ALREADY running (PM2 reports "already
    // launched"). That's NOT fatal — we still (re)apply the Caddy config
    // below, which is the whole point of re-running `yarn start` after a
    // config or caddy-manager change. A genuine start failure just points
    // Caddy at a not-yet-up upstream (502 until it boots), which self-heals.
    console.warn(yellow(`⚠️  Core not freshly started (already running, or failed) — re-applying Caddy config anyway.`));
  }

  try {
    const port = corePort();
    const domains = tenants()
      .map(t => t.domain || `${t.name}.localhost`)
      .filter(Boolean);

    if (port && domains.length) {
      const caddy = new CaddyManager();
      await caddy.ensureReady();
      await caddy.registerHostCatchAll(port, domains);
    }
  } catch (err) {
    console.warn(yellow(`⚠️  Caddy host route not configured: ${err.message}`));
  }

  log(green(`\n✅ Core is up. Turn tenants On to serve them:  yarn tenant on <name>\n`));
}

/**
 * `yarn dev`  → set config/core.json nodeEnv=development, then boot the core.
 * `yarn prod` → same but production (see prod below).
 *
 * `serve` (host) boots in whatever mode the config already says; these are
 * the convenience shortcuts that also SET the mode.
 */
export async function dev() {
  const { setCoreMode } = await import('loopar/core/config/core-config.js');
  setCoreMode('development');
  log(cyan('Core mode → development (Vite / HMR)'));
  await host();
}

/**
 * `yarn prod` → set config/core.json nodeEnv=production, then boot the core.
 * Production serves the prebuilt dist and uses cluster mode. Refuses when no
 * build exists — run `yarn build` first (or `yarn dev` to develop).
 */
export async function prod() {
  const [{ setCoreMode }, { distIsReady }] = await Promise.all([
    import('loopar/core/config/core-config.js'),
    import('loopar/core/server/runtime-mode.js'),
  ]);
  if (!distIsReady()) {
    console.error(red('❌ No production build found in dist/.'));
    console.error(gray('   Run `yarn build` first (or `yarn dev` to run in development).'));
    process.exit(1);
  }
  setCoreMode('production');
  log(yellow('Core mode → production (prebuilt dist / cluster)'));
  await host();
}

/**
 * `yarn tenant <on|off|list> [name]` — the switchboard for the core.
 *
 * The core process is headless: tenants are turned On/Off by their STATUS in
 * sites/<name>/.env. The running core picks up the change within its registry
 * TTL and serves (or stops serving) the tenant on the next request — no
 * process to start or stop.
 *
 *   on   → STATUS=active   (tenant plugs into the core on next request)
 *   off  → STATUS=suspended (core serves a "suspended" page)
 *   list → show every tenant and its logical state
 */
export async function tenantCmd(sub, name) {
  const { tenant, tenants } = await import('loopar/bin/tenant/tenant-builder.js');
  const action = (sub || 'list').toLowerCase();

  if (action === 'list') {
    const rows = tenants().map(t => ({
      name: t.name,
      status: String(t.status || 'suspended').toLowerCase(),
      domain: t.domain || `${t.name}.localhost`,
    }));
    if (!rows.length) { log(yellow('No tenants in sites/.')); return; }
    log(chalk.bold('\nTenants:\n'));
    for (const r of rows) {
      const dot = r.status === 'suspended' ? red('●') : green('●');
      log(`  ${dot} ${r.name.padEnd(20)} ${gray(r.status.padEnd(10))} ${gray(r.domain)}`);
    }
    log('');
    return;
  }

  if (!name) {
    console.error(red(`Usage: yarn tenant ${action} <name>`));
    process.exit(1);
  }
  if (!tenants().some(t => t.name === name)) {
    console.error(red(`Tenant "${name}" not found in sites/.`));
    process.exit(1);
  }

  if (action === 'on') {
    await tenant.saveTenant({ NAME: name, STATUS: 'active' });
    log(green(`✅ ${name} → active. It will serve on the next request to its domain.`));
    return;
  }

  if (action === 'off') {
    await tenant.saveTenant({ NAME: name, STATUS: 'suspended' });
    log(yellow(`⏸  ${name} → suspended. Its domain now shows the suspended page.`));
    return;
  }

  console.error(red(`Unknown tenant action "${action}". Use: on | off | list.`));
  process.exit(1);
}

export async function stop(name) {
  const target = name || CORE_PROCESS_NAME;
  log(yellow(`Stopping ${target}...`));
  pm2Command(`pm2 stop ${target}`);
}

export async function restart() {
  await withPm2(() => restartCoreProcess());
}

/**
 * Remove a pm2 process from the registry — the core by default, or a named
 * helper. sites/ folders stay on disk (a tenant is config, not a process).
 */
export async function del(name) {
  const target = name || CORE_PROCESS_NAME;
  log(red(`Deleting ${target} from PM2...`));
  pm2Command(`pm2 delete ${target}`);
}

/**
 * Stops every Loopar process AND the daemon itself, scoped to the project's
 * PM2_HOME (set by loopar/bin/pm2-home.js). The next yarn start will
 * spawn a fresh daemon under <project>/.pm2/.
 */
export function kill() {
  log(red(`Killing Loopar PM2 daemon at ${process.env.PM2_HOME}`));
  pm2Command('pm2 kill');
}


export function logs(target, extra) {
  let name = target;
  let lines = 100;

  if (target && /^-+lines$/.test(target)) {
    lines = parseInt(extra, 10) || lines;
    name = null;
  } else if (extra && /^-+lines$/.test(extra)) {
    // `yarn logs <proc> --lines N` puts N in argv[5]; index.js forwards it as `lines`
    lines = parseInt(process.argv[5], 10) || lines;
  }

  name = name || CORE_PROCESS_NAME;
  log(cyan(`Showing logs for ${name}...\n`));
  pm2Command(`pm2 logs ${name} --lines ${lines}`);
}

export async function watch() {
  log(cyan('Starting build-watch under pm2...'));
  const ok = await withPm2(() => startProcess({
    name: 'build-watch',
    namespace: projectName,
    script: 'bin/build/watch.js',
    autorestart: true,
    max_memory_restart: '1G',
    env: { NODE_ENV: 'production' },
  }));
  if (ok) {
    log(green('build-watch online — build/staging/ rebuilds on every source edit.'));
    log(gray('Logs: yarn logs build-watch · Stop: yarn stop build-watch · Deploy snapshot: yarn activate'));
  }
}

export function startup() {
  const user = os.userInfo().username;
  const home = os.homedir();
  const platform = process.platform === 'darwin' ? 'launchd' : 'systemd';

  log(cyan('\n📋 Loopar startup setup\n'));
  log(gray(`PM2_HOME = ${process.env.PM2_HOME}`));
  log(gray(`User     = ${user}`));
  log(gray(`Home     = ${home}`));
  log(gray(`Platform = ${platform}\n`));

  if (user === 'root') {
    console.error(red('❌ Run this as your normal user, NOT with sudo.'));
    console.error(red('   Registering pm2 as root makes every project file root-owned.\n'));
    process.exit(1);
  }

  log(cyan('Step 1: saving current pm2 process list...\n'));
  const saved = pm2Command('pm2 save');
  if (!saved) {
    console.error(red('\n❌ pm2 save failed. Ensure the daemon is running (yarn start all) and try again.\n'));
    process.exit(1);
  }

  // Step 2 — generate the boot unit, explicitly scoped to this user so the
  // daemon is never registered to run as root.
  log(cyan('\nStep 2: generating boot-time unit...\n'));
  log(yellow('⚠️  pm2 will print a sudo command below. Copy and run it AS-IS.'));
  log(yellow('   That is the ONLY pm2 command that should ever use sudo.\n'));
  pm2Command(`pm2 startup ${platform} -u ${user} --hp ${home}`);

  log(green(`\n✅ After running the sudo command, all tenants currently online will`));
  log(green(`   resurrect automatically on every reboot — owned by ${user}, not root.\n`));
  log(red('🚫 Never run pm2 / yarn / npm with sudo again. Doing so makes project'));
  log(red('   files root-owned and you lose read/write access in your editor.\n'));
  log(gray('Verify:'));
  log(cyan('  sudo reboot'));
  log(cyan('  yarn tui    # all previously-online tenants should be online again\n'));
  log(gray('Remove auto-start later (if needed):'));
  log(cyan(`  pm2 unstartup ${platform}\n`));
}

/**
 * `yarn mfa-reset <tenant> <user>` → turn 2FA off for a user (name or email)
 * who lost the phone AND the recovery codes. The way back in for the
 * Administrator, who has nobody above to reset it from the desk.
 */
export async function mfaReset(tenantName, userName) {
  if (!tenantName || !userName) {
    log(red('\nUsage: yarn mfa-reset <tenant> <user>\n'));
    process.exit(1);
  }

  const { tenants } = await import('loopar/bin/tenant/tenant-builder.js');
  if (!tenants().some(t => t.name === tenantName)) {
    log(red(`\n❌ Unknown tenant: ${tenantName}\n`));
    process.exit(1);
  }

  const { loopar, getOrCreateTenantInstance, requestContext } = await import('loopar');
  const { resetMfa } = await import('../../apps/loopar/modules/auth/controllers/auth/mfa.js');

  await getOrCreateTenantInstance(tenantName);
  const name = await requestContext.run({ tenant: { name: tenantName } }, async () => {
    const row = await loopar.db.query('User')
      .where({ name: userName }).orWhere({ email: userName })
      .select('name').first();
    if (!row) return null;
    await resetMfa(row.name);
    return row.name;
  });

  if (!name) {
    log(red(`\n❌ No user "${userName}" on tenant "${tenantName}".\n`));
    process.exit(1);
  }

  log(green(`\n✅ Two-factor authentication reset for "${name}" on "${tenantName}".\n`));
  process.exit(0);
}

export function help() {
  log(cyan('\nLoopar CLI\n'));
  log(white('Usage: ') + cyan('yarn <command> [siteName]') + gray('  (or: node bin/cli/index.js <command>)\n'));
  log(white('Lifecycle:'));
  log(cyan('  start             ') + gray('Open the interactive tenant manager (TUI) — local entrypoint'));
  log(cyan('  serve             ') + gray('Headless boot of the core in the mode config/core.json says'));
  log(cyan('  prod              ') + gray('Set the core to production (guards a build exists) and boot'));
  log(cyan('  tenant <on|off|list> [name]') + gray('  Turn a tenant on/off or list them'));
  log(cyan('  stop [proc]       ') + gray('Stop the core (or a named pm2 process, e.g. build-watch)'));
  log(cyan('  restart           ') + gray('Restart the core (re-reads config/core.json)'));
  log(cyan('  delete [proc]     ') + gray('Remove the core (or a named process) from pm2'));
  log(cyan('  kill              ') + gray('Kill processes AND the daemon (clean slate)'));
  log();
  log(white('Inspection:'));
  log(cyan('  tui               ') + gray('Interactive tenant manager (same as bare start)'));
  log(cyan('  logs [proc]       ') + gray('Tail logs — all processes, or one named process'));
  log();
  log(white('Operations:'));
  log(cyan('  migrate           ') + gray('One-shot: legacy sites/<t>/.env → config.json'));
  log(cyan('  watch             ') + gray('Warm release builder → build/staging under pm2 (stop: yarn stop build-watch)'));
  log(cyan('  startup           ') + gray('Register reboot-safe boot hook (run once after first deploy)'));
  log(cyan('  mfa-reset <tenant> <user>') + gray('  Turn 2FA off for a user who lost the phone and recovery codes'));
  log(cyan('  help              ') + gray('Show this message'));
  log();
  log(gray('dev/prod is a GLOBAL core switch (config/core.json → nodeEnv), toggled from'));
  log(gray('the TUI ([p]) or `yarn prod` — not a per-tenant or per-command mode.'));
  log(gray('\nAll commands operate on the project-local pm2 daemon at:'));
  log(gray(`  ${process.env.PM2_HOME}\n`));
}
