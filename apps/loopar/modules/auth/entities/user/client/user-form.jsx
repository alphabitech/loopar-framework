'use strict';

import { useState } from 'react';
import { useDocument } from '@loopar/document';
import { FormLayout } from '@loopar/form';
import { loopar } from 'loopar';
import { Button } from '@cn/components/ui/button';
import { RolePermissionManager } from '../../../pages/role-permission-manager/client/src/role-permission-manager';

/** Admin escape hatch for a user who lost the phone and the recovery codes. */
function MfaNotice({ name, enabled }) {
  const [on, setOn] = useState(!!Number(enabled));
  if (!on) return null;

  const reset = () => loopar.confirm(
    `Turn off two-factor authentication for ${name}? They will sign in with the password only until they turn it on again.`,
    () => loopar
      .call('User', 'resetMfa', { query: { name }, followRedirect: false })
      .then(() => setOn(false))
      .catch(() => {}),
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-4 py-3 m-4 text-sm">
      <span>This user has two-factor authentication turned on.</span>
      <Button type="button" variant="outline" size="sm" onClick={reset}>Reset 2FA</Button>
    </div>
  );
}

export default function UserForm() {
  const { Document } = useDocument();

  return (
    <>
      <MfaNotice name={Document.name} enabled={Document?.data?.mfa_enabled} />
      <FormLayout
        slots={{
          user_roles: () => <RolePermissionManager manager="user" user={Document.name} />,
        }}
      />
    </>
  );
}
