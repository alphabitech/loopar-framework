'use strict';

import { useCallback, useEffect, useState } from 'react';
import { useForm, FormLayout } from '@loopar/form';
import { loopar, __ } from 'loopar';
import { Button } from '@cn/components/ui/button';
import { CheckIcon, CopyIcon, Loader2, RefreshCwIcon } from 'lucide-react';

/**
 * Slot `feed` of the Calendar form: the link calendar apps subscribe to
 * (iCalendar feed) to show this calendar's events on a phone or a computer.
 */
function Feed() {
  const { getValue } = useForm();
  const name = getValue('name');
  const [state, setState] = useState({ loading: true, url: '', denied: false });
  const [copied, setCopied] = useState(false);

  const load = useCallback((action) => {
    if (!name) return;
    setState((s) => ({ ...s, loading: true }));
    loopar.call('Calendar', action, {
      query: { name },
      freeze: false,
      notifyError: action !== 'feedUrl',
      success: (r) => setState({ loading: false, url: r?.feed_url || '', denied: false }),
      error: () => setState((s) => ({ ...s, loading: false, denied: action === 'feedUrl' })),
    });
  }, [name]);

  useEffect(() => { load('feedUrl'); }, [load]);

  // A calendar that isn't saved yet has no link.
  if (!name || state.denied) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      loopar.dialog?.({ type: 'alert', title: __('Subscribe'), content: state.url });
    }
  };

  const reset = () => loopar.dialog({
    type: 'confirm',
    title: __('New link'),
    content: __('The current link stops working: everyone subscribed has to subscribe again with the new one.'),
    ok: () => load('resetFeed'),
  });

  return (
    <div className="mb-4 w-full rounded-xl border bg-card">
      <div className="border-b px-4 py-3">
        <span className="font-semibold">{__('Subscribe')}</span>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {__('Add this link in Google Calendar, Apple Calendar or Outlook ("subscribe" or "from URL") to see these events there. Anyone with the link can read them.')}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {state.loading && !state.url ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            <input
              readOnly
              value={state.url}
              onFocus={(e) => e.target.select()}
              className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 font-mono text-xs"
            />
            <Button type="button" variant="secondary" size="sm" onClick={copy}>
              {copied ? <CheckIcon className="mr-1 size-4" /> : <CopyIcon className="mr-1 size-4" />}
              {copied ? __('Copied') : __('Copy')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={state.loading}>
              <RefreshCwIcon className="mr-1 size-4" /> {__('New link')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

const SLOTS = { feed: Feed };

export default function CalendarForm() {
  return <FormLayout slots={SLOTS} />;
}
