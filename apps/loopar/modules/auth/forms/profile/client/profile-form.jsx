
'use strict';

import { useDocument } from "@loopar/document";
import { FormLayout } from "@loopar/form";
import { loopar } from "loopar";
import fileManager from "@global/file-manager.js";
import { useEffect, useState } from "react";
import { Button } from "@cn/components/ui/button";
import { Input } from "@cn/components/ui/input";

const UserInfo = ({user}) => {
  const profile_picture = fileManager.getImage({image: user.profile_picture}, "image")

  return (
    <div className="flex flex-col items-center gap-3 pb-5 border-b border-border/40 mb-4 p-4">
      <div className="relative size-[150px] rounded-full bg-purple-200 flex items-center justify-center text-2xl font-medium text-purple-800">
        {loopar.utils.avatarLetter(user.name)} 
        <img src={profile_picture} className="absolute w-full h-full"/>
        {/* <div className="absolute bottom-0 right-0 w-5 h-5 rounded-full bg-background border border-border/60 flex items-center justify-center cursor-pointer">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </div> */}
      </div>
  
      <div className="text-center">
        <div className="text-sm font-medium">{user.name || 'User'}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{user.user_type || 'Web'}</div>
      </div>
  
      <div className="flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-full bg-teal-500" />
        <span className="text-xs text-teal-700">Active</span>
      </div>
    </div>
  )
}

/** Profile actions answer data payloads: keep the whole response, no toast on success. */
const profileCall = (action, body = {}) =>
  loopar.call("Profile", action, { body, followRedirect: false });

const RecoveryCodes = ({ codes, onDone }) => {
  const text = codes.join("\n");

  const download = () => {
    const blob = new Blob([`${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Save these recovery codes somewhere safe. Each one works <strong>once</strong> if you lose
        access to your authenticator app. They won't be shown again.
      </p>
      <div className="grid grid-cols-2 gap-2 rounded-md border p-3 font-mono text-sm">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => navigator.clipboard?.writeText(text)}>Copy</Button>
        <Button type="button" variant="outline" onClick={download}>Download</Button>
        <Button type="button" onClick={onDone}>I saved them</Button>
      </div>
    </div>
  );
};

/** Asks for a current code (or a recovery code) before a sensitive change. */
const FactorPrompt = ({ title, actionLabel, destructive, onSubmit, onCancel }) => {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(useRecovery ? { recovery_code: value.trim() } : { code: value.trim() });
    } catch (_e) {
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-md border p-4">
      <p className="text-sm font-medium">{title}</p>
      <Input
        value={value}
        onChange={(e) => setValue(useRecovery ? e.target.value : e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode={useRecovery ? "text" : "numeric"}
        autoComplete="one-time-code"
        placeholder={useRecovery ? "xxxxx-xxxxx" : "6-digit code"}
        className="font-mono max-w-xs"
        autoFocus
      />
      <button
        type="button"
        className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
        onClick={() => { setUseRecovery(!useRecovery); setValue(""); }}
      >
        {useRecovery ? "Use the authenticator app" : "Use a recovery code"}
      </button>
      <div className="flex gap-2">
        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={busy || !value.trim()}>
          {actionLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
};

/**
 * Two-factor authentication (authenticator app / TOTP).
 * idle → setup (QR + first code) → recovery codes → enabled.
 */
const MfaSettings = () => {
  const [status, setStatus] = useState(null); // { enabled, recovery_codes_left }
  const [setup, setSetup] = useState(null); // { qr, secret }
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState(null); // freshly generated recovery codes
  const [prompt, setPrompt] = useState(null); // 'disable' | 'regenerate'
  const [busy, setBusy] = useState(false);

  const load = () => profileCall("mfaStatus").then(setStatus).catch(() => {});
  useEffect(() => { load(); }, []);

  const start = async () => {
    setBusy(true);
    try {
      setSetup(await profileCall("mfaSetup"));
      setCode("");
    } catch (_e) { /* toast already shown */ } finally {
      setBusy(false);
    }
  };

  const enable = async (e) => {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    try {
      const r = await profileCall("mfaEnable", { code });
      setSetup(null);
      setCodes(r.recovery_codes || []);
    } catch (_e) {
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const disable = async (factor) => {
    await profileCall("mfaDisable", factor);
    setPrompt(null);
    load();
  };

  const regenerate = async (factor) => {
    const r = await profileCall("mfaRegenerateCodes", factor);
    setPrompt(null);
    setCodes(r.recovery_codes || []);
  };

  const done = () => { setCodes(null); load(); };

  if (!status) return null;

  return (
    <div className="flex flex-col gap-4 p-4 border-t border-border/40 mt-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">Two-factor authentication</h3>
          {status.enabled && !codes && (
            <span className="text-xs font-medium px-2 py-0.5 rounded bg-teal-100 text-teal-800">Enabled</span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Protect your account with a code from an authenticator app (Google Authenticator,
          Microsoft Authenticator, 1Password, Authy…) on top of your password.
        </p>
      </div>

      {codes ? (
        <RecoveryCodes codes={codes} onDone={done} />
      ) : setup ? (
        <form onSubmit={enable} className="flex flex-col gap-3">
          <p className="text-sm">1. Scan this QR code with your authenticator app.</p>
          <img src={setup.qr} alt="QR code for the authenticator app" width={220} height={220} className="rounded-md border bg-white p-2" />
          <p className="text-xs text-muted-foreground">
            Can't scan it? Enter this key manually:{" "}
            <code className="font-mono select-all break-all">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
          </p>
          <p className="text-sm">2. Enter the 6-digit code the app shows.</p>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            className="font-mono max-w-xs"
            autoFocus
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || code.length !== 6}>Verify and enable</Button>
            <Button type="button" variant="ghost" onClick={() => setSetup(null)}>Cancel</Button>
          </div>
        </form>
      ) : status.enabled ? (
        prompt ? (
          <FactorPrompt
            title={prompt === "disable"
              ? "Enter a current code to turn off two-factor authentication."
              : "Enter a current code to generate new recovery codes. The old ones stop working."}
            actionLabel={prompt === "disable" ? "Turn off" : "Generate new codes"}
            destructive={prompt === "disable"}
            onSubmit={prompt === "disable" ? disable : regenerate}
            onCancel={() => setPrompt(null)}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Recovery codes left: <strong>{status.recovery_codes_left}</strong>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setPrompt("regenerate")}>New recovery codes</Button>
              <Button type="button" variant="destructive" onClick={() => setPrompt("disable")}>Turn off</Button>
            </div>
          </div>
        )
      ) : (
        <div>
          <Button type="button" onClick={start} disabled={busy}>Turn on two-factor authentication</Button>
        </div>
      )}
    </div>
  );
};

export const config = { canUpdate: false, hasHeader: false };

export default function ProfileForm() {
  const { Document } = useDocument();
  const user = Document?.data || {};

  return (
    <FormLayout
      slots={{
        user_info: () => <UserInfo user={user} />,
        mfa: () => <MfaSettings />,
      }}
    />
  );
}
