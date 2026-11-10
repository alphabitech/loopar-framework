'use strict';

import { BareLayout } from '@loopar/form';
import { loopar } from 'loopar';
import { useEffect, useState } from "react";
import { ArrowRight, ArrowLeft } from "lucide-react";
import { SystemHeader } from "@workspace/system/system-shell";
import { useWorkspace } from '@workspace/workspace-provider';
import {Link} from "@link"
import { __ } from "loopar";

const TokenError = ({ type }) => {
  const isExpired = type === "expired";

  return (
    <div className="flex flex-col gap-4">
      <SystemHeader
        title={isExpired ? __("This link has expired") : __("We couldn't verify this link")}
        description={isExpired
          ? __("Password reset links expire after 30 minutes. Request a new one and use it right away.")
          : __("It may have been used already or be incomplete. Request a new one to recover your account.")}
      />
      <Link
        variant="primary"
        className="w-full gap-1 justify-center"
        to="/auth/recoveryPasswordRequest"
        notControlled
      >
        {__("Request a new link")} <ArrowRight size={14} />
      </Link>
      <Link
        className="w-full gap-1 justify-center text-muted-foreground"
        variant="ghost"
        to="/auth/login"
        notControlled
      >
        <ArrowLeft size={14} /> {__("Back to login")}
      </Link>
    </div>
  );
};

const ResetPassword = ({ children }) => {
  const [status, setStatus] = useState("loading"); // loading | valid | expired | invalid
  const {navigate} = useWorkspace()

  useEffect(() => {
    const checkToken = async () => {
      const token = new URLSearchParams(window.location.search).get("token");

      if (!token) {
        window.location.href = "/auth/recoveryPasswordRequest";
        return;
      }

      const res = await loopar.call("Auth", "validateResetToken", { query: { token } });

      setStatus(res.valid ? "valid" : res.reason);
    };

    checkToken();
  }, []);

  if (status === "loading") return null;
  if (status === "expired") return <TokenError type="expired" />;
  if (status === "invalid") return <TokenError type="invalid" />;

  return children;
};

/**
 * The reset token travels in the URL; expose it as form data so the hidden
 * `token` field is submitted with the new password.
 */
export const config = {
  mapDocument: (Document) => {
    const token = new URLSearchParams(global?.location?.search).get("token");
    return { ...Document, data: { ...Document?.data, token } };
  },
};

export default function ResetPasswordForm() {

  return (
    <ResetPassword>
      <SystemHeader
        title={__("Choose a new password")}
        description={__("Enter it twice to confirm. You'll use it to sign in from now on.")}
      />
      <BareLayout />
    </ResetPassword>
  );
}
