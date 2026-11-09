import { useState, useEffect, useRef } from "react";
import loopar from "loopar";
import { __ } from "@global/i18n";
import { Button } from "@cn/components/ui/button";
import { Input } from "@cn/components/ui/input";

/**
 * Verified change of a `protected` field (write_policy, see
 * core/global/field-policy.js). The regular form shows the field read-only —
 * its save would drop the value anyway — and this dialog is the only way to
 * change it:
 *
 *   1. new value (twice for passwords) + the user's current password
 *      → POST Auth/reauthenticate        (+ 2FA code when the user has it on)
 *      or a fresh sign-in with the linked OAuth provider (popup, step-up
 *      mode: /auth/oauth?stepup=1) — accounts created with Google/GitHub
 *   2. → POST <Entity>/changeProtected  { field, value, confirm }
 *
 * The server checks everything again (permission, write_roles, a fresh
 * re-authentication); this is only the UI.
 */
function ProtectedChangeForm({ dialogId, entity, name, field, label, element, onDone }) {
  const isPassword = element === "password";
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  // "password" | "oauth": how the first factor was given.
  const [via, setVia] = useState("password");
  const [options, setOptions] = useState({ password: true, oauth: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const popupWatch = useRef(null);
  const messageHandler = useRef(null);

  // Password always; the linked OAuth provider too (accounts created with
  // Google/GitHub never had a password of their own).
  useEffect(() => {
    let alive = true;
    loopar.call("Auth", "stepUpOptions", { freeze: false })
      .then((o) => { if (alive && o) setOptions({ password: o.password !== false, oauth: o.oauth || [] }); })
      .catch(() => {});
    return () => {
      alive = false;
      clearInterval(popupWatch.current);
      if (messageHandler.current) window.removeEventListener("message", messageHandler.current);
    };
  }, []);

  const validateValue = () => {
    if (!String(value).trim()) return __("Enter the new value.");
    if (isPassword && value !== confirm) return __("The new values do not match.");
    return null;
  };

  const applyChange = async () => {
    const result = await loopar.call(entity, "changeProtected", {
      query: name ? { name } : {},
      body: { field, value, ...(isPassword ? { confirm } : {}) },
    });
    loopar.closeDialog(dialogId);
    onDone?.(result);
  };

  const factor = () => (code.includes("-") ? { recovery_code: code.trim() } : { code: code.trim() });

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    const invalid = validateValue();
    if (invalid) return setError(invalid);
    if (via === "password" && !password) return setError(__("Enter your current password."));
    if (needCode && !code.trim()) return setError(__("Enter the code from your authenticator app."));

    setBusy(true);
    try {
      const body = via === "oauth"
        ? { via: "oauth", ...factor() }
        : { password, ...(needCode ? factor() : {}) };
      const auth = await loopar.call("Auth", "reauthenticate", { body });
      if (auth?.mfa_required) {
        setNeedCode(true);
        return;
      }
      await applyChange();
    } catch (err) {
      // The transport already toasted it; keep it visible in the dialog too.
      setError(err?.message || __("The change could not be verified."));
    } finally {
      setBusy(false);
    }
  };

  /** Re-sign in with the provider in a popup (step-up mode: no new session). */
  const viaProvider = (provider) => {
    setError(null);
    const invalid = validateValue();
    if (invalid) return setError(invalid);

    const w = 500, h = 650;
    const left = Math.max(0, (window.screen.width - w) / 2 + (window.screenLeft || 0));
    const top = Math.max(0, (window.screen.height - h) / 2 + (window.screenTop || 0));
    const popup = window.open(
      `/auth/oauth?provider=${encodeURIComponent(provider)}&popup=1&stepup=1`,
      "loopar_oauth_stepup",
      `width=${w},height=${h},left=${left},top=${top}`
    );
    if (!popup) return setError(__("Allow pop-ups for this site to verify with your provider."));

    setBusy(true);
    const onMessage = async (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.type !== "loopar:oauth" || !data.stepup) return;
      window.removeEventListener("message", onMessage);
      clearInterval(popupWatch.current);

      if (!data.ok) {
        setBusy(false);
        return setError(data.reason === "identity_mismatch"
          ? __("That account is not the one linked to this user.")
          : __("The verification with your provider failed."));
      }
      setVia("oauth");
      if (data.mfa_required) {
        setNeedCode(true);
        setBusy(false);
        return;
      }
      try {
        await applyChange();
      } catch (err) {
        setError(err?.message || __("The change could not be verified."));
      } finally {
        setBusy(false);
      }
    };
    if (messageHandler.current) window.removeEventListener("message", messageHandler.current);
    messageHandler.current = onMessage;
    window.addEventListener("message", onMessage);

    // Closed by hand: no message will come.
    clearInterval(popupWatch.current);
    popupWatch.current = setInterval(() => {
      if (popup.closed) {
        clearInterval(popupWatch.current);
        setTimeout(() => {
          window.removeEventListener("message", onMessage);
          setBusy(false);
        }, 800);
      }
    }, 500);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 pt-2" autoComplete="off">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{__("New")} {label}</span>
        <Input
          type={isPassword ? "password" : (field === "email" ? "email" : "text")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete={isPassword ? "new-password" : "off"}
          autoFocus
          disabled={needCode}
        />
      </label>

      {isPassword && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{__("Confirm")} {label}</span>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" disabled={needCode} />
        </label>
      )}

      {via === "password" && !needCode && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{__("Your current password")}</span>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
      )}

      {needCode && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{__("Authenticator code (or a recovery code)")}</span>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            className="font-mono"
            autoFocus
          />
        </label>
      )}

      {!needCode && options.oauth.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />{__("or")}<span className="h-px flex-1 bg-border" />
          </div>
          {options.oauth.map((p) => (
            <Button key={p.provider} type="button" variant="outline" disabled={busy} onClick={() => viaProvider(p.provider)}>
              {__("Verify with")} {p.label}
            </Button>
          ))}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}

      <p className="text-xs text-muted-foreground">
        {field === "email"
          ? __("For your own account, a confirmation link is sent to the new address; the email changes when you open it.")
          : __("For your security we ask you to confirm your identity before changing this field.")}
      </p>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => loopar.closeDialog(dialogId)} disabled={busy}>
          {__("Cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? __("Verifying…") : __("Change")}
        </Button>
      </div>
    </form>
  );
}

export function openProtectedChange({ entity, name, field, label, element, onDone }) {
  const id = `protected-change-${entity}-${name || ""}-${field}`;
  loopar.dialog({
    id,
    title: `${__("Change")} ${label || field}`,
    hasFooter: false,
    size: "md",
    // A fresh key per opening: no state left from a previous attempt.
    content: (
      <ProtectedChangeForm
        key={Date.now()}
        dialogId={id}
        entity={entity}
        name={name}
        field={field}
        label={label || field}
        element={element}
        onDone={onDone ?? (() => loopar.refresh())}
      />
    ),
  });
}

/** The field (rendered read-only) with its "Change" button. */
export function ProtectedField({ children, entity, name, field, label, element }) {
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <Button
        type="button"
        variant="outline"
        className="h-10 shrink-0"
        onClick={() => openProtectedChange({ entity, name, field, label, element })}
      >
        {__("Change")}
      </Button>
    </div>
  );
}
