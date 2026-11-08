'use strict';

import { useRef } from 'react';
import loopar from 'loopar';
import { FormLayout } from '@loopar/form';
import { useActions, useDocument } from '@loopar/document';
import { Button } from '@cn/components/ui/button';
import { KeyRound, UserX } from 'lucide-react';
import { __ } from "loopar";

const call = (action, name) => new Promise((resolve, reject) => {
  loopar.call('Customer Contact', action, { query: { name }, freeze: true, success: resolve, error: reject });
});

/** Customer Contact form — "Give portal access" / "Remove portal access". */
export default function CustomerContactForm() {
  const { Document = {} } = useDocument() || {};
  const ref = useRef(Document);
  ref.current = Document;
  const data = Document.data || {};

  const grant = async () => {
    const D = ref.current;
    const r = await call('grantPortal', D.name || D.data?.name);
    loopar.dialog({
      type: 'alert',
      title: 'Portal access',
      content: r?.password ? (
        <div className="space-y-2 text-sm">
          <p>{__("User:")} <b>{r.user}</b></p>
          <p>{__("Temporary password:")} <b className="font-mono text-base">{r.password}</b></p>
          <p className="text-muted-foreground">{__("Share it with the contact; they will be asked to change it. It won't be shown again.")}</p>
        </div>
      ) : <p className="text-sm">{__("The contact is linked to the Web user")} <b>{r?.user}</b>.</p>,
    });
  };

  const revoke = () => loopar.confirm(
    `Remove portal access for ${data.full_name || data.email}? Their user stays, but it will no longer see this contact's customers.`,
    async () => { const D = ref.current; await call('revokePortal', D.name || D.data?.name); },
  );

  useActions(Document.isNew ? {} : {
    crm_portal: data.user
      ? <Button key="revoke" variant="secondary" onClick={(e) => { e.preventDefault(); revoke(); }}><UserX className="w-4 h-4 mr-1" />{__("Remove portal access")}</Button>
      : <Button key="grant" variant="secondary" onClick={(e) => { e.preventDefault(); grant().catch(() => {}); }}><KeyRound className="w-4 h-4 mr-1" />{__("Give portal access")}</Button>,
  });

  return <FormLayout />;
}
