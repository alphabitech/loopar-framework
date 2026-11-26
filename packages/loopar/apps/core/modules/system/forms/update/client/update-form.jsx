import { useState } from 'react';
import { useHandlers } from '@loopar/document';
import { useForm, BareLayout } from '@loopar/form';
import { Button } from '@cn/components/ui/button';
import { JobProgress } from '@@components/job-progress';
import { __ } from "loopar";

export default function UpdateForm() {
  const { send } = useForm();
  // The update runs as a background job (System/update answers at once).
  const [job, setJob] = useState(null);
  const [failed, setFailed] = useState(false);

  useHandlers({
    update: async () => {
      // `?redirect=` = the page the system middleware detoured us from.
      const back = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('redirect')
        : null;
      setFailed(false);
      const response = await send({ action: "update", query: { app_name: "loopar", ...(back ? { redirect: back } : {}) } });
      if (response?.job) setJob(response.job);
      return response;
    },
  });

  if (job) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        <header className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">{failed ? __("The update failed") : __("Updating your workspace")}</h2>
          <p className="text-sm text-muted-foreground">
            {failed ? __("A safety snapshot was taken before the update. Check the log and try again.") : __("This can take a few minutes. Keep this page open.")}
          </p>
        </header>
        <JobProgress
          job={job}
          entity="System"
          realtime={false}
          closable={false}
          onEnd={(ended) => {
            if (ended.state === 'completed') {
              setTimeout(() => window.location.replace(ended.result?.redirect || '/desk'), 1200);
            } else {
              setFailed(true);
            }
          }}
        />
        {failed && (
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={() => { setJob(null); setFailed(false); }}>
              {__("Back")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return <BareLayout />;
}
