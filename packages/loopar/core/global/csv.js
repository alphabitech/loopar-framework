'use strict';

/**
 * CSV text of a matrix (`[[cell, …], …]`, first row = header), as spreadsheet
 * apps read it: RFC 4180 quoting, CRLF line ends and a UTF-8 BOM so Excel
 * keeps accents.
 *
 * Text that a spreadsheet would run as a formula (starts with = + - @, tab or
 * CR) is prefixed with an apostrophe; numbers are left alone.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  if (typeof value === "string" && FORMULA_START.test(text) && !NUMBER.test(text.trim())) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(matrix = [], { bom = true } = {}) {
  const body = matrix.map((row) => (row || []).map(csvCell).join(",")).join("\r\n");
  return (bom ? "﻿" : "") + body + "\r\n";
}

/** The delimiter of a CSV text: comma, semicolon (spreadsheets in many locales) or tab — whichever its first line uses most. */
function detectDelimiter(text) {
  let line = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === "\n" || ch === "\r")) break;
    if (!quoted) line += ch;
  }
  const count = (d) => line.split(d).length - 1;
  return [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
}

/**
 * Matrix of a CSV text (the inverse of toCsv): quoted cells may hold the
 * delimiter, line breaks and doubled quotes; the BOM and fully empty lines
 * are dropped; cells are not trimmed. `delimiter` is detected when not given.
 */
export function parseCsv(text, { delimiter = null } = {}) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const sep = delimiter || detectDelimiter(source);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") endRow();
    else if (ch === "\r") { if (source[i + 1] === "\n") i++; endRow(); }
    else cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}

/** File-name safe version of a title: "Sales Invoice" → "sales-invoice". */
export function csvFileName(title, day = "") {
  const base = String(title || "export").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  return `${base}${day ? `-${day}` : ""}.csv`;
}
