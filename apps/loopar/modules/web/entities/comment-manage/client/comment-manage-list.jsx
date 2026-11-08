'use strict';

import { ListLayout } from '@loopar/list';
import { loopar } from 'loopar';
import { useState } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { __ } from "loopar";

const STATUS = { PENDING: 4, APPROVED: 5, REJECTED: 6 };

function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function statusLabel(s) {
  s = Number(s);
  if (s === STATUS.APPROVED) return 'Approved';
  if (s === STATUS.REJECTED) return 'Rejected';
  return 'Pending';
}

function ModerationSwitch({ row }) {
  const [status, setStatus] = useState(Number(row.status));
  const [loading, setLoading] = useState(false);

  const set = async (next) => {
    if (loading || status === next) return;
    setLoading(true);
    try {
      await loopar.call('Comment Manage', 'moderate', {
        body: { name: row.name, status: next },
        freeze: false,
      });
      setStatus(next);
    } catch (e) {
      console.error('Comment moderate error:', e);
    } finally {
      setLoading(false);
    }
  };

  const approved = status === STATUS.APPROVED;
  const rejected = status === STATUS.REJECTED;
  const pending = !approved && !rejected;

  const half =
    'flex items-center gap-1 px-3 h-8 text-xs font-medium transition-colors disabled:opacity-50';

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={`inline-flex rounded-full overflow-hidden border ${
          pending ? 'border-amber-500/60' : 'border-border'
        }`}
      >
        <button
          type="button"
          disabled={loading}
          onClick={() => set(STATUS.REJECTED)}
          title={__("Disapprove")}
          className={`${half} ${rejected ? 'bg-red-500 text-white' : 'bg-secondary text-secondary-foreground hover:bg-red-500/15'}`}
        >
          <X className="w-3.5 h-3.5" /> {__("Reject")}
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => set(STATUS.APPROVED)}
          title={__("Approve")}
          className={`${half} ${approved ? 'bg-green-600 text-white' : 'bg-secondary text-secondary-foreground hover:bg-green-500/15'}`}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} {__("Approve")}
        </button>
      </div>
      <span
        className={`text-[10px] uppercase tracking-wide ${
          approved ? 'text-green-600' : rejected ? 'text-red-600' : 'text-amber-600'
        }`}
      >
        {statusLabel(status)}
      </span>
    </div>
  );
}

const COLUMNS = [
  {
    data: { name: 'author', /*  */},
    render: (row) => <span className="font-medium">{row.author}</span>,
  },
  {
    data: { name: 'comment', label: 'Comment' },
    render: (row) => (
      <span className="text-muted-foreground line-clamp-2">{row.comment}</span>
    ),
  },
  {
    data: { name: 'target', label: 'On' },
    render: (row) => (
      <span className="text-xs">
        <span className="font-medium">{row.document}</span>
        {row.document_name ? `: ${row.document_name}` : ''}
      </span>
    ),
  },
  {
    data: { name: 'event_at', label: 'When' },
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmtDate(row.event_at)}</span>
    ),
  },
  {
    data: { name: 'status', label: 'Status' },
    headProps: { className: 'text-center' },
    cellProps: { className: 'text-center' },
    render: (row) => <ModerationSwitch row={row} />,
  },
];

const columns = () => COLUMNS;

export default function CommentManageList() {
  return <ListLayout columns={columns} />;
}
