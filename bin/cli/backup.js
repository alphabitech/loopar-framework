/**
 * `yarn backup` — tenant backups from the terminal (no framework, no running
 * core needed; the rescue path when a site won't boot).
 *
 *   yarn backup                                   last backup of every tenant
 *   yarn backup create <tenant|--all> [--local]   back up (--local: don't copy to the destination)
 *   yarn backup list <tenant>                     local + remote backups
 *   yarn backup restore <tenant> <file> [--as <new>] [--passphrase <p>] [--yes] [--force]
 *   yarn backup delete <tenant> <file> [--local|--remote]
 *
 * In-place restore needs the tenant Off (`yarn tenant off <t>`): a running
 * core would keep writing to the database being replaced. --force skips the
 * check. The passphrase also comes from LOOPAR_BACKUP_PASSPHRASE.
 */
import readline from 'node:readline/promises';
import chalk from 'chalk';

const { cyan, green, red, yellow, gray, bold } = chalk;
const log = console.log;

function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (['as', 'passphrase'].includes(key) && next !== undefined) { flags[key] = next; i++; } else flags[key] = true;
    } else args.push(a);
  }
  return { args, flags };
}

const fmtSize = (n) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDate = (d) => d.toLocaleString([], { hour12: false });
const die = (msg) => { console.error(red(`\n✗ ${msg}\n`)); process.exit(1); };

export function usage() {
  log(cyan('\nyarn backup') + gray('                                  last backup of every tenant'));
  log(cyan('yarn backup create <tenant|--all> [--local]') + gray('  back up (--local: keep it on this server only)'));
  log(cyan('yarn backup list <tenant>') + gray('                    local and remote backups'));
  log(cyan('yarn backup restore <tenant> <file> [--as <new>] [--passphrase <p>] [--yes]'));
  log(gray('                                               in place (tenant Off) or as a new tenant'));
  log(cyan('yarn backup delete <tenant> <file> [--local|--remote]\n'));
}

export async function backupCmd(argv) {
  const { args, flags } = parse(argv);
  const [sub, tenantName, file] = args;
  const engine = await import('loopar/core/backup/index.js');
  const { tenants, readTenant } = await import('loopar/bin/tenant/tenant-builder.js');
  const names = tenants().map((t) => t.name);
  const need = (t) => { if (!t || !names.includes(t)) die(`Unknown tenant "${t ?? ''}". Tenants: ${names.join(', ')}`); };

  if (!sub || sub === 'status') {
    log(bold('\nBackups (this server):\n'));
    for (const t of names) {
      const [last] = engine.listLocalBackups(process.cwd(), t);
      log(`  ${t.padEnd(22)} ${last ? `${fmtDate(last.date)}  ${gray(last.kind.padEnd(12))} ${gray(fmtSize(last.size))}` : yellow('no backups')}`);
    }
    usage();
    return;
  }

  if (sub === 'create') {
    const list = flags.all || tenantName === '--all' ? names : [tenantName];
    if (!flags.all && tenantName !== '--all') need(tenantName);
    let failed = 0;
    for (const t of list) {
      process.stdout.write(`${cyan(t)} `);
      try {
        const r = await engine.createBackup({ tenant: t, kind: 'manual', upload: !flags.local, onStep: (s) => process.stdout.write(gray(`${s}… `)) });
        log(green(`✓ ${r.file}`) + gray(` ${fmtSize(r.size)}${r.encrypted ? ', encrypted' : ''}`));
        if (r.remote.destination) log(r.remote.ok ? gray(`  copied to ${r.remote.destination}`) : yellow(`  not copied to ${r.remote.destination}: ${r.remote.error}`));
        if (r.remote.ok === false) failed++;
      } catch (e) {
        failed++;
        log(red(`✗ ${e.message}`));
      }
    }
    process.exit(failed ? 1 : 0);
  }

  if (sub === 'list') {
    need(tenantName);
    const { rows, destination, remoteError } = await engine.listBackups({ tenant: tenantName });
    log(bold(`\nBackups of ${tenantName}`) + gray(destination ? ` (this server + ${destination})` : ' (this server)') + '\n');
    if (remoteError) log(yellow(`  ${destination}: ${remoteError}\n`));
    if (!rows.length) log(gray('  none'));
    for (const r of rows) {
      const where = [r.local ? 'local' : null, r.remote ? destination : null].filter(Boolean).join('+');
      log(`  ${fmtDate(r.date).padEnd(22)} ${r.kind.padEnd(12)} ${fmtSize(r.size).padStart(9)}  ${gray(where.padEnd(14))} ${r.file}`);
    }
    log('');
    return;
  }

  if (sub === 'restore') {
    need(tenantName);
    if (!file) die('Which backup? yarn backup list <tenant> shows them.');
    const asNew = typeof flags.as === 'string' ? flags.as : null;
    if (!asNew && readTenant(tenantName)?.status === 'active' && !flags.force) {
      die(`"${tenantName}" is On. Turn it off first (yarn tenant off ${tenantName}), restore, then turn it on.`);
    }
    if (!asNew && !flags.yes) {
      if (!process.stdin.isTTY) die('Confirm with --yes when not running in a terminal.');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(yellow(`This replaces the data and files of "${tenantName}" (a snapshot is taken first). Type the tenant name to confirm: `));
      rl.close();
      if (answer.trim() !== tenantName) die('Not confirmed.');
    }
    try {
      const r = await engine.restoreBackup({
        tenant: tenantName, file, mode: asNew ? 'new' : 'replace', target: asNew,
        passphrase: flags.passphrase || process.env.LOOPAR_BACKUP_PASSPHRASE || undefined,
        onStep: (s) => process.stdout.write(gray(`${s}… `)),
      });
      log(green(`\n✓ Restored ${file} into ${r.tenant}`));
      if (r.safety) log(gray(`  previous state saved as ${r.safety}`));
      if (asNew) log(gray(`  ${asNew} is Off: yarn tenant on ${asNew}`));
      else log(gray(`  turn it on: yarn tenant on ${tenantName}`));
    } catch (e) {
      die(e.message);
    }
    return;
  }

  if (sub === 'delete') {
    need(tenantName);
    if (!file) die('Which backup?');
    const where = flags.local ? 'local' : flags.remote ? 'remote' : 'both';
    await engine.deleteBackup({ tenant: tenantName, file, where });
    log(green(`✓ Deleted ${file} (${where})`));
    return;
  }

  usage();
  process.exit(1);
}
