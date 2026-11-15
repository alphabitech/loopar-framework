#!/usr/bin/env node

/**
 * Core boot — the "generator". Starts only the server (HTTP + Vite + realtime
 * + per-request tenant resolution); no tenant is loaded until one is turned On.
 * Every tenant domain routes here via Caddy's catch-all.
 */
import "./check-node.js";
import { coreEnvVars } from "../core/config/core-config.js";

// process.env follows config/core.json (each value already falls back to the
// inherited env when the file doesn't set it). Always applied: a PM2 restart
// by name keeps the env of the first start, so a mode switched in core.json
// would boot with the old NODE_ENV.
for (const [k, v] of Object.entries(coreEnvVars())) {
  process.env[k] = String(v);
}

const { startCore } = await import("../index.js");
await startCore();
