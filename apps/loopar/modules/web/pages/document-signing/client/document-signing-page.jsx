'use strict';

import { useEffect, useState } from 'react';
import { loopar } from 'loopar';
import { Button } from '@cn/components/ui/button';
import { Input } from '@cn/components/ui/input';
import { Textarea } from '@cn/components/ui/textarea';
import { cn } from '@cn/lib/utils';
import { CheckCircle2, FileSignature, Loader2, Printer, ShieldCheck, XCircle } from 'lucide-react';

/** Web page: always opens at the top, never restores the scroll position. */
export const config = { restoreScroll: false };

const CONSENT = 'I agree to sign this document electronically. My typed name is my signature and has the same effect as a handwritten one, and I agree to receive this document and related records electronically.';

const call = (action, body) => new Promise((resolve, reject) => {
  loopar.call('Signature Request', action, { body, freeze: false, success: resolve, error: reject });
});

const tokenFromUrl = () => new URLSearchParams(window.location.search).get('token') || '';

function Status({ request }) {
  const map = {
    Signed: ['bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300', 'Signed'],
    Pending: ['bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', 'Awaiting your signature'],
    Declined: ['bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', 'Declined'],
    Expired: ['bg-muted text-muted-foreground', 'Link expired'],
    Revoked: ['bg-muted text-muted-foreground', 'Withdrawn by the sender'],
  };
  const [cls, label] = map[request.status] || map.Expired;
  return <span className={cn('rounded-full px-3 py-1 text-xs font-semibold', cls)}>{label}</span>;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'long' }) : '');

function SignatureBlock({ request }) {
  return (
    <div className="mt-8 rounded-lg border-2 border-green-600/40 p-5">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">Electronically signed</p>
      <p className="mt-2 font-serif text-2xl italic">{request.signed_name}</p>
      <p className="text-sm">{[request.signed_title, request.signer_email].filter(Boolean).join(' · ')}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {when(request.signed_at)} · Document SHA-256 {String(request.content_hash || '').slice(0, 16)}…
      </p>
    </div>
  );
}

function SignForm({ request, token, onDone }) {
  const [name, setName] = useState(request.signer_name || '');
  const [title, setTitle] = useState('');
  const [agree, setAgree] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = (action, body) => {
    setBusy(true); setError('');
    call(action, { token, ...body })
      .then((r) => onDone(r.request))
      .catch((e) => setError(e?.message || 'Something went wrong. Try again.'))
      .finally(() => setBusy(false));
  };

  if (declining) {
    return (
      <div className="space-y-3 rounded-xl border p-5 print:hidden">
        <p className="font-semibold">Decline to sign</p>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Tell the sender why (optional)" rows={4} />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button variant="destructive" disabled={busy} onClick={() => run('decline', { reason })}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}Decline
          </Button>
          <Button variant="ghost" onClick={() => setDeclining(false)}>Back</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-5 print:hidden">
      <p className="flex items-center gap-2 font-semibold"><FileSignature className="size-5 text-primary" /> Sign this document</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Full name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Title</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Operations Manager" autoComplete="organization-title" />
        </label>
      </div>
      {name.trim() && <p className="font-serif text-2xl italic">{name}</p>}
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1 size-4 accent-[hsl(var(--primary))]" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>{CONSENT}</span>
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy || !agree || !name.trim()} onClick={() => run('sign', { signed_name: name, signed_title: title, agree })}>
          {busy && <Loader2 className="mr-2 size-4 animate-spin" />}Sign document
        </Button>
        <button type="button" className="text-sm text-muted-foreground underline" onClick={() => setDeclining(true)}>Decline</button>
      </div>
    </div>
  );
}

/** Public page behind a signing link (`?token=`): read, sign or decline; signed copies stay printable. */
export default function DocumentSigningPage() {
  const [token, setToken] = useState('');
  const [request, setRequest] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = tokenFromUrl();
    setToken(t);
    if (!t) { setError('This signing link is incomplete.'); return; }
    call('document', { token: t })
      .then((r) => setRequest(r.request))
      .catch((e) => setError(e?.message || 'This signing link is not valid.'));
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-xl px-4 py-24 text-center">
        <XCircle className="mx-auto size-10 text-muted-foreground" />
        <p className="mt-4 text-lg font-semibold">{error}</p>
      </div>
    );
  }

  if (!request) {
    return <div className="flex justify-center py-24"><Loader2 className="size-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <style>{'@media print { header, footer, nav { display: none !important; } }'}</style>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{request.company}</p>
          <h1 className="text-2xl font-bold">{request.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Status request={request} />
          <Button variant="outline" size="sm" className="print:hidden" onClick={() => window.print()}>
            <Printer className="mr-2 size-4" /> Print / PDF
          </Button>
        </div>
      </div>

      {request.status === 'Signed' && (
        <p className="mb-6 flex items-center gap-2 rounded-lg bg-green-50 p-3 text-sm text-green-900 dark:bg-green-900/30 dark:text-green-200 print:hidden">
          <CheckCircle2 className="size-5" /> Signed. A confirmation was emailed to {request.signer_email}. Keep this link to view or print your copy.
        </p>
      )}

      <article
        className="prose prose-sm max-w-none rounded-xl border bg-card p-6 dark:prose-invert sm:p-10 [&_.anchor]:hidden [&_table]:w-full"
        dangerouslySetInnerHTML={{ __html: request.html }}
      />

      {request.status === 'Signed' && <SignatureBlock request={request} />}

      <div className="mt-8">
        {request.status === 'Pending' && <SignForm request={request} token={token} onDone={setRequest} />}
        {['Declined', 'Expired', 'Revoked'].includes(request.status) && (
          <p className="rounded-lg bg-muted p-4 text-sm">
            {request.status === 'Declined' ? 'You declined this document. ' : ''}
            This document can no longer be signed with this link. Contact {request.company} if you need a new one.
          </p>
        )}
      </div>

      <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="size-4" /> Sent to {request.signer_email}. Integrity check: {request.intact ? 'the document is unchanged since it was sent.' : 'FAILED — contact the sender.'}
      </p>
    </div>
  );
}
