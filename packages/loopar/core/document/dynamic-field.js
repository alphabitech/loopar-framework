'use strict'
import { dataInterface } from '../global/element-definition.js';
import { loopar } from '../loopar.js';
import { pruneDocStructure, liftKeyToNode } from '../global/prune-doc-structure.js';

export default class DynamicField {
  #value = null;

  constructor(props, value) {
    this.#make(props, value);
    this.value = value;
  }

  #make(props) {
    const data = Object.assign({}, props.data || {});
    delete props.data;

    Object.assign(this, data, props);
  }

  set value(value) {
    // Encrypted secrets arrive only from storage: keep the plain value in
    // memory (masked by values()/rawValues()), re-encrypt on save.
    if (this.element === PASSWORD && loopar.isEncryptedSecret(value)) {
      try {
        value = loopar.decryptSecret(value);
      } catch (e) {
        // Wrong key (e.g. a record copied from another tenant) or tampering:
        // the secret is unrecoverable and must be entered again.
        console.warn(`[secrets] could not decrypt "${this.name}": ${e.message}`);
        value = '';
      }
    }
    this.#value = loopar.utils.nullValue(value) ? this.default_value : value;
  }

  /**
   * Password fields store either a one-way hash (`hash`: login passwords,
   * verified, never read back) or a reversible ciphertext (`encrypt`, the
   * default: credentials Loopar must send out — SMTP, API keys, tokens).
   */
  get secretMode() {
    return this.secret === 'hash' ? 'hash' : 'encrypt';
  }

  get isParsed() {
    return this.element === 'text_editor' || ['__ENTITY__', 'doc_structure', 'form_structure'].includes(this.name);
  }

  get value() {
    const value = this.isParsed ? this.#parse() : this.#value;

    if ([CHECKBOX, SWITCH].includes(this.element)) {
      return loopar.utils.trueValue(value) ? 1 : 0;
    }

    return value == null || typeof value == "undefined" ? "" : value;
  }

  stringifyValue(toSave = false) {
    const value = this.#value;

    if (toSave && this.element === PASSWORD && this.secretMode === 'encrypt') {
      return value ? loopar.encryptSecret(String(value)) : '';
    }
    if ([DATE, TIME, DATE_TIME].includes(this.element)) {
      const fn = this.element === DATE ? 'getDate' : this.element === DATE_TIME ? 'getDateTime' : 'getTime';
      // An empty date stays empty. The date-utils helpers default a missing
      // argument to `new Date()`, so passing `undefined` (an unset field)
      // used to persist NOW.
      return loopar.utils.nullValue(value) ? null : loopar.dateUtils[fn](value, 'DB');
    }

    if (this.element === FORM_TABLE) {
      return loopar.utils.isJSON(value) ? JSON.parse(value) : value;
    }

    if ([CHECKBOX, SWITCH].includes(this.element)) {
      return loopar.utils.trueValue(value) ? 1 : 0;
    }

    if (this.element === DESIGNER) {
      const parsed = loopar.utils.JSONparse(value, value);

      if (!Array.isArray(parsed)) {
        return typeof value === 'object' ? JSON.stringify(value) : value;
      }

      const pruned = toSave ? pruneDocStructure(parsed) : parsed;
      const pars = JSON.stringify(pruned);

      return pars;
    }

    return typeof value == 'object' ? JSON.stringify(value) : value;
  }

  #parse() {
    return loopar.utils.isJSON(this.#value) ? JSON.parse(this.#value) : this.#value;
  }

  get formattedValue() {
    return this.#value;
  }

  validate() {
    return dataInterface(this, this.#value).validate();
  }
}
