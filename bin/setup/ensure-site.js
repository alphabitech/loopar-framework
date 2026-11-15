import { existsSync } from 'fs';
import path from 'path';
import { tenant } from "loopar/bin/tenant/tenant-builder.js";
import { coreEnv, setCoreConfig } from "loopar/core/config/core-config.js";

const ROOT = process.cwd();
const DEV_CONFIG = path.join(ROOT, 'sites', 'dev', 'config.json');
const CORE_CONFIG = path.join(ROOT, 'config', 'core.json');

/**
 * First boot: keep the port the project was installed with. The installer
 * (or the shell) passes it as PORT; without config/core.json it would only
 * last for that one session and every later start would fall back to 3000.
 */
function ensureCorePort() {
  if (existsSync(CORE_CONFIG)) return;
  const port = Number.parseInt(process.env.PORT, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  setCoreConfig({ port });
  console.log(`✅ Core port ${port} saved to config/core.json\n`);
}

async function ensureDevSite() {
  // Already provisioned (config.json, not just the folder) — nothing to do.
  if (existsSync(DEV_CONFIG)) return;
  // A production server never gets a `dev` tenant on its own: it would sit
  // there turned on and not installed.
  if (coreEnv() === 'production') return;

  console.log('⚠️  Creating dev site...\n');

  // Local dev bootstrap: create `dev` active so the Desk is reachable on a
  // fresh install. (Other tenants default OFF — cloud-coherent.) When no
  // tenant runs the control plane yet, `dev` takes it, so the Tenant Manager
  // works in the Desk from the first sign-in.
  const firstOperator = tenant.controlPlaneTenants().length === 0;
  await tenant.saveTenant({
    NAME: 'dev',
    DOMAIN: 'dev.localhost',
    STATUS: 'active',
    ...(firstOperator ? { controlPlane: true } : {}),
  });

  console.log('✅ Dev site created: sites/dev/config.json\n');
}

try {
  ensureCorePort();
  await ensureDevSite();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
