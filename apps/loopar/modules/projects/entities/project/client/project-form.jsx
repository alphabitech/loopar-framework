'use strict';

import { useCallback, useEffect, useState } from 'react';
import { useForm, FormLayout } from '@loopar/form';
import { loopar } from 'loopar';
import Link from "@link"
import { Camera, Loader2, Plus } from 'lucide-react';
import { __ } from "loopar";

const STAGE_STYLE = {
  'Before': 'bg-muted text-muted-foreground',
  'In Progress': 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  'After': 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  'Issue': 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

/** 'YYYY-MM-DD' → local long date, without shifting the day across time zones. */
const longDate = (value) => {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

function Update({ update, onSaved }) {
  const url = `/desk/Project Update/update?name=${encodeURIComponent(update.name)}`;
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link to={url} inModal bare onSaved={onSaved} className="font-medium text-foreground hover:underline">{longDate(update.date) || update.name}</Link>
        {update.stage && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_STYLE[update.stage] || 'bg-muted text-muted-foreground'}`}>{update.stage}</span>
        )}
        {update.by && <span className="text-xs text-muted-foreground">{update.by}</span>}
      </div>
      {update.note && <p className="whitespace-pre-line text-sm text-muted-foreground">{update.note}</p>}
      {update.photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {update.photos.map((photo, i) => (
            <a key={`${photo.src}-${i}`} href={photo.src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border bg-muted">
              <img src={photo.src} alt={photo.name} loading="lazy" className="aspect-square w-full object-cover" />
            </a>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * Slot `updates` of the Project form: the notes and photos reported from the
 * job site (Project Update records of this project), newest first.
 */
function Updates() {
  const { getValue } = useForm();
  const name = getValue('name');
  const [state, setState] = useState({ loading: false, updates: [], denied: false });

  // Bumped when an update is saved from its modal, to reload the list.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!name) return;
    let alive = true;
    setState((s) => ({ ...s, loading: s.updates.length === 0 }));
    loopar.call('Project', 'updates', {
      query: { name },
      freeze: false,
      success: (r) => alive && setState({ loading: false, updates: Array.isArray(r?.updates) ? r.updates : [], denied: false }),
      error: () => alive && setState({ loading: false, updates: [], denied: true }),
    });
    return () => { alive = false; };
  }, [name, version]);

  // A project that isn't saved yet has nothing to report on.
  if (!name || state.denied) return null;

  const createUrl = `/desk/Project Update/create?project=${encodeURIComponent(name)}`;
  const photos = state.updates.reduce((total, u) => total + u.photos.length, 0);

  return (
    <div className="mb-4 w-full rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <span className="font-semibold">{__("Updates")}</span>
          {state.updates.length > 0 && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
              {state.updates.length} · <Camera className="size-3.5" /> {photos}
            </span>
          )}
        </div>
        <Link to={createUrl} inModal variant="secondary" size="sm" onSaved={reload}>
          <Plus className="mr-1 size-4" /> {__("New update")}
        </Link>
      </div>
      {state.loading ? (
        <div className="flex justify-center px-4 py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : state.updates.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">{__("No updates yet. Add notes and photos from the job site.")}</div>
      ) : (
        <ul className="divide-y">
          {state.updates.map((update) => <Update key={update.name} update={update} onSaved={reload} />)}
        </ul>
      )}
    </div>
  );
}

const SLOTS = { updates: Updates };

export default function ProjectForm() {
  return <FormLayout slots={SLOTS} />;
}
