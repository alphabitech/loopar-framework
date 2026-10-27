#!/usr/bin/env node

/**
 * Loopar CLI — lifecycle for the project-local pm2 daemon.
 *
 */
import '../../packages/loopar/bin/check-node.js';
import { existsSync } from 'fs';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const [, , command, siteName, extraArg] = process.argv;

// ─── `start` / `tui` → the interactive manager (the local entrypoint) ───────
if (command === 'tui' || command === 'start') {
  if (process.stdout.isTTY && process.stdin.isTTY) {
    if (!existsSync('sites/dev/config.json')) {
      const ensure = fileURLToPath(new URL('../setup/ensure-site.js', import.meta.url));
      try { execFileSync(process.execPath, [ensure], { stdio: 'inherit' }); } catch (_) { /* TUI still opens */ }
    }
    const tui = fileURLToPath(new URL('../tui/index.js', import.meta.url));
    const { status } = spawnSync(process.execPath, [tui], { stdio: 'inherit' });
    process.exit(status ?? 0);
  }
  console.error('No interactive terminal — cannot open the TUI. Use `serve` for a headless boot.');
  process.exit(1);
}

const c = await import('./commands.js');

const registry = {
  serve:   () => c.host(),
  core:    () => c.host(),
  dev:     () => c.dev(),
  prod:    () => c.prod(),
  tenant:  () => c.tenantCmd(siteName, extraArg), // on | off | list [name]
  migrate: () => c.migrate(),
  stop:    () => c.stop(siteName),
  restart: () => c.restart(),
  delete:  () => c.del(siteName),
  kill:    () => c.kill(),
  watch:   () => c.watch(),
  startup: () => c.startup(),
  logs:    () => c.logs(siteName, extraArg),
  'mfa-reset': () => c.mfaReset(siteName, extraArg), // <tenant> <user>
  help:    () => c.help(),
};

const name = (!command || command === '--help' || command === '-h') ? 'help' : command;
const run = registry[name];

if (!run) {
  console.error(`\n❌ Unknown command: ${command}\n`);
  c.help();
  process.exit(1);
}

await run();
