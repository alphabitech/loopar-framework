'use strict';

import { loopar } from '../loopar.js';
import { fileManage } from '../file-manage.js';
import { getCompany } from '../global/company.js';

export const STANDARD_FORMAT = "standard";
const PRINT_FORMAT_TYPE = "Print Format";

const truthy = (v) => loopar.utils.trueValue(v);

function readFormat(ref) {
  const cfg = fileManage.getConfigFile(ref.__NAME__, ref.__ROOT__);
  if (!cfg) return null;
  return { ...cfg, name: cfg.name || ref.__NAME__, __APP__: ref.__APP__ };
}

export function listPrintFormats(entity) {
  if (!entity) return [];
  const target = loopar.utils.toEntityKey(entity);

  return Object.values(loopar.getRefs())
    .filter(ref => ref.__TYPE__ === PRINT_FORMAT_TYPE)
    .map(readFormat)
    .filter(f => f && !truthy(f.disabled) && f.for_entity && loopar.utils.toEntityKey(f.for_entity) === target)
    .sort((a, b) => (truthy(b.is_default) - truthy(a.is_default)) || String(a.name).localeCompare(String(b.name)));
}

export function getPrintFormat(name) {
  const ref = name && loopar.getRef(name, false);
  if (!ref || ref.__TYPE__ !== PRINT_FORMAT_TYPE) return null;
  return readFormat(ref);
}

/**
 * Format for this request:
 *   ?format=standard → none (the app's `<entity>-print.jsx` or the automatic format)
 *   ?format=<name> → that format, when it prints this entity
 *   nothing → the entity's default format, if one is marked
 */
export function resolvePrintFormat(formats, requested) {
  if (requested === STANDARD_FORMAT) return null;
  if (requested) return formats.find(f => f.name === requested) || null;
  return formats.find(f => truthy(f.is_default)) || null;
}

/** What a Letterhead adds on top of the company: its own tagline and footer. */
const LETTERHEAD_FIELDS = ["name", "tagline", "footer", "is_default"];

async function findLetterhead(name) {
  if (!loopar.getRef("Letterhead", false)) return null;
  if (name) {
    const row = await loopar.db.getRow("Letterhead", name, LETTERHEAD_FIELDS);
    if (row) return row;
  }
  const [row] = await loopar.db.getAll("Letterhead", LETTERHEAD_FIELDS, { is_default: 1 });
  return row || null;
}

/**
 * Letterhead of a print: the company's identity (Company single) plus the
 * letterhead's tagline and footer (the named one, else the default one).
 * Null only when there is neither a company nor a letterhead.
 */
export async function getLetterhead(name = null) {
  try {
    const [company, letterhead] = await Promise.all([getCompany(), findLetterhead(name)]);
    if (!company?.company_name && !letterhead) return null;
    return {
      ...(letterhead || {}),
      company_name: company?.company_name || "",
      legal_name: company?.legal_name || "",
      tax_id_label: company?.tax_id_label || "",
      tax_id: company?.tax_id || "",
      logo: company?.logo || null,
      address: company?.address_text || "",
      phone: company?.phone || "",
      email: company?.email || "",
      website: company?.website || "",
    };
  } catch (e) {
    console.warn("[print] letterhead unavailable:", e?.message);
    return null;
  }
}

function formatPayload(format) {
  if (!format) return null;
  return {
    name: format.name,
    doc_structure: format.doc_structure,
    paper_size: format.paper_size || null,
    orientation: format.orientation || null,
  };
}

export async function printPayload(entity, { requested = null, format: forced = null } = {}) {
  const formats = listPrintFormats(entity);
  const format = forced || resolvePrintFormat(formats, requested);

  return {
    format: formatPayload(format),
    formats: formats.map(f => ({ name: f.name, is_default: truthy(f.is_default) ? 1 : 0 })),
    letterhead: await getLetterhead(format?.letterhead),
  };
}
