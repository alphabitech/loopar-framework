'use strict';

import { useForm, FormLayout } from '@loopar/form';
import { useDocument } from '@loopar/document';
import { loopar } from 'loopar';
import { Button } from '@cn/components/ui/button';
import { Ban, Copy, ExternalLink, Send } from 'lucide-react';

/** The exact document sent to the signer, as stored (sandboxed: no scripts, no navigation). */
function Preview() {
  const { getValue } = useForm();
  const { Document } = useDocument();
  // Hidden field: not always registered in the form, the record data has it.
  const html = getValue('content_html') || Document?.data?.content_html;
  if (!html) return <p className="text-sm text-muted-foreground">No document.</p>;
  return (
    <iframe
      title="Document"
      sandbox=""
      srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.6 system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>${html}`}
      className="h-[70vh] w-full rounded-md border bg-white"
    />
  );
}

const SLOTS = { preview: Preview };

function LinkDialog({ url, emailed }) {
  const copy = () => navigator.clipboard?.writeText(url).then(() => loopar.notify('Link copied.'));
  return (
    <div className="space-y-3 text-left">
      <p className="text-sm">
        {emailed ? 'A new link was emailed to the signer.' : 'The email could not be sent; share this link with the signer.'}
        {' '}The previous link no longer works.
      </p>
      <div className="flex gap-2">
        <input readOnly value={url} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs" onFocus={(e) => e.target.select()} />
        <Button type="button" variant="secondary" size="sm" onClick={copy}><Copy className="size-4" /></Button>
      </div>
    </div>
  );
}

export default function SignatureRequestForm() {
  const { getValue } = useForm();
  const name = getValue('name');
  const status = getValue('status');
  const source = getValue('document') && getValue('document_name');

  const resend = (e) => {
    e.preventDefault();
    loopar.confirm('Send a new signing link? The current link will stop working.', () =>
      loopar.call('Signature Request', 'resend', {
        query: { name },
        success: (r) => {
          loopar.dialog({ type: 'alert', title: 'New signing link', content: <LinkDialog url={r.url} emailed={r.emailed} /> });
          loopar.refresh();
        },
      }));
  };

  const revoke = (e) => {
    e.preventDefault();
    loopar.confirm('Revoke this request? The signer will no longer be able to sign it.', () =>
      loopar.call('Signature Request', 'revoke', { query: { name }, success: () => loopar.refresh() }));
  };

  const open = (e) => {
    e.preventDefault();
    loopar.navigate(`/desk/${getValue('document')}/update?name=${encodeURIComponent(getValue('document_name'))}`);
  };

  const actions = {};
  if (source) actions.source = <Button variant="link" onClick={open}><ExternalLink className="mr-2 size-4" /> Open {getValue('document')}</Button>;
  if (status === 'Pending' || status === 'Expired') {
    actions.resend = <Button variant="secondary" onClick={resend}><Send className="mr-2 size-4" /> Send new link</Button>;
  }
  if (status === 'Pending') actions.revoke = <Button variant="destructive" onClick={revoke}><Ban className="mr-2 size-4" /> Revoke</Button>;

  return <FormLayout slots={SLOTS} actions={name ? actions : {}} />;
}
