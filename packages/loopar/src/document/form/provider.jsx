import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { FormWrapper } from "@form-provider";
import { RecordTranslations } from "../../components/translation/record-translations";

/** Form middleware: react-hook-form (FormWrapper) + the controller's form API for `useForm()`. */
const FormContext = createContext(null);

const FORM_API = [
  "getValue", "setValue", "setError", "getFormValues", "getField",
  "save", "send", "validate", "hasChanges", "checkChanges", "onFormEvent",
];

/** Loose equality for form values: "1" vs 1, null vs "", arrays/objects by content. */
const sameValue = (a, b) => {
  const norm = (v) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return norm(a) === norm(b);
};

/**
 * A soft refresh (`{ refresh: 'soft' }` after an action) brings new server
 * values in `ctrl.Document.data`, but react-hook-form only reads its
 * defaultValues on mount. Re-base the form on the new data so fields the
 * server changed (status, reports...) show at once, and keep the fields the
 * user edited and has not saved yet.
 */
function useServerSync(ctrl) {
  const data = ctrl.Document.data;
  const appliedRef = useRef(data);

  useEffect(() => {
    if (data === appliedRef.current) return;
    appliedRef.current = data;
    const form = ctrl.Form;
    if (!form || !data) return;

    // Unsaved edits: what react-hook-form marks dirty (tracked on every change).
    const current = form.getValues();
    const edited = Object.keys(current).filter((k) => form.getFieldState(k).isDirty);

    form.reset({ ...(form.formState.defaultValues || {}), ...data });
    for (const k of edited) {
      if (!sameValue(current[k], data[k])) form.setValue(k, current[k], { shouldDirty: true });
    }
  }, [data, ctrl]);
}

export function FormProvider({ ctrl, schema = true, children }) {
  useServerSync(ctrl);

  const api = useMemo(() => {
    const bound = {};
    for (const name of FORM_API) bound[name] = ctrl[name].bind(ctrl);
    return {
      ...bound,
      ctrl,
      get form() { return ctrl.Form; },   // react-hook-form instance (set by FormWrapper)
    };
  }, [ctrl]);

  return (
    <FormContext.Provider value={api}>
      <FormWrapper
        __DATA__={ctrl.Document.data}
        STRUCTURE={schema ? ctrl.__STRUCTURE__ : undefined}
        docRef={ctrl}
      >
        {/* Translate icons on translatable fields (record forms only). */}
        {["create", "update"].includes(ctrl.Document?.meta?.action)
          ? <RecordTranslations entity={ctrl.Document?.Entity}>{children}</RecordTranslations>
          : children}
      </FormWrapper>
    </FormContext.Provider>
  );
}

export function useForm() {
  const api = useContext(FormContext);
  if (!api) throw new Error("useForm() must be used inside a form entry (form, view, auth, installer, report).");
  return api;
}

/**
 * Subscribes to the form lifecycle while the caller is mounted (inline objects are safe: ref + keys).
 *   useFormEvents({
 *     validate:   (values, ctrl) => "msg" | { field, message } | [...] | undefined,
 *     beforeSend: (values, ctrl, { action }) => false to cancel,
 *     afterSend:  (r, ctrl, { action }),   sendError: (e, ctrl, { action }),
 *     beforeSave, afterSave, saveError     // same, only when the send comes from save()
 *   })
 */
export function useFormEvents(listeners) {
  const { onFormEvent } = useForm();
  const ref = useRef(listeners);
  ref.current = listeners || {};
  const key = Object.keys(listeners || {}).sort().join("|");

  useEffect(() => {
    const events = key ? key.split("|") : [];
    const offs = events.map((event) => onFormEvent(event, (...args) => ref.current[event]?.(...args)));
    return () => offs.forEach((off) => off());
  }, [onFormEvent, key]);
}
