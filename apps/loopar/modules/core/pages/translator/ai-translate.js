'use strict';

import { loopar, languageName, Helpers } from 'loopar';

/**
 * Machine translation through the tenant's AI (integrations → AI, any
 * OpenAI-compatible provider). Used by the Translator (dictionaries), the
 * "Translations" sections (pages, records) and the designer's "Languages".
 *
 * Every answer is validated before it is accepted: same placeholders
 * ({0}, {name}), same HTML tags, nothing empty. What fails comes back in
 * `failed` and is never applied. Results are suggestions the caller stores
 * marked as machine translations, pending review.
 */

const BATCH_CHARS = 9000;
const BATCH_ITEMS = 120;

/** Terms that must stay consistent across Loopar's interface, per target language. */
const GLOSSARIES = {
  es: 'Entity=Entidad; Document=Documento; Record=Registro; Field=Campo; Module=Módulo; App=App; Desk=Escritorio; Workspace=Espacio de trabajo; Tenant=Tenant; Page=Página; Builder=Constructor; Designer=Diseñador; Element=Elemento; List=Lista; Single=Único; Child table=Tabla hija; Row=Fila; Role=Rol; Permission=Permiso; User=Usuario; Website=Sitio web; Backup=Copia de seguridad; Dashboard=Panel; Workflow=Flujo de trabajo; Print Format=Formato de impresión; Letterhead=Membrete; Company=Empresa; Settings=Configuración; Save=Guardar; New=Nuevo; Delete=Eliminar; Cancel=Cancelar; Submit=Enviar; Sign in=Iniciar sesión; Log Out=Cerrar sesión. Address the user as "tú".',
};

const RULES = [
  'You translate user-interface strings and website content of a software product.',
  'Return ONLY JSON: {"translations":[{"id":"<id>","text":"<translation>"}]} with one item per input id.',
  'Keep exactly: placeholders like {0} {1} {name}; HTML tags and attributes; markdown syntax; URLs; e-mail addresses; text inside backticks; leading/trailing spaces and punctuation; line breaks.',
  'Never translate product or brand names (Loopar, Stripe, Google, GitHub, Tailwind…) nor code, file names, IDs, currency or ISO codes.',
  'Use the given context (where the text is used) to pick the right meaning: a button is a verb, a column header is a noun.',
  'Keep the length and tone of the source; interface strings are concise.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join('|');
const tags = (s) => (String(s).match(/<\/?[a-zA-Z][^>]*>/g) || []).map((t) => t.replace(/\s.*$/, '').toLowerCase()).sort().join('|');

/** Why `translation` is not acceptable for `source`, or null. */
export function rejectReason(source, translation) {
  if (typeof translation !== 'string' || !translation.trim()) return 'empty';
  if (placeholders(source) !== placeholders(translation)) return 'placeholders';
  if (tags(source) !== tags(translation)) return 'html';
  return null;
}

function batches(items) {
  const out = [];
  let current = [], size = 0;
  for (const item of items) {
    const len = item.text.length + (item.context || '').length + 20;
    if (current.length && (size + len > BATCH_CHARS || current.length >= BATCH_ITEMS)) {
      out.push(current); current = []; size = 0;
    }
    current.push(item); size += len;
  }
  if (current.length) out.push(current);
  return out;
}

function parseAnswer(content) {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : parsed.translations || [];
  } catch {
    const obj = Helpers.evaluateAIResponse(content, '{', '}');
    return Array.isArray(obj) ? obj : obj?.translations || [];
  }
}

/**
 * @param {Array<{id: string, text: string, context?: string}>} texts
 * @param {{ from: string, to: string }} languages
 * @returns {Promise<{ translations: Object<string,string>, failed: Array<{id, reason}> }>}
 */
export async function aiTranslate(texts, { from = 'en', to }) {
  const ai = await loopar.getDocument('AI');
  const items = texts.filter((t) => t && typeof t.text === 'string' && t.text.trim() && t.id != null).map((t) => ({ ...t, id: String(t.id) }));
  const glossary = GLOSSARIES[to.split('-')[0]];
  const system = `${RULES}\nTranslate from ${languageName(from)} (${from}) to ${languageName(to)} (${to}).${glossary ? `\nGlossary: ${glossary}` : ''}`;

  const translations = {};
  const failed = [];
  for (const batch of batches(items)) {
    const user = JSON.stringify({ texts: batch.map(({ id, text, context }) => ({ id, text, ...(context ? { context } : {}) })) });
    let answer = [];
    try {
      answer = parseAnswer(await ai.completeJSON({ system, user, schema: SCHEMA, name: 'translations' }));
    } catch (e) {
      if (!Object.keys(translations).length) throw e; // nothing done yet: surface the AI error
      for (const item of batch) failed.push({ id: item.id, reason: 'request' });
      continue;
    }
    const byId = new Map(answer.filter((a) => a && a.id != null).map((a) => [String(a.id), a.text]));
    for (const item of batch) {
      const text = byId.get(item.id);
      const reason = rejectReason(item.text, text);
      if (reason) failed.push({ id: item.id, reason });
      else translations[item.id] = text;
    }
  }
  return { translations, failed };
}
