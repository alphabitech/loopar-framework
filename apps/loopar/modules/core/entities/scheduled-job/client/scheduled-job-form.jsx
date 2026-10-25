'use strict';

import { useForm, FormLayout } from '@loopar/form';
import { loopar } from 'loopar';
import { Button } from '@cn/components/ui/button';
import { Play } from 'lucide-react';

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
      actions={name ? { runNow: <Button variant="secondary" onClick={runNow}><Play className="mr-2 size-4" /> Run now</Button> } : {}}
    />
  );
}
