'use strict';

import { useHandlers } from '@loopar/document';
import { useForm, FormLayout } from '@loopar/form';

export default function EmailAccountForm() {
  const { send, getFormValues } = useForm();

  useHandlers({
    /** "Test connection" button: both outcomes are toasted by http.jsx. */
    testConnection: () => {
      send({ action: 'testConnection', notRequireChanges: true, query: getFormValues() }, null, () => {});
    },
  });

  return <FormLayout />;
}
