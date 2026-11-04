'use strict';

import { useState } from "react";
import { Button } from "@cn/components/ui/button";
import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import { debugCall, useDebugData, fmtDateTime, Pill, Panel, Empty, Code, CopyButton, Select, fieldClass } from "./shared.jsx";
import { cn } from "@cn/lib/utils";

const origin = () => (typeof window !== "undefined" ? window.location.origin : "");

/** Bearer tokens for agents/scripts + how to call the API. */
export function ApiPanel() {
  const tokens = useDebugData("tokens", {});
  const [form, setForm] = useState({ label: "", scope: "read", days: "30" });
  const [minted, setMinted] = useState(null);

  const create = async () => {
    try {
      const r = await debugCall("createToken", form);
      setMinted(r);
      setForm({ label: "", scope: "read", days: "30" });
      tokens.reload();
    } catch { /* toast shown */ }
  };

  const revoke = async (name) => {
    if (typeof window !== "undefined" && !window.confirm("Revoke this token? Anything using it stops working.")) return;
    try { await debugCall("revokeToken", { name }); tokens.reload(); } catch { /* toast shown */ }
  };

  const example = `curl -s ${origin()}/api/Debugger/manifest \\\n  -H "Authorization: Bearer ${minted?.token || "ldbg_…"}"`;
  const exampleRun = `curl -s -X POST "${origin()}/api/Debugger/runTests?suite=unit&wait=120" \\\n  -H "Authorization: Bearer ${minted?.token || "ldbg_…"}"`;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="New token">
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            A debug token lets an agent or a script read this Debugger over <code>/api/Debugger/*</code> without a browser session.
            It works only on these endpoints, for this tenant. <strong>read</strong>: requests, SQL, logs, errors, status, test results.
            <strong> run</strong>: also starts and stops test runs.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input className={cn(fieldClass, "w-56")} placeholder="Label (e.g. Claude, CI)" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            <Select value={form.scope} onChange={(v) => setForm((f) => ({ ...f, scope: v }))} options={[{ value: "read", label: "read" }, { value: "run", label: "run" }]} />
            <Select value={form.days} onChange={(v) => setForm((f) => ({ ...f, days: v }))} options={[{ value: "1", label: "1 day" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "0", label: "never expires" }]} />
            <Button size="sm" disabled={!form.label.trim()} onClick={create}><KeyRoundIcon className="mr-1 h-3.5 w-3.5" />Create</Button>
          </div>
          {minted && (
            <div className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
              <div className="text-xs font-semibold">Copy it now — it won't be shown again.</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">{minted.token}</code>
                <CopyButton text={minted.token} />
              </div>
            </div>
          )}
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-muted-foreground"><span>Start here</span><CopyButton text={example.replace(/\\\n\s+/g, "")} /></div>
            <Code>{example}</Code>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-muted-foreground"><span>Run unit tests and wait for the result (run scope)</span><CopyButton text={exampleRun.replace(/\\\n\s+/g, "")} /></div>
            <Code>{exampleRun}</Code>
          </div>
          <p className="text-xs text-muted-foreground">
            Every response carries <code>X-Loopar-Debug: &lt;id&gt;</code>: call any endpoint of the app, then <code>GET /api/Debugger/request?id=&lt;id&gt;</code> for its SQL, logs and errors.
          </p>
        </div>
      </Panel>

      <Panel title={`Tokens · ${tokens.data?.tokens?.length ?? 0}`} bodyClassName="p-0">
        {!tokens.data?.tokens?.length ? <Empty>No tokens yet.</Empty> : (
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border"><th className="px-3 py-2 font-medium">Label</th><th className="px-2 py-2 font-medium">Scope</th><th className="px-2 py-2 font-medium">Expires</th><th className="px-2 py-2 font-medium">Last used</th><th className="px-2 py-2" /></tr>
            </thead>
            <tbody>
              {tokens.data.tokens.map((t) => (
                <tr key={t.name} className="border-b border-border/60">
                  <td className="px-3 py-1.5">
                    <div className="font-medium">{t.label}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{t.token_hint}</div>
                  </td>
                  <td className="px-2 py-1.5"><Pill tone={t.scope === "run" ? "warning" : "info"}>{t.scope}</Pill></td>
                  <td className="px-2 py-1.5">
                    {t.disabled ? <Pill>disabled</Pill> : t.expired ? <Pill tone="danger">expired</Pill> : (t.expires_at ? fmtDateTime(t.expires_at) : "never")}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{t.last_used_at ? `${fmtDateTime(t.last_used_at)}${t.last_used_ip ? ` · ${t.last_used_ip}` : ""}` : "never"}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button type="button" title="Revoke" className="rounded p-1 text-red-600 hover:bg-red-500/10" onClick={() => revoke(t.name)}><Trash2Icon className="h-3.5 w-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
