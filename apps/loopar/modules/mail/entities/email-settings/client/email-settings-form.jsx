'use strict';

import { useHandlers } from '@loopar/document';
import { useForm, FormLayout } from '@loopar/form';
import { loopar } from "loopar";

export default function EmailSettingsForm() {
  const { send, getFormValues } = useForm();

  useHandlers({
    /** "Test Connection" button (`data.action: "testConnection"`). */
    testConnection: () => {
      // Both outcomes are toasted by http.jsx (server notify on 2xx, error title/message on 502).
      send({ action: "testConnection", notRequireChanges: true, query: getFormValues() }, null, () => {});
    },
    /** "Send Test Email" button: a real message to the notification address. */
    sendTestEmail: () => {
      send({ action: "sendTestEmail", notRequireChanges: true, query: getFormValues() }, null, () => {});
    },
  });

  return <FormLayout />;
}
