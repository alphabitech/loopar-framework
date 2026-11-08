'use strict';

import { PageController, loopar, normalizeLanguage } from 'loopar';
import { assertTarget, assertLanguage, catalogFor, saveChanges } from './translator-service.js';
import { aiTranslate } from './ai-translate.js';

const MAX_AI_TEXTS = 600;
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? loopar.utils.JSONparse(v, []) : []);

/** Every publicAction<X> a class inherits (PageController ships reviews, galleries, forms…). */
function inheritedPublicActions(cls) {
  const names = new Set();
  for (let proto = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key.startsWith('publicAction') && key.length > 12) names.add(key.slice(12));
    }
  }
  return [...names];
}

/**
 * The desk's Translator. Payloads are wrapped (`catalog`, `result`):
 * `status`/`message` belong to the response envelope.
 */
export default class TranslatorController extends PageController {
  defaultAction = 'view';
  static postOnlyActions = ['save', 'aiTranslate', 'aiTranslateTexts'];

  static get revokedPublicActions() {
    return inheritedPublicActions(this);
  }

  constructor(props) {
    super(props);
  }

  get input() {
    return { ...(this.query || {}), ...(this.data || {}) };
  }

  async actionView() {
    const view = await loopar.newDocument('Translator');
    return await this.render(view);
  }

  /** Strings of an app in a language: state, where they are used, suggestions. */
  async actionCatalog() {
    const target = String(this.input.target || '');
    assertTarget(target);
    const lang = assertLanguage(this.input.lang);
    return { catalog: catalogFor(target, lang) };
  }

  async actionSave() {
    const target = String(this.input.target || '');
    assertTarget(target);
    const lang = assertLanguage(this.input.lang);
    const where = this.input.where === 'app' ? 'app' : 'site';
    let changes = this.input.changes;
    if (typeof changes === 'string') changes = loopar.utils.JSONparse(changes, {});
    const result = saveChanges(target, lang, changes, where, {
      machine: list(this.input.machine),
      reviewed: list(this.input.reviewed),
    });
    return { result, catalog: catalogFor(target, lang) };
  }

  /**
   * Dictionary texts of an app translated by the AI (not saved: the page
   * shows them as unsaved, marked "AI"). `keys` limits it; by default the
   * untranslated ones.
   */
  async actionAiTranslate() {
    const target = String(this.input.target || '');
    assertTarget(target);
    const lang = assertLanguage(this.input.lang);
    const wanted = new Set(list(this.input.keys));
    const { entries } = catalogFor(target, lang);
    const texts = entries
      .filter((e) => (wanted.size ? wanted.has(e.key) : e.status === 'missing'))
      .slice(0, MAX_AI_TEXTS)
      .map((e) => ({ id: e.key, text: e.key, context: (e.sources || []).slice(0, 2).join(', ') }));
    const { translations, failed } = await aiTranslate(texts, { from: 'en', to: lang });
    return { translations, failed, remaining: Math.max(0, entries.filter((e) => e.status === 'missing').length - texts.length) };
  }

  /**
   * Arbitrary texts translated by the AI: page and record translations,
   * the designer's "Languages". `texts`: [{ id, text, context }].
   */
  async actionAiTranslateTexts() {
    // Content can go into English too (a site whose default is another language).
    const from = normalizeLanguage(this.input.from) || 'en';
    const to = normalizeLanguage(this.input.lang);
    if (!to || to === from) loopar.throw({ code: 400, message: 'Choose a language other than the source.' });
    const texts = list(this.input.texts).slice(0, MAX_AI_TEXTS);
    return await aiTranslate(texts, { from, to });
  }
}
