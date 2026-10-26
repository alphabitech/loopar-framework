import { useHandlers } from '@loopar/document';
import { useForm, BareLayout } from '@loopar/form';

export default function UpdateForm() {
  const { send } = useForm();

  useHandlers({
    update: () => {
      // `?redirect=` = the page the system middleware detoured us from.
      const back = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('redirect')
        : null;
      return send({ action: "update", query: { app_name: "loopar", ...(back ? { redirect: back } : {}) } });
    },
  });

  return <BareLayout />;
}
