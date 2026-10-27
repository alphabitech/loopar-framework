import { loopar } from 'loopar';
import { dataInterface } from '@global/element-definition';
import Sanitize from "sanitize-filename";
import { buildFormData } from "@@tools/build-form-data";
import { DocumentController } from "./document-controller";

/**
 * DocumentController + react-hook-form bridge: submit, validation, file /
 * designer serialization and the save lifecycle. `FormWrapper` assigns
 * `ctrl.Form` (the react-hook-form instance) during render.
 */
export class FormController extends DocumentController {
  #form = null;
  #events = Object.fromEntries(
    ["validate", "beforeSend", "afterSend", "sendError", "beforeSave", "afterSave", "saveError"].map((e) => [e, new Set()])
  );

  formFields = {};

  /** Target of `send()` when the caller passes no `document` (falls back to `Entity.name`). */
  controller = null;

  get Form() {
    return this.#form;
  }

  /**
   * Form lifecycle. Returns the unsubscribe function. See README.md § Form lifecycle.
   *   validate(values, ctrl) — after the built-in field validation; return an error
   *     (string | { field, message } | array of them) to add it, nothing to pass
   *   beforeSend(values, ctrl, { action }) — return `false` to cancel
   *   afterSend(response, ctrl, { action }) · sendError(error, ctrl, { action })
   * `*Save` fire in addition to `*Send` when the send comes from `save()`.
   */
  onFormEvent(event, callback) {
    const set = this.#events[event];
    if (!set) throw new Error(`Unknown form event "${event}" (${Object.keys(this.#events).join(" | ")})`);
    set.add(callback);
    return () => set.delete(callback);
  }

  #emit(event, payload, info) {
    let result = true;
    for (const cb of this.#events[event]) {
      if (cb(payload, this, info) === false) result = false;
    }
    return result;
  }

  set Form(Form) {
    this.#form = Form;
  }

  /**
   * Saves through the entity's `meta.action` (create/update) and runs the
   * save events. In a modal the server redirect is suppressed (the transport
   * is global — it would move the base page) and the saved name goes to
   * `props.onSaved(name, response)` instead.
   */
  save(options = {}) {
    const inModal = this.props.inModal;
    const success = (r) => {
      options.success?.(r);
      if (!inModal) return;
      const name = r?.name
        ?? new URLSearchParams(String(r?.redirect || "").split("?")[1] || "").get("name");
      this.props.onSaved?.(name, r);
    };

    return this.send({
      action: this.Document.meta.action,
      ...(inModal && { followRedirect: false }),
      ...options,
      success,
      _isSave: true,
    });
  }

  hasChanges() {
    const dirty = this.#form?.formState?.dirtyFields;
    return !!dirty && Object.keys(dirty).length > 0;
  }

  checkChanges() {
    if (!this.notRequireChanges && !this.hasChanges()) {
      loopar.notify("No changes to save", "warning");
      return false;
    }
    return true;
  }

  /**
   * Submits the form to `document`/`this.controller`/`Entity.name` → `action`.
   * `query` merges with `queryParams`; `extra` appends undeclared fields to the
   * body (anti-bot tokens...). Errors reach `error`/`errorCallback`, or
   * `loopar.throw` when nobody handles them.
   */
  send({ document, action, query = {}, extra = null, _isSave = false, ...options } = {}, successCallback, errorCallback) {
    this.validate();
    if (!options.notRequireChanges && !this.checkChanges()) return;
    const info = { action };
    const values = this.getFormValues();
    if (this.#emit("beforeSend", values, info) === false) return;
    if (_isSave && this.#emit("beforeSave", values, info) === false) return;

    const targetDocument = document || this.controller || this.Document?.Entity?.name;
    if (!targetDocument) {
      return loopar.throw({
        title: "Form without target controller",
        message: `Cannot send action "${action}": declare \`controller\` on the form or pass \`document\` to send().`,
      });
    }

    const body = this.#getFormData(true);
    for (const [key, value] of Object.entries(extra || {})) {
      if (value !== undefined && value !== null) body.append(key, value);
    }

    return loopar.call(targetDocument, action, {
      body,
      query: { ...this.queryParams, ...query },
      freeze: true,
      ...(options.followRedirect === false && { followRedirect: false }),
      success: (r) => {
        if (this.#form && !options.notRequireChanges) this.#form.reset(this.#form.getValues(), { keepValues: true });
        options.success?.(r);
        successCallback?.(r);
        this.#emit("afterSend", r, info);
        if (_isSave) this.#emit("afterSave", r, info);
      },
      error: (e) => {
        options.error?.(e);
        errorCallback?.(e);
        this.#emit("sendError", e, info);
        if (_isSave) this.#emit("saveError", e, info);
        // http.jsx already toasted the error — only propagate so awaiting callers stop.
        if (!options.error && !errorCallback) {
          throw Object.assign(new Error(e?.message || 'Request failed'), e);
        }
      },
    });
  }

  get queryParams() {
    const searchParams = new URLSearchParams(window.location.search);
    return {
      name: this.__DOCUMENT_NAME__,
      ...(Object.fromEntries(searchParams.entries()) || {}),
    };
  }

  /** Built-in field validation, then `validate` listeners. Sets field errors and throws a dialog. */
  validate() {
    const errors = [];
    const values = this.Form ? this.Form.getValues() : {};
    Object.entries(values).forEach(([key, value]) => {
      const field = this.__FIELD__(key);
      if (!field || !this.get(key)) return;
      // A new record named by its series gets the name on save (the server checks it then).
      if (key === "name" && this.Document?.nameFromSeries) return;
      field.value = value;

      if ([FORM_TABLE].includes(field.def.element)) {
        // Table inputs validate their own rows.
      } else {
        field.element = field.def.element;
        const validator = dataInterface(field, value).validate();
        if (!validator.valid) {
          errors.push({ field: field.data.name, message: validator.message });
        }
      }
    });

    for (const cb of this.#events.validate) {
      const result = cb(this.getFormValues(), this);
      for (const e of [].concat(result ?? [])) {
        if (e === false) errors.push({ message: "Validation failed" });
        else if (typeof e === "string") errors.push({ message: e });
        else if (e?.message) errors.push(e);
      }
    }

    if (errors.length > 0) {
      errors.forEach(e => e.field && this.setError(e.field, { message: e.message }));
      loopar.throw({
        type: 'error',
        title: 'Validation error',
        message: errors.map(e => e.message).join('\n')
      });
    }
  }

  getField(name) {
    return this.formFields.defaultValues[name] || null;
  }

  getValue(name) {
    return this.#form ? this.#form.getValues(name) : undefined;
  }

  getFormValues(toSave = false) {
    return this.#getFormValues(toSave);
  }

  buildDesignerToSave(structure, toSave = false) {
    const __files = [];
    const __remote = [];

    const fixFieldData = (field) => {
      const updatedData = field.data;

      for (const [key, value] of Object.entries(field.data || {})) {
        if (key === "background_image" && value) {
          const files = value;
          const filesToSave = [];

          if (files && Array.isArray(files) && files.length > 0) {
            for (const file of files) {
              if (typeof file === "string") continue;

              // Pending URL import (origin "Web"): staged for the server to
              // import at save time.
              if (file.importPending && file.src) {
                const cleanName = toSave
                  ? Sanitize(file.name || "file").replaceAll(/\s+/g, "-")
                  : (file.name || "file");
                __remote.push({ name: cleanName, url: file.src, mode: file.importMode || "reference" });
                filesToSave.push({ name: cleanName, type: file.type, importPending: true });
                continue;
              }

              if (file.src) {
                const typeMatches = file.src.match(/^data:(.*);base64,/);
                const mimeType = typeMatches ? typeMatches[1] : null;

                if (mimeType) {
                  const base64Data = file.src.split(';base64,')[1];
                  const binaryString = atob(base64Data);
                  const len = binaryString.length;
                  const bytes = new Uint8Array(len);

                  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);

                  const safeFileName = toSave ? Sanitize(file.name || "file").replaceAll(/\s+/g, "-") : file.name || "file";
                  const newFile = new File([bytes], safeFileName, { type: mimeType });
                  __files.push(newFile);
                  filesToSave.push({ name: safeFileName, size: newFile.size, type: mimeType });
                  continue;
                }
              }

              filesToSave.push(file);
            }

            filesToSave.length && (updatedData[key] = filesToSave);
          }
        }

        if ([undefined, "undefined", null, "null", 0, "0", "[]"].includes(value)) {
          delete updatedData[key];
        }
      }

      return updatedData;
    };

    const fixElements = (elements = []) => elements.map(field => {
      const newField = { ...field, data: fixFieldData(field) };
      if (newField.elements && newField.elements.length > 0) {
        newField.elements = fixElements(newField.elements);
      } else {
        delete newField.elements;
      }
      return newField;
    });

    return { files: __files, remote: __remote, designer: fixElements(structure) };
  }

  /** Form values as the server expects them; with `toSave`, files/designer are serialized and staged. */
  #getFormValues(toSave = false) {
    if (!this.Form) return this.Document.data || {};

    const __FILES__ = [];
    const __REMOTE_FILES__ = [];

    const out = Object.entries(this.Form.getValues()).reduce((obj, [name, value]) => {
      const field = this.__FIELD__(name);

      if (!field) return obj;
      if (toSave) {
        if ([FILE_INPUT, IMAGE_INPUT].includes(field.def.element)) {
          const files = Array.isArray(value) ? value : [];
          const metaFiles = [];

          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file.rawFile && file.rawFile instanceof File) {
              metaFiles.push({ name: file.rawFile.name, size: file.rawFile.size, type: file.rawFile.type });
              __FILES__.push(file.rawFile);
            } else if (file.importPending && file.src) {
              metaFiles.push({ name: file.name, type: file.type, importPending: true });
              __REMOTE_FILES__.push({ name: file.name, url: file.src, mode: file.importMode || "reference" });
            } else {
              metaFiles.push({ name: file.name, size: file.size, type: file.type, src: file.src });
            }
          }

          obj[name] = metaFiles.length > 0 ? JSON.stringify(metaFiles) : value;
          return obj;
        }

        if (field.def.element === DESIGNER) {
          const { files, remote, designer } = this.buildDesignerToSave(JSON.parse(value), toSave);
          obj[name] = JSON.stringify(designer);
          __FILES__.push(...files);
          __REMOTE_FILES__.push(...remote);
          return obj;
        }

        if (field.def.element === FORM_TABLE) {
          obj[name] = JSON.stringify(value || []);
          return obj;
        }
      }

      obj[name] = [CHECKBOX, SWITCH].includes(field.def.element) ? (value ? 1 : 0) : value;
      return obj;
    }, {});

    out.__FILES__ = __FILES__;
    out.__REMOTE_FILES__ = __REMOTE_FILES__;
    return out;
  }

  #getFormData(toSave) {
    return buildFormData(this.getFormValues(toSave));
  }

  setError(name, error) {
    this.Form.control.setError(name, error);
  }

  setValue(name, value) {
    this.Form.setValue(name, value, { shouldDirty: true, shouldValidate: false });
  }

  /**
   * `ctrl.<field>` ↔ form value, for every writable field whose name does not
   * collide with a controller member (prefer `getValue`/`setValue`).
   */
  buildSettersAndGetters() {
    this.__WRITABLE_FIELDS__.forEach(field => {
      const fieldName = field.data.name;
      if (!fieldName || fieldName in this) return;

      Object.defineProperty(this, fieldName, {
        get: () => (this.#form ? this.#form.getValues(fieldName) : undefined),
        set: (value) => {
          if (this.Form) {
            this.Form.setValue(fieldName, value, { shouldDirty: true, shouldValidate: true });
          }
        },
        enumerable: true,
        configurable: true
      });
    });
  }

  mount() {
    super.mount();
    this.buildSettersAndGetters();
  }
}
