'use strict';

import { BaseDocument, loopar, invalidateWorkflows, backfillInitialState } from 'loopar';

const toRows = (v) => Array.isArray(v) ? v : (loopar.utils.isJSON(v) ? JSON.parse(v) : []);
const list = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const isTrue = (v) => [1, '1', true, 'true'].includes(v);

/** One workflow per entity: see packages/loopar/core/document/workflow.js. */
export default class Workflow extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    const document = String(this.document || '').trim();
    // Installers ship workflows next to their entities, whose refs may not be
    // built yet: trust shipped data, validate edits.
    if (loopar.installing) {
      this.name = document;
      return;
    }

    const ref = loopar.getRef(document);
    if (!ref) loopar.throw(`Entity "${document}" does not exist.`);
    if (ref.is_single || ref.is_child) loopar.throw(`"${document}" is a single or child entity and can't have a workflow.`);

    this.document = ref.__NAME__;
    this.name = ref.__NAME__;

    const field = (ref.__FIELDS__ || []).find(f => f?.data?.name === this.state_field);
    if (!field) loopar.throw(`"${this.state_field}" is not a field of ${ref.__NAME__}.`);

    const states = toRows(await this.states);
    if (!states.length) loopar.throw('A workflow needs at least one state.');
    const names = states.map(s => String(s.state || '').trim());
    if (new Set(names).size !== names.length) loopar.throw('Workflow states must be unique.');
    if (states.filter(s => isTrue(s.is_initial)).length > 1) loopar.throw('Only one state can be the initial one.');

    const known = new Set(names);
    for (const t of toRows(await this.transitions)) {
      for (const s of [...list(t.from_state).filter(s => s !== '*'), t.to_state]) {
        if (!known.has(s)) loopar.throw(`Transition "${t.action}": "${s}" is not a state of this workflow.`);
      }
    }
  }

  async afterSave() {
    invalidateWorkflows();

    // Existing records without a state join the initial one.
    const states = toRows(await this.states);
    const initial = (states.find(s => isTrue(s.is_initial)) || states[0])?.state;
    try {
      await backfillInitialState(this.document, this.state_field, initial);
    } catch (error) {
      console.warn(`[workflow] could not backfill ${this.document}.${this.state_field}:`, error.message);
    }
  }

  async delete(...args) {
    const result = await super.delete(...args);
    invalidateWorkflows();
    return result;
  }
}
