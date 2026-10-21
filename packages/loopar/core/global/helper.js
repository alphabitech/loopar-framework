import cookie from './cookie-manager.js';
import dayjs from 'dayjs';
const _text = (text) => {
  return text || "Undefined"
}

const handlePreserveConsecutiveUppercase = (decamelized, separator) => {
  decamelized = decamelized.replace(
    /((?<![\p{Uppercase_Letter}\d])[\p{Uppercase_Letter}\d](?![\p{Uppercase_Letter}\d]))/gu,
    $0 => $0.toLowerCase(),
  );

  return decamelized.replace(
    /(\p{Uppercase_Letter}+)(\p{Uppercase_Letter}\p{Lowercase_Letter}+)/gu,
    (_, $1, $2) => $1 + separator + $2.toLowerCase(),
  );
};

function camelCase(str) {
  return str.toLowerCase().replace(/[_-](.)/g, (_, letter) => letter.toUpperCase());
}

function decamelize(text, { separator = '-', preserveConsecutiveUppercase = false } = {}) {
  text = _text(text).replaceAll(/\s/g, '');
  if (!(typeof text === 'string' && typeof separator === 'string')) {
    throw new TypeError(
      'The `text` and `separator` arguments should be of type `string`',
    );
  }

  if (text.length < 2) {
    return preserveConsecutiveUppercase ? text : text.toLowerCase();
  }

  const replacement = `$1${separator}$2`;

  const decamelized = text.replace(
    /([\p{Lowercase_Letter}\d])(\p{Uppercase_Letter})/gu,
    replacement,
  );

  if (preserveConsecutiveUppercase) {
    return handlePreserveConsecutiveUppercase(decamelized, separator);
  }

  return decamelized
    .replace(
      /(\p{Uppercase_Letter})(\p{Uppercase_Letter}\p{Lowercase_Letter}+)/gu,
      replacement,
    )
    .toLowerCase();
}

function kebabToPascal(kebabString) {
  return kebabString
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 *
 * @param {*} text as string
 * @returns
 */
function Capitalize(text) {
  return _text(text).charAt(0).toUpperCase() + _text(text).slice(1);
}

/**
 *
 * @param {*} text as string
 * @returns
 */
function UPPERCASE(text) {
  return _text(text).toUpperCase();
}

/**
 *
 * @param {*} text as string
 * @returns
 */
function lowercase(text) {
  return _text(text).toLowerCase();
}

/**
 *
 * @param {*} name
 * @returns
 */
function debug_name(name) {
  return _text(name).replace(/\s|-/g, "_");
}

/**
 *
 * @param {*} text
 * @returns
 */

function hash(str) {
  let hash = 0;
  
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  
  return (hash >>> 0).toString(36);
}

/**
 *
 * @param {*} value
 * @returns
 */
function trueValue(value) {
  return [true, "true", 1, "1"].includes(value);
}

function trueToBinary(value) {
  return trueValue(value) ? 1 : 0;
}

function binaryValue(value) {
  return [1, "1"].includes(value);
}

function nullValue(value) {
  return [null, "null", undefined, "undefined"].includes(value);
}

function avatar(name="loopar", size = 32) {
  return (name.split(" ").map((n) => n.charAt(0)).join("").toUpperCase()).slice(0, 2);
}

function humanize(string) {
  if (typeof string !== 'string') {
    throw new TypeError('Expected a string');
  }

  string = decamelize(string);
  string = string.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  string = string.charAt(0).toUpperCase() + string.slice(1);

  return string;
}

function isJSON(str) {
  try {
    JSON.parse(str);
  } catch (e) {
    return false;
  }
  return true;
}

function fixJSON(json) {
  json = json.replace(`""""`, `""`).replace('&#34;&#34;&#34;&#34', ';&#34;&#34;');
  if (json.includes('""""') || json.includes('&#34;&#34;&#34;&#34')) {
    json = fixJSON(json);
  }

  return json;
}

function JSONstringify(obj) {
  return Flatted.stringify(obj);
}

function JSONparse(obj, ifNotValid) {
  // Idempotent: if the input is already a parsed object/array, return it
  // as-is. `JSON.parse` on a non-string coerces to String() first, which
  // turns arrays-of-objects into "[object Object]" and then throws — so
  // the previous version silently returned the fallback in those cases,
  // discarding valid pre-parsed data. That's how the system bootstrap
  // forms (connector, installer, update) ended up with `__FIELDS__ = []`
  // after commit 2ea1c7e: their `doc_structure` ships as an array literal
  // in JSON files, not stringified, and the new `JSONparse(obj, [])` call
  // in builder.js silently dropped them.
  if (obj !== null && typeof obj === 'object') return obj;
  return isJSON(obj) ? JSON.parse(obj) : (ifNotValid ?? null);
}

function randomString(length = 15) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxy';
  const characters = `0123456789${alphabet}${Date.now()}`.split('').sort(() => Math.random() - Math.random()).join('');
  const start = Math.floor(Math.random() * (characters.length - length));
  return `${alphabet.charAt(Math.floor(Math.random() * alphabet.length))}${characters.slice(start + 1, start + length)}`
}

function avatarLetter(word) {
  let value = "";

  if (word) {
    word.split(" ").forEach(word => {
      value += word[0].toUpperCase();
    });
  }

  return value;
}

function fieldList(fields) {
  fields = isJSON(fields) ? JSONparse(fields) : fields;

  return (fields || []).reduce((acc, field) => {
    return acc.concat(field, fieldList(field.elements || []));
  }, []);
}

function rgba(hex, alpha = 1) {
  let base = typeof hex == "object" ? hex : isJSON(hex) ? JSONparse(hex) : hex || {};
  hex = base.color || hex;
  alpha = base.alpha || alpha;

  try {
    const hexRegex = /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
    if (!hexRegex.test(hex)) {
      throw new Error("Incorrect color hexadecimal format");
    }
    hex = hex.replace(/^#/, '');

    const bigint = parseInt(hex, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;

    const a = alpha || 1;

    return `rgba(${r}, ${g}, ${b}, ${a})`;
  } catch (error) {
    return null;
  }
}

function aspectRatio(ratio) {
  const [width, height] = ratio.split(":");
  return (height / width) * 100;
}

function renderizableProps(props) {
  return Object.keys(props).reduce((acc, key) => {
    if (
      (
        typeof props[key] != 'object' || 
        (typeof props[key] === 'function' || key === "children" || key === "style")
      ) && 
      ["e", "els", "element", "elements", "type", "key", "id"].indexOf(key) == -1 &&
      !key.startsWith("on")
    ) {
      acc[key] = props[key];
    }
    return acc;
  }, {});
}

function formatDate(date, format = "YYYY-MM-DD") {
  date = dayjs(new Date(date)).format(format);
  return date == "Invalid Date" ? null : date;
}

function formatTime(date, format = "HH:mm:ss") {
  date = dayjs(new Date(date)).format(format);
  return date == "Invalid Date" ? null : date;
}

function formatDateTime(date, format = "YYYY-MM-DD HH:mm:ss") {
  date = dayjs(new Date(date)).format(format);
  return date == "Invalid Date" ? null : date;
}

function compare(a, b) {
  const normalize = (str) => str
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  
  return normalize(a) === normalize(b);
}

function getArrayMax(array, col) {
  const max = array.reduce((max, current) => Math.max(max, current[col]), -Infinity);
  if (max == -Infinity) return 0;
  return max;
}

function objToRGBA(color) {
  color = JSONparse(color, color);
  if (typeof color !== "object" || color === null) color = { r: 0, g: 0, b: 0, a: null };

  let { r, g, b, a } = color;

  if (typeof r !== "number" || r < 0 || r > 255) return null;
  if (typeof g !== "number" || g < 0 || g > 255) return null;
  if (typeof b !== "number" || b < 0 || b > 255) return null;

  a = a == null ? 1 : a;

  if (typeof a !== "number" || a < 0 || a > 1) return null;

  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const ObjectDeepExtend = function (destination, source, visited = new WeakMap()) {
  if (!destination || typeof destination !== "object") return destination;
  if (!source || typeof source !== "object") return destination;

  if (visited.has(source)) return visited.get(source);

  visited.set(source, destination);

  Object.keys(source).forEach((key) => {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      destination[key] = destination[key] || {};
      ObjectDeepExtend(destination[key], source[key], visited);
    } else {
      destination[key] = source[key];
    }
  });

  return destination;
};

const evaluateAIResponse = (message, start="[", end = start) => {
  if (message.includes(start)) {
    const startIndex = message.indexOf(start);
    const endIndex = message.lastIndexOf(end);
    return message.substring(startIndex, endIndex + end.length);
  }

  return message;
};

const toEntityKey = (str) => {
  if (!str) return '';
  
  return decodeURIComponent(str)
    .replace(/[-_\s]+/g, '')
    .toLowerCase();
}

const urlHash = (route) => {
  const query = route.search ? route.search.split('?') : '';
  route.query = query[1] || '';

  const key = route.query.split('&').map(q => q.split('=')).filter(q => q[0] === 'name').join();


  return hash(`${route.pathname}${key}`.toLowerCase());
}

const urlInstance = (route) => {
  return hash(`${route.pathname}`.toLowerCase());
}

/** Option names callers pass in the trailing options object of `args()` signatures. */
const ARGS_OPTION_KEYS = new Set(["ifNotFound", "includeDeleted", "isSingle", "all", "options"]);

const args = (schema, args) => {
  const isPlainObject = (v) =>
    v != null && typeof v === "object" && !Array.isArray(v);

  if (
    args.length === 1 &&
    isPlainObject(args[0]) &&
    Object.keys(args[0]).some((k) => schema.includes(k))
  ) {
    return { ...args[0] };
  }
  
  // (first, { options }) — only when the object really is options: every key
  // a schema name or a known option. Otherwise it's the second positional
  // argument; e.g. getDoc("User", { email }) is a filter, not options (it
  // used to be read as options, so the filter was dropped and the FIRST row
  // came back).
  if (
    args.length === 2 &&
    isPlainObject(args[1]) &&
    Object.keys(args[1]).every((k) => schema.includes(k) || ARGS_OPTION_KEYS.has(k))
  ) {
    return { [schema[0]]: args[0], ...args[1] };
  }

  if (
    args.length === schema.length + 1 &&
    isPlainObject(args[schema.length])
  ) {
    const out = { ...args[schema.length] };
    for (let i = 0; i < schema.length; i++) out[schema[i]] = args[i];
    return out;
  }

  const out = {};
  for (let i = 0; i < args.length && i < schema.length; i++) {
    out[schema[i]] = args[i];
  }
  return out;
};

export {
  Capitalize,
  UPPERCASE,
  lowercase,
  debug_name,
  hash,
  trueValue,
  trueToBinary,
  humanize,
  JSONstringify,
  JSONparse,
  decamelize,
  avatar,
  randomString,
  avatarLetter,
  camelCase,
  nullValue,
  isJSON,
  fieldList,
  rgba,
  aspectRatio,
  kebabToPascal,
  cookie,
  renderizableProps,
  binaryValue,
  formatDate,
  formatTime,
  formatDateTime,
  compare,
  getArrayMax,
  objToRGBA,
  ObjectDeepExtend,
  evaluateAIResponse,
  toEntityKey,
  fixJSON,
  urlHash,
  urlInstance,
  args
}