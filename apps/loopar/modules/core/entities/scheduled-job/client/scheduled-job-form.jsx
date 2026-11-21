'use strict';

import { useForm, FormLayout } from '@loopar/form';
import { loopar } from 'loopar';
import { Play } from 'lucide-react';
import { __ } from "loopar";

export default function ScheduledJobForm() {
  const { getValue } = useForm();
  const name = getValue('name');

  const runNow = (e) => {
    e.preventDefault();
    loopar.confirm(`Run ${getValue('label') || name} now?`, () => {
      loopar.call('Scheduled Job', 'runNow', {
        query: { name },
        success: (r) => {
          const ok = r.job_status === 'Success';
          loopar.notify(ok ? (r.result || 'Done.') : `${r.job_status}: ${r.result}`, ok ? 'success' : 'error');
          loopar.refresh();
        },
      });
    });
  };

  return (
    <FormLayout
      actions={name ? { runNow: { label: __("Run now"), icon: Play, onClick: runNow } } : {}}
    />
  );
}
