/**
 * Ask the running core to do something (pm2 process messages) — see
 * packages/loopar/core/backup/ipc.js for the other end. Uses its own pm2
 * client so connecting/disconnecting here never drops the Logs tab's bus.
 */
import "loopar/bin/pm2-home.js";
import pm2 from "pm2";
import { CORE_PROCESS_NAME, projectName } from "loopar/bin/pm2.js";

const TOPIC = "loopar:backup";

function client() {
  return new pm2.custom({ pm2_home: process.env.PM2_HOME });
}
const call = (c, fn, ...args) => new Promise((res, rej) => c[fn](...args, (e, r) => (e ? rej(e) : res(r))));

/**
 * One request → one reply. Rejects when the core is not online, doesn't
 * answer in `timeoutMs` (an older core without the handler), or replies ok:false.
 */
export async function askCore(op, data = {}, { timeoutMs = 8000 } = {}) {
  const c = client();
  await call(c, "connect");
  let bus = null;
  try {
    const procs = await call(c, "describe", CORE_PROCESS_NAME);
    const proc = (procs || []).find((p) => p.pm2_env?.status === "online" && (!p.pm2_env?.namespace || p.pm2_env.namespace === projectName))
      || (procs || []).find((p) => p.pm2_env?.status === "online");
    if (!proc) throw Object.assign(new Error("the server is not running"), { code: "CORE_DOWN" });

    bus = await call(c, "launchBus");
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("the server did not answer (restart it to load the new code)"), { code: "CORE_TIMEOUT" })), timeoutMs);
      bus.on("process:msg", (p) => {
        // pm2 forwards only the reply's `data` (the topic rides inside it).
        const d = p?.data;
        if (d?.topic !== `${TOPIC}:reply` || d.id !== id) return;
        clearTimeout(timer);
        resolve(d);
      });
    });
    await call(c, "sendDataToProcessId", proc.pm_id, { type: "process:msg", topic: TOPIC, data: { id, op, ...data } });
    const d = await reply;
    if (!d.ok) throw new Error(d.error || "the server refused");
    return d;
  } finally {
    try { bus?.close?.(); } catch { /* gone */ }
    try { c.disconnect(); } catch { /* gone */ }
  }
}

/** Start a restore in the core and follow its job until it finishes. */
export async function restoreInCore({ tenant, file, passphrase, onStep = () => {} }) {
  await askCore("restore", { tenant, file, passphrase });
  for (;;) {
    await new Promise((r) => setTimeout(r, 600));
    const { job } = await askCore("job", { tenant });
    if (!job) throw new Error("the server lost track of the restore");
    onStep(job.step);
    if (job.finishedAt) {
      if (!job.ok) throw new Error(job.error || "restore failed");
      return job.result || {};
    }
  }
}
