/**
 * Computed fields (`data.formula`) — one evaluator shared by the client
 * (live values while typing) and the server (authoritative on save).
 *
 * Language (no `eval`; a small recursive-descent parser):
 *   numbers 12, 0.75 · strings 'Return' / "Return" · field names qty
 *   + - * / %  · unary - and not/!  · = == != > < >= <=  · and/&& or/||
 *   ( )  · functions (case-insensitive):
 *     abs round(x, decimals=0) floor ceil min(...) max(...) if(cond, a, b)
 *     coalesce(a, b, ...)
 *     sum(table.field) avg(table.field) count(table)   — child-table aggregates
 *
 * Empty and non-numeric values count as 0 in arithmetic; division by zero is 0.
 * Inside a child table a formula sees its own row's fields only.
 */

const TOKEN = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(==|!=|>=|<=|&&|\|\||[-+*\/%=<>!(),.])|([A-Za-z_][A-Za-z0-9_]*))/y;

function tokenize(src) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  const text = String(src);
  while (TOKEN.lastIndex < text.length) {
    if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) throw new Error(`Unexpected character at ${start}: "${text.slice(start, start + 10)}"`);
    if (m[1] !== undefined) tokens.push({ type: "num", value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: "str", value: m[2].slice(1, -1).replace(/\\(.)/g, "$1") });
    else if (m[3] !== undefined) tokens.push({ type: "op", value: m[3] });
    else {
      const lower = m[4].toLowerCase();
      if (lower === "and") tokens.push({ type: "op", value: "&&" });
      else if (lower === "or") tokens.push({ type: "op", value: "||" });
      else if (lower === "not") tokens.push({ type: "op", value: "!" });
      else if (lower === "true" || lower === "false") tokens.push({ type: "num", value: lower === "true" ? 1 : 0 });
      else tokens.push({ type: "id", value: m[4] });
    }
  }
  return tokens;
}

const AGGREGATES = new Set(["sum", "avg", "count"]);
const FUNCTIONS = new Set(["abs", "round", "floor", "ceil", "min", "max", "if", "coalesce", ...AGGREGATES]);

/* ------------------------------------------------------------------ parse */

function parse(src) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (...ops) => peek()?.type === "op" && ops.includes(peek().value);
  const expect = (op) => {
    if (!isOp(op)) throw new Error(`Expected "${op}"${peek() ? ` near "${peek().value}"` : " at end"}`);
    i++;
  };

  const binary = (next, ops) => () => {
    let left = next();
    while (isOp(...ops)) {
      const op = tokens[i++].value;
      left = { t: "bin", op: op === "=" ? "==" : op, left, right: next() };
    }
    return left;
  };

  const unary = () => {
    if (isOp("-", "+", "!")) {
      const op = tokens[i++].value;
      return { t: "un", op, arg: unary() };
    }
    return primary();
  };

  const primary = () => {
    const tok = tokens[i++];
    if (!tok) throw new Error("Unexpected end of formula");
    if (tok.type === "num" || tok.type === "str") return { t: "lit", value: tok.value };
    if (tok.type === "op" && tok.value === "(") {
      const node = expr();
      expect(")");
      return node;
    }
    if (tok.type !== "id") throw new Error(`Unexpected "${tok.value}"`);

    if (isOp("(")) {
      const fn = tok.value.toLowerCase();
      if (!FUNCTIONS.has(fn)) throw new Error(`Unknown function "${tok.value}"`);
      i++;
      if (AGGREGATES.has(fn)) {
        const table = tokens[i++];
        if (table?.type !== "id") throw new Error(`${fn}() expects a child table field`);
        let field = null;
        if (isOp(".")) {
          i++;
          const f = tokens[i++];
          if (f?.type !== "id") throw new Error(`${fn}(${table.value}.?) expects a field name`);
          field = f.value;
        }
        if (fn !== "count" && !field) throw new Error(`${fn}() expects table.field`);
        expect(")");
        return { t: "agg", fn, table: table.value, field };
      }
      const args = [];
      if (!isOp(")")) {
        args.push(expr());
        while (isOp(",")) { i++; args.push(expr()); }
      }
      expect(")");
      return { t: "call", fn, args };
    }
    return { t: "id", name: tok.value };
  };

  const mul = binary(unary, ["*", "/", "%"]);
  const add = binary(mul, ["+", "-"]);
  const cmp = binary(add, ["=", "==", "!=", ">", "<", ">=", "<="]);
  const and = binary(cmp, ["&&"]);
  const expr = binary(and, ["||"]);

  const ast = expr();
  if (i < tokens.length) throw new Error(`Unexpected "${tokens[i].value}"`);
  return ast;
}

function collect(ast, fields = new Set(), tables = new Set()) {
  if (!ast) return { fields, tables };
  if (ast.t === "id") fields.add(ast.name);
  else if (ast.t === "agg") tables.add(ast.table);
  else if (ast.t === "bin") { collect(ast.left, fields, tables); collect(ast.right, fields, tables); }
  else if (ast.t === "un") collect(ast.arg, fields, tables);
  else if (ast.t === "call") ast.args.forEach((a) => collect(a, fields, tables));
  return { fields, tables };
}

const cache = new Map();

/** `{ ast, fields, tables }` for a formula, or `{ error }`. Cached by source. */
export function compileFormula(src) {
  const key = String(src ?? "").trim();
  if (cache.has(key)) return cache.get(key);
  let compiled;
  try {
    const ast = parse(key);
    const { fields, tables } = collect(ast);
    compiled = { ast, fields: [...fields], tables: [...tables] };
  } catch (error) {
    compiled = { error: error.message };
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

/* ------------------------------------------------------------------- eval */

const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const isNumeric = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
const truthy = (v) => !(v === null || v === undefined || v === "" || v === 0 || v === "0" || v === false || v === "false");

function compare(op, a, b) {
  const numeric = isNumeric(a) && isNumeric(b);
  const l = numeric ? Number(a) : String(a ?? "");
  const r = numeric ? Number(b) : String(b ?? "");
  switch (op) {
    case "==": return l === r;
    case "!=": return l !== r;
    case ">": return l > r;
    case "<": return l < r;
    case ">=": return l >= r;
    case "<=": return l <= r;
  }
  return false;
}

/** Child-table value (array or JSON string) as an array of rows. */
export function tableRows(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function evaluate(ast, scope) {
  switch (ast.t) {
    case "lit": return ast.value;
    case "id": return scope[ast.name];
    case "un": {
      const v = evaluate(ast.arg, scope);
      if (ast.op === "!") return truthy(v) ? 0 : 1;
      return ast.op === "-" ? -num(v) : num(v);
    }
    case "bin": {
      if (ast.op === "&&") return truthy(evaluate(ast.left, scope)) && truthy(evaluate(ast.right, scope)) ? 1 : 0;
      if (ast.op === "||") return truthy(evaluate(ast.left, scope)) || truthy(evaluate(ast.right, scope)) ? 1 : 0;
      const a = evaluate(ast.left, scope);
      const b = evaluate(ast.right, scope);
      switch (ast.op) {
        case "+": return num(a) + num(b);
        case "-": return num(a) - num(b);
        case "*": return num(a) * num(b);
        case "/": return num(b) === 0 ? 0 : num(a) / num(b);
        case "%": return num(b) === 0 ? 0 : num(a) % num(b);
        default: return compare(ast.op, a, b) ? 1 : 0;
      }
    }
    case "call": {
      const args = () => ast.args.map((a) => evaluate(a, scope));
      switch (ast.fn) {
        case "if": {
          const [c, a, b] = ast.args;
          return truthy(c && evaluate(c, scope)) ? (a ? evaluate(a, scope) : 0) : (b ? evaluate(b, scope) : 0);
        }
        case "coalesce": {
          for (const a of ast.args) {
            const v = evaluate(a, scope);
            if (v !== null && v !== undefined && v !== "") return v;
          }
          return "";
        }
        case "abs": return Math.abs(num(args()[0]));
        case "floor": return Math.floor(num(args()[0]));
        case "ceil": return Math.ceil(num(args()[0]));
        case "round": {
          const [x, d] = args();
          const f = 10 ** Math.max(0, Math.min(10, Math.trunc(num(d))));
          return Math.round((num(x) + Number.EPSILON) * f) / f;
        }
        case "min": { const v = args().map(num); return v.length ? Math.min(...v) : 0; }
        case "max": { const v = args().map(num); return v.length ? Math.max(...v) : 0; }
      }
      return 0;
    }
    case "agg": {
      const rows = tableRows(scope[ast.table]);
      if (ast.fn === "count") return rows.length;
      const total = rows.reduce((acc, row) => acc + num(row?.[ast.field]), 0);
      return ast.fn === "sum" ? total : (rows.length ? total / rows.length : 0);
    }
  }
  return 0;
}

/** Drops binary floating noise (0.1 + 0.2 → 0.3) from numeric results. */
const clean = (v) => (typeof v === "number" ? (Number.isFinite(v) ? Math.round(v * 1e10) / 1e10 : 0) : v);

/** Value of `formula` over `scope` (field → value). Invalid formulas yield "". */
export function evaluateFormula(formula, scope = {}) {
  const compiled = compileFormula(formula);
  if (compiled.error) return "";
  return clean(evaluate(compiled.ast, scope));
}

/**
 * Formula fields of a doc structure: `{ fieldName: formula }`.
 * Walks nested elements (rows, cols...).
 */
export function formulaFields(structure = []) {
  const out = {};
  const walk = (nodes) => {
    for (const el of nodes || []) {
      const formula = el?.data?.formula;
      if (el?.data?.name && typeof formula === "string" && formula.trim()) out[el.data.name] = formula.trim();
      walk(el?.elements);
    }
  };
  walk(Array.isArray(structure) ? structure : []);
  return out;
}

/**
 * Computes every formula over `values`, in dependency order (a formula may
 * read another computed field). Returns only the computed fields:
 * `{ fieldName: value }`. Fields in a dependency cycle are skipped.
 */
export function computeFormulas(formulas = {}, values = {}) {
  const names = Object.keys(formulas);
  if (!names.length) return {};

  const scope = { ...values };
  const out = {};
  const state = {};   // undefined → pending, 1 → visiting, 2 → done

  const visit = (name) => {
    if (state[name] === 2) return true;
    if (state[name] === 1) return false; // cycle
    state[name] = 1;
    const compiled = compileFormula(formulas[name]);
    if (compiled.error) { state[name] = 2; return true; }
    for (const dep of compiled.fields) {
      if (dep in formulas && dep !== name && !visit(dep)) { state[name] = 2; return false; }
    }
    out[name] = scope[name] = clean(evaluate(compiled.ast, scope));
    state[name] = 2;
    return true;
  };

  for (const name of names) visit(name);
  return out;
}

/** Same value for the purpose of syncing a computed field (2 vs "2"). */
export function sameComputedValue(a, b) {
  if (isNumeric(a) && isNumeric(b)) return Number(a) === Number(b);
  return String(a ?? "") === String(b ?? "");
}
