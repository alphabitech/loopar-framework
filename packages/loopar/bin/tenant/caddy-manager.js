'use strict';

import fs from "fs";
import path from "pathe";
import os from "os";
import { exec } from 'child_process';
import { promisify } from 'util';
import { coreEnv } from 'loopar/core/config/core-config.js';

const execAsync = promisify(exec);

/**
 * CaddyManager — reverse proxy manager.
 *
 * Port strategy:
 *   PRODUCTION (coreEnv() === 'production'): :80/:443 or fail loudly. Never a
 *     silent fallback — a dev-mode Caddy (high port, HTTPS off) plus an OS
 *     :80→port redirect left the public site unreachable (Cloudflare 521)
 *     while everything looked "up" locally. See #assertProductionPort80.
 *   DEVELOPMENT: try :80, else first free port from 12000 + OS-level
 *     :80→port redirect so domains work without a port in the URL.
 *
 * Config writes ALL go through _writeFullConfig() (single atomic POST /config/).
 * Partial Caddy API endpoints (POST/DELETE /routes) hot-reload and can resurrect
 * ghost :80/:443 servers from prior Homebrew/system starts → EADDRINUSE.
 */
export default class CaddyManager {
  constructor() {
    this.isProductionEnv = coreEnv() === 'production';
    this.adminUrl = 'http://localhost:2019';
    this.httpPort = 80;
    // PM2/launchd resurrect the core with a minimal PATH (no /opt/homebrew/bin,
    // no /usr/local/bin), so `caddy`/`brew` as bare names fail exactly in the
    // reboot scenario this class exists for. Resolve absolute paths up front.
    this.caddyBin = this.#resolveBin('caddy');
    this.brewBin = this.#resolveBin('brew');
  }

  #resolveBin(name) {
    const candidates = [
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return name; // fall back to PATH lookup
  }

  async ensureReady() {
    if (!await this.ensureInstalled()) {
      const installed = await this.install();
      if (!installed) throw new Error("Could not install Caddy.");
    }

    // If Caddy is already running, do NOT restart: a stop/start drops in-flight
    // connections — including the request that triggered this when the Desk is
    // served through Caddy. Route changes use the admin API; no restart needed.
    // Adopt the running instance's port so _writeFullConfig preserves it.
    if (await this.isRunning()) {
      let listens = [];
      try {
        const res = await fetch(`${this.adminUrl}/config/apps/http/servers/srv0`);
        if (res.ok) {
          const srv = await res.json();
          listens = Array.isArray(srv?.listen) ? srv.listen : [];
          const m = String(listens[0] || '').match(/:(\d+)$/);
          if (m) this.httpPort = Number(m[1]);
        }
      } catch (_) { /* keep default port */ }

      // In production, a running Caddy on a dev port (left by an earlier
      // fallback) must not be adopted: _writeFullConfig would keep it on that
      // port with HTTPS off. Restart it in production mode instead. An empty
      // Caddy (no srv0 yet) is fine — the next full config write puts it on :80.
      const onDevPort = listens.length && !listens.some(l => /:80$/.test(String(l)));
      if (!(this.isProductionEnv && onDevPort)) {
        if (this.isProductionEnv) await this.#clearStaleRedirects();
        return true;
      }

      console.warn(`⚠️  Caddy is running on ${listens.join(', ')} (dev mode) in production — restarting it on :80/:443.`);
      const routes = await this._readCurrentRoutes();
      await this._stopCaddy();
      this.httpPort = await this.findAvailablePort();
      await this.#clearStaleRedirects();
      if (!await this._startCaddy(this.httpPort, routes)) throw new Error("Failed to restart Caddy in production mode.");
      return true;
    }

    this.httpPort = await this.findAvailablePort();
    if (this.isProductionEnv) await this.#clearStaleRedirects();
    const started = await this._startCaddy(this.httpPort, []);
    if (!started) throw new Error("Failed to start Caddy.");

    // If couldn't get :80, set up OS redirect so domains work without port
    if (this.httpPort !== 80) {
      await this._ensurePort80Redirect(this.httpPort);
    }

    return true;
  }

  async isRunning() {
    try {
      const res = await fetch(`${this.adminUrl}/config/`, {
        signal: AbortSignal.timeout(3000)
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  async ensureInstalled() {
    try { await execAsync(`${this.caddyBin} version`); return true; }
    catch (_) { return false; }
  }

  async install() {
    try {
      const platform = os.platform();
      if (platform === 'darwin') {
        await execAsync(`${this.brewBin} install caddy`);
        // brew may auto-start Caddy as a service — stop it so Loopar manages it
        try { await execAsync(`${this.brewBin} services stop caddy`); } catch (_) {}
      } else if (platform === 'linux') {
        await execAsync('sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl');
        await execAsync('curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg');
        await execAsync('curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list');
        await execAsync('sudo apt update && sudo apt install -y caddy');
        // apt auto-starts caddy.service (stock Caddyfile, no admin API) which
        // competes with Loopar's CaddyManager. Disable so only Loopar's runs.
        try { await execAsync('sudo systemctl stop caddy');    } catch (_) {}
        try { await execAsync('sudo systemctl disable caddy'); } catch (_) {}
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
      console.log("✅ Caddy installed (and detached from system service manager so Loopar can manage it)");
      return true;
    } catch (e) {
      console.error("Failed to install Caddy:", e);
      return false;
    }
  }

  /**
   * Single execution model: ONE host process serves every tenant. Install one
   * route matching ALL tenant domains → the host port (not one route/port each).
   *
   * @param {number}   hostPort  The single host process's HTTP port.
   * @param {string[]} domains   Every tenant domain to route to the host.
   */
  async registerHostCatchAll(hostPort, domains = []) {
    try {
      const hosts = [...new Set(domains.filter(Boolean))];
      if (!hosts.length) return true;

      const route = {
        "@id": "loopar_host",
        match: [{ host: hosts }],
        handle: [{
          handler: "reverse_proxy",
          upstreams: [{ dial: `localhost:${hostPort}` }],
          headers: {
            request: {
              set: {
                "X-Forwarded-Proto": ["{http.request.scheme}"],
                "X-Forwarded-Host": ["{http.request.host}"],
                "X-Forwarded-Port": ["{http.request.port}"],
                "X-Real-IP": ["{http.request.remote.host}"],
              },
            },
          },
        }],
      };

      const external = (await this._readCurrentRoutes())
        .filter(r => r?.["@id"] && !String(r["@id"]).startsWith("loopar_"));
      const ok = await this._writeFullConfig([...external, route]);
      if (ok) console.log(`✅ Caddy host route: [${hosts.join(", ")}] → localhost:${hostPort}`);
      return ok;
    } catch (e) {
      console.error("Failed to register host catch-all:", e);
      return false;
    }
  }

  /**
   * Port selection: try :80 (production); fall back to 12000+ when :80 is taken
   * (dev). :443 is skipped — Caddy handles SSL internally.
   */
  async findAvailablePort() {
    const net = await import('net');

    // Resolves null when the port can be bound, else the error code
    // (EADDRINUSE: another process has it; EACCES: no permission for <1024).
    const probe = (port) => new Promise((resolve) => {
      const server = net.default.createServer();
      server.once('error', (err) => resolve(err?.code || 'EUNKNOWN'));
      server.once('listening', () => server.close(() => resolve(null)));
      server.listen(port, '0.0.0.0');
    });
    const isPortFree = async (port) => (await probe(port)) === null;

    const err80 = await probe(80);
    if (!err80) {
      console.log("✅ Port 80 available — production mode");
      return 80;
    }

    if (this.isProductionEnv) this.#failProductionPort80(err80);

    console.log(`⚠️  Port 80 not usable (${err80}) — falling back to dev port (12000+)`);

    // Dev fallback: find first free port from 12000
    for (let port = 12000; port < 12100; port++) {
      if (await isPortFree(port)) return port;
    }

    throw new Error("No available port found (tried :80 and 12000–12099)");
  }

  /**
   * Production never falls back: explain exactly why :80 failed and how to
   * fix it, and stop. Serving on a dev port would look healthy locally while
   * the public site is down.
   */
  #failProductionPort80(code) {
    const user = os.userInfo().username;
    const fixes = {
      EACCES: [
        `User "${user}" is not allowed to bind ports below 1024.`,
        `Fix (persistent):`,
        `  echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-loopar-ports.conf`,
        `  sudo sysctl --system`,
      ],
      EADDRINUSE: [
        `Another process already listens on :80.`,
        `Find it:  sudo ss -ltnp 'sport = :80'`,
        `(a system caddy/nginx/apache service is the usual culprit: sudo systemctl disable --now <service>)`,
      ],
    }[code] || [`Unexpected error binding :80 (${code}).`];

    const message = [
      `Cannot bind :80 in production (${code}). Refusing to fall back to a dev port:`,
      `the public site would be unreachable while Caddy looks healthy.`,
      ...fixes,
    ].join('\n');

    console.error(`❌ ${message}`);
    throw new Error(message);
  }

  /**
   * Remove :80 → high-port redirects that a past dev fallback installed
   * (_ensureIptablesRedirect). In production they send public :80 traffic to
   * a port nothing listens on. Best-effort: sudo -n never prompts; when it
   * can't run, print the exact commands instead.
   */
  async #clearStaleRedirects() {
    if (os.platform() !== 'linux') return;

    let rules = [];
    try {
      const { stdout } = await execAsync('sudo -n iptables -t nat -S');
      rules = stdout.split('\n')
        .filter(r => /^-A (PREROUTING|OUTPUT) .*--dport 80 .*-j REDIRECT --to-ports? 1[0-9]{4}\b/.test(r));
    } catch (_) {
      return; // can't inspect without a sudo prompt — nothing safe to do here
    }

    for (const rule of rules) {
      const del = rule.replace(/^-A /, '-D ');
      try {
        await execAsync(`sudo -n iptables -t nat ${del}`);
        console.warn(`🧹 Removed stale dev redirect: iptables -t nat ${rule}`);
      } catch (e) {
        console.error(`❌ Stale :80 redirect is sending public traffic to a dev port. Remove it:\n   sudo iptables -t nat ${del}`);
      }
    }
  }

  /**
   * When Caddy can't bind :80 (dev), set up an OS redirect :80 → actualPort so
   * domains work without a port. macOS: pfctl, Linux: iptables (both need sudo).
   *
   * Avoid sudo prompts with a one-time sudoers rule:
   *   macOS: echo "$(whoami) ALL=(ALL) NOPASSWD: /sbin/pfctl" | sudo tee /etc/sudoers.d/loopar-pfctl
   *   Linux: echo "$(whoami) ALL=(ALL) NOPASSWD: /sbin/iptables" | sudo tee /etc/sudoers.d/loopar-iptables
   */
  async _ensurePort80Redirect(targetPort) {
    if (this.isProductionEnv) return; // never rewire :80 on a production host
    const platform = os.platform();

    try {
      if (platform === 'darwin') {
        await this._ensurePfctlRedirect(targetPort);
      } else if (platform === 'linux') {
        await this._ensureIptablesRedirect(targetPort);
      }
    } catch (e) {
      // Non-fatal: domains will still work with the port appended
      console.warn(`⚠️  Could not set :80 redirect: ${e.message}`);
      console.warn(`   Domains accessible at: http://yourdomain:${targetPort}`);
      console.warn(`   To fix, run once:`);
      if (platform === 'darwin') {
        console.warn(`   echo "$(whoami) ALL=(ALL) NOPASSWD: /sbin/pfctl" | sudo tee /etc/sudoers.d/loopar-pfctl`);
      } else {
        console.warn(`   echo "$(whoami) ALL=(ALL) NOPASSWD: /sbin/iptables" | sudo tee /etc/sudoers.d/loopar-iptables`);
      }
    }
  }

  async _ensurePfctlRedirect(targetPort) {
    try {
      const { stdout } = await execAsync('sudo pfctl -s nat 2>/dev/null');
      if (stdout.includes(`-> 127.0.0.1 port ${targetPort}`)) {
        console.log(`✅ :80 → :${targetPort} redirect already active (pfctl)`);
        return;
      }
    } catch (_) {}

    const ruleFile = path.join(os.tmpdir(), 'loopar-pf.conf');
    fs.writeFileSync(ruleFile,
      `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${targetPort}\n`
    );

    await execAsync(`sudo pfctl -ef ${ruleFile}`);
    console.log(`✅ :80 → :${targetPort} redirect active (pfctl) — domains work without port`);
  }

  async _ensureIptablesRedirect(targetPort) {
    try {
      const { stdout } = await execAsync('sudo iptables -t nat -L OUTPUT --line-numbers -n 2>/dev/null');
      if (stdout.includes(`redir ports ${targetPort}`)) {
        console.log(`✅ :80 → :${targetPort} redirect already active (iptables)`);
        return;
      }
    } catch (_) {}

    await execAsync(`sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port ${targetPort}`);
    await execAsync(`sudo iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport 80 -j REDIRECT --to-port ${targetPort}`);
    console.log(`✅ :80 → :${targetPort} redirect active (iptables) — domains work without port`);
  }

  async _stopCaddy() {
    try { await execAsync(`${this.caddyBin} stop`); } catch (_) {}
    if (os.platform() === 'linux') {
      // sudo -n = non-interactive: fail rather than hang forever waiting for a
      // password on a tty nobody watches.
      try { await execAsync('sudo -n systemctl stop caddy'); } catch (_) {}
      try { await execAsync('sudo -n pkill -9 -f "caddy run"'); } catch (_) {}
    } else {
      // macOS: no systemctl; user-owned caddy doesn't need sudo to kill.
      try { await execAsync(`${this.brewBin} services stop caddy`); } catch (_) {}
      try { await execAsync('pkill -9 -f "caddy run"'); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  async _startCaddy(port, initialRoutes = []) {
    const configPath = this._getConfigPath();
    this._writeConfigFile(configPath, port, initialRoutes);

    exec(`${this.caddyBin} start --config ${configPath}`, (error) => {
      if (error && !error.message.includes('already running')) {
        console.error("Caddy start error:", error.message);
      }
    }).unref();

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await this.isRunning()) {
        this.httpPort = port;
        console.log(`✅ Caddy running on :${port}`);
        return true;
      }
    }

    console.error("❌ Caddy failed to start");
    return false;
  }

  async _readCurrentRoutes() {
    try {
      const res = await fetch(`${this.adminUrl}/config/apps/http/servers/srv0/routes`);
      if (!res.ok) return [];
      const parsed = await res.json();
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  async _writeFullConfig(routes) {
    const config = this._buildConfig(this.httpPort, routes);

    const res = await fetch(`${this.adminUrl}/config/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!res.ok) {
      console.error(`❌ Caddy config write failed [${res.status}]:`, await res.text());
      return false;
    }

    // Persist live config to disk so a Caddy restart (reboot, SIGTERM, OOM)
    // reloads current routes. Otherwise the disk file only reflects the last
    // _startCaddy() snapshot and admin-API route changes (registerHostCatchAll)
    // would be lost. Best-effort: the API write already succeeded.
    try {
      const configPath = this._getConfigPath();
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
      console.warn(`⚠️  Caddy config persisted in memory but not to disk: ${e.message}`);
    }

    return true;
  }

  _writeConfigFile(filePath, port, routes = []) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this._buildConfig(port, routes), null, 2));
  }

  /**
   * Single source of truth for the Caddy config object. Two modes by httpPort:
   *
   *   port === 80 (PRODUCTION): listen :80 + :443, automatic_https at defaults —
   *     real domains get Let's Encrypt certs (stored ~/.local/share/caddy/),
   *     .localhost/.home/.lan get internal-CA self-signed (browser warns),
   *     HTTP auto-redirects to HTTPS.
   *
   *   port !== 80 (DEV FALLBACK): on a high port because :80 was taken. Disable
   *     automatic_https entirely so it won't bind :443, append :12000 to
   *     redirects, or provision certs for domains that may not resolve here.
   *
   * Optional CADDY_ACME_EMAIL enables Let's Encrypt renewal/expiry notices;
   * without it ACME registration is anonymous.
   */
  _buildConfig(port, routes) {
    const isProduction = port === 80;

    const srv0 = {
      listen: isProduction ? [":80", ":443"] : [`:${port}`],
      routes
    };

    if (!isProduction) {
      srv0.automatic_https = { disable: true };
    }

    const config = {
      admin: { listen: "localhost:2019" },
      apps: {
        http: {
          servers: { srv0 }
        }
      }
    };

    if (isProduction && process.env.CADDY_ACME_EMAIL) {
      config.apps.tls = {
        automation: {
          policies: [{
            issuers: [{ module: "acme", email: process.env.CADDY_ACME_EMAIL }]
          }]
        }
      };
    }

    return config;
  }

  _getConfigPath() {
    const candidates = [
      '/etc/caddy/config.json',
      '/usr/local/etc/caddy/config.json',
      '/opt/homebrew/etc/caddy/config.json',
      path.join(process.cwd(), 'caddy-config.json')
    ];

    for (const p of candidates) {
      if (fs.existsSync(p) && this.#isWritable(p)) return p;
    }
    const dir = os.platform() === 'darwin' ? '/opt/homebrew/etc/caddy' : '/etc/caddy';
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return path.join(dir, 'config.json');
    } catch (_) {
      return path.join(process.cwd(), 'caddy-config.json');
    }
  }

  #isWritable(p) {
    try { fs.accessSync(p, fs.constants.W_OK); return true; }
    catch (_) { return false; }
  }
}