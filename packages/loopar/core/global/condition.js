'use strict';

/*
 * Field conditions (`display_on`, `required_on`): `field op value` joined by and/or (&&, ||), with
 * parentheses and `not`/`!`. Operators: = == != > < >= <=. Values: 'quoted',
 * "quoted", numbers or bare words (literals). A lone field tests truthiness.
 * Parsed here, never eval'd: the old regex rewrite turned `worker` into
 * `w||ker`, `>=` into `>==` and broke on quotes inside values.
 */
const TOKEN = /\s*(?:(\(|\)|!=|==|>=|<=|=|>|<|&&|\|\||!)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?)(?![\w.])|([A-Za-z_][\w.]*))/y;

function tokenize(condition) {
  const tokens = [];
  const src = String(condition ?? "");
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (!src.slice(pos).trim()) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`Unexpected "${src.slice(pos, pos + 10)}"`);
    pos = TOKEN.lastIndex;
    if (m[1]) tokens.push({ type: "op", value: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) tokens.push({ type: "str", value: (m[2] ?? m[3]).replace(/\\(.)/g, "$1") });
    else if (m[4] !== undefined) tokens.push({ type: "num", value: m[4] });
    else {
      const word = m[5];
      const lower = word.toLowerCase();
      if (lower === "and") tokens.push({ type: "op", value: "&&" });
      else if (lower === "or") tokens.push({ type: "op", value: "||" });
      else if (lower === "not") tokens.push({ type: "op", value: "!" });
      else tokens.push({ type: "id", value: word });
    }
  }
  return tokens;
}

const FALSY = new Set([undefined, null, "", 0, "0", false, "false"]);
const COMPARE = new Set(["=", "==", "!=", ">", "<", ">=", "<="]);

function compare(left, op, right) {
  const ln = Number(left), rn = Number(right);
  const numeric = left !== "" && left != null && right !== "" && !isNaN(ln) && !isNaN(rn);
  const l = String(left ?? ""), r = String(right ?? "");
  switch (op) {
    case "=": case "==": return numeric ? ln === rn : l === r;
    case "!=": return numeric ? ln !== rn : l !== r;
    case ">": return numeric ? ln > rn : l > r;
    case "<": return numeric ? ln < rn : l < r;
    case ">=": return numeric ? ln >= rn : l >= r;
    case "<=": return numeric ? ln <= rn : l <= r;
  }
  return false;
}

export function evaluateCondition(condition, values = {}) {
  try {
    const tokens = tokenize(condition);
    let i = 0;
    const peek = () => tokens[i];
    const take = () => tokens[i++];

    const primary = () => {
      const t = take();
      if (!t) throw new Error("Unexpected end");
      if (t.type === "op" && t.value === "!") return !primary();
      if (t.type === "op" && t.value === "(") {
        const v = orExpr();
        if (take()?.value !== ")") throw new Error("Missing )");
        return v;
      }
      if (t.type !== "id") throw new Error(`Unexpected ${t.value}`);
      const left = values[t.value];
      const next = peek();
      if (next?.type === "op" && COMPARE.has(next.value)) {
        take();
        const r = take();
        if (!r || r.type === "op") throw new Error("Missing value");
        return compare(left, next.value, r.value);
      }
      return !FALSY.has(left);
    };
    const andExpr = () => {
      let v = primary();
      while (peek()?.value === "&&") { take(); const r = primary(); v = v && r; }
      return v;
    };
    const orExpr = () => {
      let v = andExpr();
      while (peek()?.value === "||") { take(); const r = andExpr(); v = v || r; }
      return v;
    };

    const result = orExpr();
    if (i < tokens.length) throw new Error(`Unexpected ${tokens[i].value}`);
    return !!result;
  } catch (error) {
    console.error(`Error evaluating condition "${condition}":`, error.message);
    return false;
  }
}

/** Fields a condition reads (left side of comparisons and lone fields). */
export function extractFieldNames(condition) {
  let tokens;
  try { tokens = tokenize(condition); } catch { return []; }
  const fields = new Set();
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    if (t.type === "id" && !(prev?.type === "op" && COMPARE.has(prev.value))) fields.add(t.value);
  });
  return [...fields];
}
