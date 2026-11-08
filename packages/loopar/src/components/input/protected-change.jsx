import { useState } from "react";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (!String(value).trim()) return setError(__("Enter the new value."));
    if (isPassword && value !== confirm) return setError(__("The new values do not match."));
    if (!password) return setError(__("Enter your current password."));
    if (needCode && !code.trim()) return setError(__("Enter the code from your authenticator app."));

    setBusy(true);
    try {
      const auth = await loopar.call("Auth", "reauthenticate", {
        body: { password, ...(needCode ? (code.includes("-") ? { recovery_code: code.trim() } : { code: code.trim() }) : {}) },
      });
      if (auth?.mfa_required) {
        setNeedCode(true);
        return;
      }

      const result = await loopar.call(entity, "changeProtected", {
        query: name ? { name } : {},
        body: { field, value, ...(isPassword ? { confirm } : {}) },
      });

      loopar.closeDialog(dialogId);
      onDone?.(result);
    } catch (err) {
      // The transport already toasted it; keep it visible in the dialog too.
      setError(err?.message || __("The change could not be verified."));
    } finally {
      setBusy(false);
    }
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
        />
      </label>

      {isPassword && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{__("Confirm")} {label}</span>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{__("Your current password")}</span>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>

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

      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}

      <p className="text-xs text-muted-foreground">
        {field === "email"
          ? __("For your own account, a confirmation link is sent to the new address; the email changes when you open it.")
          : __("For your security we ask for your password before changing this field.")}
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
