import dayjs from 'dayjs';
import {getTime} from './date-utils.js';

export const TYPES = Object.freeze({
  increments: 'increments',
  timestamps: 'timestamps',
  integer: 'INTEGER',
  bigInteger: 'BIGINT',
  smallint: 'SMALLINT',
  tinyint: 'TINYINT',
  float: 'FLOAT',
  decimal: 'DECIMAL',
  double: 'DOUBLE',

  string: 'VARCHAR',
  text: 'TEXT',
  mediumtext: 'MEDIUMTEXT',
  longtext: 'LONGTEXT',

  uuid: 'UUID',
  enum: 'ENUM',
  boolean: 'BOOLEAN',

  date: 'DATE',
  dateTime: 'DATETIME',
  time: 'TIME',
  timestamp: 'TIMESTAMP',

  binary: 'BLOB',
  json: 'JSON',
  jsonb: 'JSONB',

  geometry: 'GEOMETRY',
  point: 'POINT',
  multiPoint: 'MULTIPOINT',
});

export const COLUMN_FORMATS = {
  data: {
    description: "Short generic text. VARCHAR (length default 255).",
    inputType: "text",
    aliases: ["text", "read_only"],
    legacyTags: ["VARCHAR"],
    sql: (t, name, d) => t.string(name, d.length || 255),
  },
  email: {
    description: "Email address. VARCHAR.",
    inputType: "email",
    sql: (t, name, d) => t.string(name, d.length || 255),
  },
  password: {
    description: "Hashed password. VARCHAR (never store in plain text).",
    inputType: "password",
    sql: (t, name, d) => t.string(name, d.length || 255),
  },
  text: {
    description: "Long-form text. SQL TEXT (no key-length on UNIQUE).",
    inputType: "text",
    legacyTags: ["TEXT"],
    sql: (t, name) => t.text(name),
  },
  mediumtext: {
    description: "Medium-sized text (MySQL MEDIUMTEXT, TEXT elsewhere).",
    inputType: "text",
    legacyTags: ["MEDIUMTEXT"],
    sql: (t, name) => t.text(name, "mediumtext"),
  },
  longtext: {
    description: "Large text blob (MySQL LONGTEXT, TEXT elsewhere).",
    inputType: "text",
    legacyTags: ["LONGTEXT"],
    sql: (t, name) => t.text(name, "longtext"),
  },

  int: {
    description: "32-bit signed integer.",
    inputType: "number",
    aliases: ["integer"],
    legacyTags: ["INTEGER"],
    sql: (t, name) => t.integer(name),
  },
  long_int: {
    description: "64-bit signed integer.",
    inputType: "number",
    aliases: ["bigint"],
    legacyTags: ["BIGINT"],
    sql: (t, name) => t.bigInteger(name),
  },
  float: {
    description: "Single-precision float.",
    inputType: "number",
    legacyTags: ["FLOAT"],
    sql: (t, name) => t.float(name),
  },
  double: {
    description: "Double-precision float (DOUBLE / DOUBLE PRECISION).",
    inputType: "number",
    legacyTags: ["DOUBLE"],
    sql: (t, name) => t.double(name),
  },
  decimal: {
    description: "Fixed-precision decimal. precision/scale from data.",
    inputType: "number",
    aliases: ["percent"],
    legacyTags: ["DECIMAL"],
    sql: (t, name, d) => t.decimal(name, d.precision || 10, d.scale || 2),
  },
  currency: {
    description:
      "Money amount. Stored as DECIMAL — no native CURRENCY type exists " +
      "across MySQL/PG/SQLite, so we fall back to fixed-precision decimal.",
    inputType: "text",
    sql: (t, name, d) => t.decimal(name, d.precision || 18, d.scale || 4),
  },

  date: {
    description: "Calendar date (no time).",
    inputType: "date",
    legacyTags: ["DATE"],
    sql: (t, name) => t.date(name),
  },
  datetime: {
    description: "Date + time (TIMESTAMP / DATETIME depending on dialect).",
    inputType: "datetime-local",
    legacyTags: ["DATETIME", "TIMESTAMP"],
    sql: (t, name) => t.timestamp(name),
  },
  time: {
    description: "Time of day.",
    inputType: "time",
    legacyTags: ["TIME"],
    sql: (t, name) => t.time(name),
  },

  boolean: {
    description: "True/false (BOOLEAN — INTEGER on SQLite via Knex).",
    inputType: "checkbox",
    legacyTags: ["BOOLEAN"],
    sql: (t, name) => t.boolean(name),
  },
  json: {
    description: "JSON object. Maps to native JSON where supported.",
    inputType: "text",
    legacyTags: ["JSON"],
    sql: (t, name) => t.json(name),
  },
  jsonb: {
    description: "Binary JSON (PG-only; falls back to JSON elsewhere).",
    inputType: "text",
    legacyTags: ["JSONB"],
    sql: (t, name) => t.jsonb(name),
  },
  uuid: {
    description: "UUID. CHAR(36) on most dialects, native UUID on PG.",
    inputType: "text",
    legacyTags: ["UUID"],
    sql: (t, name) => t.uuid(name),
  },
  blob: {
    description: "Binary blob (BLOB / BYTEA).",
    inputType: "file",
    legacyTags: ["BLOB"],
    sql: (t, name) => t.binary(name),
  },
  increments: {
    description: "Auto-increment primary key (SERIAL / AUTO_INCREMENT).",
    inputType:   "number",
    legacyTags:  ["increments"],
    sql: (t, name) => t.increments(name),
  },
};

/**
 * Register a new column format at runtime (plugins / extensions).
 * Throws on collision — formats are append-only by design so a plugin
 * can't silently change DDL semantics for an existing key.
 */
export function registerColumnFormat(name, def) {
  if (!name || !def) throw new Error("registerColumnFormat: name and def required");
  if (COLUMN_FORMATS[name]) {
    throw new Error(`registerColumnFormat: format '${name}' already exists`);
  }
  if (typeof def.sql !== "function") {
    throw new Error(`registerColumnFormat('${name}'): def.sql must be a function`);
  }
  COLUMN_FORMATS[name] = def;
  rebuildDerivedMaps();
}

export const inputType = {};
export const COLUMN_FORMAT = {};
export const LEGACY_TAG_TO_FORMAT = new Map();

function rebuildDerivedMaps() {
  const it  = {};
  const cf  = {};
  LEGACY_TAG_TO_FORMAT.clear();

  for (const [key, def] of Object.entries(COLUMN_FORMATS)) {
    it[key] = def.inputType || "text";
    cf[key] = key;

    for (const tag of def.legacyTags || []) {
      LEGACY_TAG_TO_FORMAT.set(tag, key);
    }
  }

  for (const [key, def] of Object.entries(COLUMN_FORMATS)) {
    for (const alias of def.aliases || []) {
      const lower = alias.toLowerCase();
      it[lower] = def.inputType || "text";
      cf[lower] = key;
    }
  }

  Object.keys(inputType).forEach(k => delete inputType[k]);
  Object.assign(inputType, it);
  Object.keys(COLUMN_FORMAT).forEach(k => delete COLUMN_FORMAT[k]);
  Object.assign(COLUMN_FORMAT, cf);
}
rebuildDerivedMaps();

export function resolveColumnFormat(field) {
  if (!field?.data) return null;
  const declared = field.data.format ?? field.data.type;
  if (!declared) return null;
  return COLUMN_FORMAT[String(declared).toLowerCase()] || null;
}
/**
 * Element groups: palette categories for the designer sidebar.
 *
 * Classification criteria:
 *  - layout:     pure structure — no content or semantics of its own, only arranges children.
 *  - content:    text and inline content.
 *  - media:      images, video and visual media collections.
 *  - components: prefabricated blocks with their own internal style/layout.
 *  - data:       data-driven — render entity data or external services.
 *  - meta:       no visual output; page-level configuration.
 *  - form:       writable inputs — the ONLY group that persists DB columns
 *                (see `writable`, consumed by elementsDict.isWritable).
 *
 * `label` is the display name in the designer sidebar; `writable` drives
 * persistence semantics — reclassifying an element between non-writable
 * groups is purely a UI concern and can never change the DB schema.
 */
export const ELEMENT_GROUPS = Object.freeze({
  layout:     { label: "Layout",     writable: false },
  content:    { label: "Content",    writable: false },
  media:      { label: "Media",      writable: false },
  components: { label: "Components", writable: false },
  data:       { label: "Data",       writable: false },
  meta:       { label: "Meta",       writable: false },
  form:       { label: "Form",       writable: true },
  system:     { label: "System",     writable: true },
  // Print-format building blocks. `contextOnly`: offered only by a document
  // context that lists the group (Print Format Builder) — never on pages.
  print:      { label: "Print",      writable: false, contextOnly: true },
  // Desk page building blocks (shortcuts, KPIs, lists): offered only by the
  // Desk Page Builder context — they read desk data, never on web pages.
  desk:       { label: "Desk",       writable: false, contextOnly: true },
});

export const elementsDefinition = {
  layout: [
    { element: "section", icon: "GalleryVertical" },
    { element: "container", icon: "Container" },
    { element: "div", icon: "Box", droppable: true},
    { element: "row", icon: "Columns2" },
    { element: "col", icon: "RectangleVertical" },
    { element: "fragment", icon: "Scan" },
    { element: "panel", icon: "PanelBottom", designerClasses: "min-h-[100px] w-full" },
    { element: "tabs", icon: "AppWindow" },
    { element: "tab", icon: "PanelTop", show_in_design: false  },
    { element: "generic", icon: "Code" },
    { element: "menu_content", icon: "Menu" },
  ],
  content: [
    { element: "title", icon: "Heading1", droppable: false },
    { element: "subtitle", icon: "Heading2", droppable: false },
    { element: "paragraph", icon: "Pilcrow", droppable: false },
    { element: "text_block", icon: "Type" },
    { element: "text_block_icon", icon: "MessageSquareText" },
    { element: "markdown", icon: "BookOpenCheck", designerOnly: true, droppable: false },
    { element: "html_block", icon: "Code", type: TYPES.text, designerOnly: true, clientOnly: true },
    { element: "icon", icon: "Shapes" },
    { element: "link", icon: "Link", droppable: false },
    { element: "button", icon: "SquareMousePointer" },
  ],
  media: [
    { element: "image", icon: "Image", droppable: false },
    { element: "gallery", icon: "Images", designerClasses: "pt-3" },
    { element: "slider", icon: "GalleryHorizontal" },
    { element: "carousel", icon: "GalleryHorizontalEnd", designerClasses: "pt-2" },
    { element: "video_embed", icon: "MonitorPlay", droppable: false },
    { element: "banner_image", droppable: true, icon: "ImagePlus" },
  ],
  components: [
    { element: "card", icon: "PanelTop" },
    { element: "feature_card", icon: "BadgeCheck" },
    { element: "banner", icon: "GalleryHorizontalEnd", droppable:true, designerClasses: "h-full w-full p-3 py-6" },
    { element: 'review', icon: "Star"},
    { element: "contact_form", icon: "Contact"},
    { element: 'particles', icon: 'Sparkles' },
    { element: 'particles_settings', icon: 'Settings2' },
    { element: 'example_viewer', icon: 'Scan' },
    { element: "direct-preview", icon: "View" },
    //{ element: "direct-preview-iframe", icon: "View" },
  ],
  data: [
    { element: 'collection', icon: "LayoutGrid"},
    { element: 'collection_view', icon: "LayoutGrid", show_in_design: false},
    { element: "entity", icon: "Code"},
    { element: "form", icon: "ClipboardList"},
    { element: "stripe", icon: "CreditCard" },
    { element: "stripe_embebed", icon: "CreditCard" },
    { element: "stripe_plans", icon: "LayoutGrid" },
  ],
  meta: [
    { element: "seo", icon: "Search", designerOnly: true },
  ],
  form: [
    { element: "input", icon: "RectangleEllipsis", type: TYPES.string },
    { element: "password", icon: "KeyRound", type: TYPES.text },
    { element: "date", icon: "Calendar", type: TYPES.date, format: 'YYYY-MM-DD' },
    { element: "date_time", icon: "CalendarClock", type: TYPES.dateTime, format: 'YYYY-MM-DD HH:mm:ss' },
    { element: "time", icon: "Clock10", type: TYPES.time, format: 'HH:mm:ss' },
    { element: "currency", icon: "Currency", type: TYPES.decimal, show_in_design: false },
    { element: "integer", icon: "Binary", type: TYPES.integer, show_in_design: false },
    { element: "decimal", icon: "Hash", type: TYPES.decimal, show_in_design: false },
    { element: "select", icon: "ChevronDown", type: TYPES.text },
    { element: "textarea", icon: "FileText", type: TYPES.longtext },
    { element: "text_editor", icon: "TextCursorInput", type: TYPES.longtext, clientOnly: true },
    { element: "checkbox", icon: "SquareCheck", type: TYPES.integer },
    { element: "switch", icon: "ToggleLeft", type: TYPES.integer },
    { element: "form_table", icon: "Table", type: TYPES.string },
    { element: "markdown_input", icon: "BookOpenCheck", type: TYPES.text, clientOnly: true },
    { element: "file_input", icon: "FileInput", type: TYPES.longtext },
    { element: "file_uploader", icon: "FileUp", type: TYPES.longtext },
    { element: "image_input", icon: "FileImage", type: TYPES.longtext },
    { element: "color_picker", icon: "Palette", type: TYPES.text },
    { element: "icon_input", icon: "Shapes", type: TYPES.text },
    { element: "radio_group", icon: "CircleDot", type: TYPES.text },
    { element: "radio_item", icon: "CircleDot", type: TYPES.integer, show_in_design: false },
  ],
  // Writable like `form` (they persist DB columns), but framework-facing:
  // style/config inputs and system-managed fields, not fields a person fills
  // in a business form. Kept out of every AI generation context.
  system: [
    { element: "id", icon: "BookKey", type: TYPES.increments, show_in_design: false },
    { element: "padding", icon: "Shrink", type: TYPES.text },
    { element: "margin", icon: "Expand", type: TYPES.text },
    { element: "tailwind", icon: "SiTailwindcss", type: TYPES.longtext },
    { element: "designer", icon: "Brush", type: TYPES.longtext },
    { element: "slot", icon: "Plug"},
    { element: "metadata", icon: "Code", type: TYPES.json}
  ],
  // Read the record being printed (src/document/print/record.jsx); outside a
  // print they render a design placeholder.
  print: [
    { element: "letterhead", icon: "Building2", droppable: false },
    { element: "doc_header", icon: "Heading", droppable: false },
    { element: "doc_field", icon: "Tag", droppable: false },
    { element: "doc_table", icon: "Table", droppable: false },
    { element: "doc_section", icon: "LayoutPanelTop" },
    { element: "doc_body", icon: "LayoutList", droppable: false },
    { element: "page_break", icon: "SeparatorHorizontal", droppable: false },
  ],
  // Read through the Desk Page's controller (core/document/desk-page.js),
  // filtered by the viewer's permissions.
  desk: [
    { element: "shortcut", icon: "SquareArrowOutUpRight", droppable: false },
    { element: "number_card", icon: "Hash", droppable: false },
    { element: "quick_list", icon: "ListOrdered", droppable: false },
    { element: "module_cards", icon: "LayoutGrid", droppable: false },
  ]
}

export const elementsDict = Object.freeze(Object.entries(elementsDefinition).reduce((acc, [key, value]) => {
  value.forEach(element => {
    acc[element.element] = {
      def: {
        ...element,
        group: key,
        isWritable: ELEMENT_GROUPS[key]?.writable === true,
        droppable: element.droppable,
        designerClasses: element.designerClasses ?? null,
      }
    };
  });

  return acc;
}, {}));

global.elementIsDroppable = (element) => {
  const def = elementsDict[element]?.def;
  if (!def) return false;
  return !def.isWritable && def.droppable !== false;
};

export const elementsNames = Object.freeze(Object.values(elementsDefinition).reduce((acc, current) => {
  acc = [...acc, ...current.map(element => {
    if (!global[element.element.toUpperCase()]) {
      Object.defineProperty(global, element.element.toUpperCase(), {
        get: () => element.element,
        set: () => {
          throw (element.element + ' is a Safe CONST and cannot be re-declared.')
        }
      });
    }

    return element.element;
  })];

  return acc;
}, []));

export const elementsNameByType = (type) => {
  return elementsNames.filter(element => elementsDict[element].def.type.includes(type));
}

class DataInterface {
  #element = null;

  constructor(element, value) {
    this.#element = element;
    this.value = value;
  }

  get data() {
    return this.#element.data || this.#element;
  }

  debugText(text) {
    return text.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).replace(/\s/g, '');
  }

  replaceUnderscore(text) {
    return text.replace(/_/g, ' ');
  }

  replaceSpace(text) {
    return text.replace(/ /g, '_');
  }

  get element() {
    const def = this.#element.props?.def || this.#element.def || this.#element || {};
    return def.element;
  }

  validatorRules() {
    var type = (this.element === INPUT ? this.data.format || this.element : this.element) || 'text';
    type = type.charAt(0).toUpperCase() + type.slice(1);

    if (this['is' + type]) {
      // Every format rule below is regex-based and only meaningful for short
      // values. Bounding the length BEFORE running any regex neutralizes
      // catastrophic backtracking (ReDoS) — these validators also run
      // server-side on attacker-controlled input (publicActionSubmitForm).
      if (String(this.value).length > 2048) {
        return { valid: false, message: 'Value is too long' };
      }
      return this['is' + type]();
    }

    return {
      valid: true
    };
  }

  isCurrency() {
    // Money amounts can be 0 (untouched computed totals), negative (discounts,
    // volume-tier adjustments) and fractional below 1. Any plain
    // decimal number is valid; rounding to cents is the caller's job.
    var regex = /^-?\d+(?:\.\d+)?$/;
    return {
      valid: regex.test(String(this.value).trim()),
      message: 'Invalid Currency'
    }
  }

  isEmail() {
    var regex = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return {
      valid: regex.test(this.value),
      message: 'Invalid email address'
    }
  }

  isUrl() {
    var regex = /^(?:(?:https?|ftp):\/\/)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)(?:\.(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)*(?:\.(?:[a-z\u00a1-\uffff]{2,})))(?::\d{2,5})?(?:\/\S*)?$/;
    return {
      valid: regex.test(this.value),
      message: 'Please enter a valid URL'
    }
  }

  isPassword() {
    var regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return {
      valid: true,// regex.test(this.value),
      message: 'Password must contain at least 8 characters, one uppercase, one lowercase, one number and one special character'
    }
  }

  isDate() {
    return {
      valid: dayjs(new Date(this.value)).isValid(),
      message: 'Please enter a valid date'
    }
  }

  isTime() {
    return {
      valid: dayjs(new Date(getTime(this.value))).isValid(),
      message: 'Please enter a valid date'
    }
  }

  isDateTime() {
    return this.isDate();
  }

  isPhone() {
    var regex = /^\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})$/;
    return {
      valid: regex.test(this.value),
      message:  'Please enter a valid phone number'
    }
  }

  isPostalCode() {
    var regex = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;
    return {
      valid: regex.test(this.value),
      message: 'Please enter a valid postal code'
    }
  }

  isNumber() {
    var regex = /^[0-9]+$/;
    return {
      valid: regex.test(this.value),
      message: 'Please enter a valid number'
    }
  }

  // Column formats (COLUMN_FORMAT): int / long_int whole numbers, float /
  // decimal / double any decimal number. Signed: stock adjustments, discounts.
  // (`isIn` was a typo for `isInt`, so int fields were never checked, and
  // isFloat accepted only digits: "1.5" failed on a float field.)
  isInt() {
    return {
      valid: /^-?\d+$/.test(String(this.value).trim()),
      message: 'Please enter a whole number'
    }
  }

  isLong_int() {
    return this.isInt();
  }

  isFloat() {
    return {
      valid: /^-?\d+(?:\.\d+)?$/.test(String(this.value).trim()),
      message: 'Please enter a valid number'
    }
  }

  isDecimal() {
    return this.isFloat();
  }

  isDouble() {
    return this.isFloat();
  }

  isAlpha() {
    var regex = /^[a-zA-Z]+$/;
    return {
      valid: regex.test(this.value),
      message: 'Please enter a valid number'
    }
  }

  isAlphaNumeric() {
    var regex = /^[a-zA-Z0-9]+$/;
    return {
      valid: regex.test(this.value),
      message: 'Please enter a valid number'
    }
  }

  isAlphaDash() {
    var regex = /^[a-zA-Z0-9_\-]+$/;
    return {
      valid: regex.test(this.value),
      message: 'Please enter a valid number'
    }
  }

  isAlphaDashSpace() {
    var regex = /^[a-zA-Z0-9_\-\s]+$/;
    return {
      valid: regex.test(this.value),
      message: 'Please enter a valid number'
    }
  }

  isEmptyValue() {
    // 0 and false are real values (numeric/boolean fields), not "empty".
    if (this.value === 0 || this.value === false) return false;

    return typeof this.value === "undefined" ||
      this.value === null ||
      ["null", "undefined"].includes(this.value) ||
      (this.value || "").toString().trim().length === 0;
  }

  validatorRequired() {
    const required = [true, 'true', 1, '1'].includes(this.data.required);
    return {
      valid: !required || !this.isEmptyValue(),
      message: `${this.__label()} is required`
    }
  }

  validate() {
    const validatorRequired = this.validatorRequired();

    if (!validatorRequired.valid) {
      return this.#validatorMessage(validatorRequired);
    }

    // Accept both spellings: the designer's metaField switch is declared as
    // `not_validate_type` (input.jsx) while this check used `no_validate_type`.
    if (this.data.no_validate_type || this.data.not_validate_type) {
      return { valid: true, message: '' };
    }

    // An empty optional value has nothing to type-check: without this guard
    // an empty non-required email/phone/number field failed its format regex
    // ("'' is not a valid value...") and blocked the whole submission.
    if (this.isEmptyValue()) {
      return { valid: true, message: '' };
    }

    const validatorRules = this.validatorRules();

    // Keep the rule's specific message ("Invalid email address") and add the
    // field for context, instead of the raw "'<value>' is not a valid value".
    if (!validatorRules.valid) {
      validatorRules.message = validatorRules.message
        ? `${this.__label()}: ${validatorRules.message}`
        : `'${this.value}' is not a valid value in ${this.__label()}`;
    }

    return this.#validatorMessage(validatorRules);
  }

  #validatorMessage(validator) {
    return {
      valid: validator.valid,
      message: validator.message
    }
  }

  __label() {
    if (this.data.label) return this.data.label;
    const name = String(this.data.name || "").replace(/_/g, " ").trim();
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : "This field";
  }
}

export const dataInterface = (element, value) => {
  return new DataInterface(element, value);
}

global.ELEMENT_DEFINITION = function (element, or = null) {
  return (elementsDict[element] || elementsDict[or])?.def || new Error('Element ' + element + ' not found');
}

global.fieldIsWritable = (field) => {
  return elementsDict[field.element]?.def?.isWritable;
}

/**
 * Document contexts — allowlists by GROUP, not blacklists by element.
 *
 * One context describes what a document type can hold, and drives BOTH:
 *  - the AI structure generator (`aiGroups` + `extra`, minus `exclude`), and
 *  - the designer's element palette (`paletteGroups` + `extra`).
 *
 * The palette is a superset of the AI allowlist: a human may drag `system`
 * elements (id, padding, tailwind, designer…), the AI never authors them.
 * Any new element is therefore excluded from these documents by default
 * unless it lands in an allowed group — the inverse (and safer) failure
 * mode of the old SECTION/FORM blacklist.
 *
 * Document types with no matching context (pages): the palette shows every
 * group, and the AI gets everything minus the `system` group.
 */
const DOCUMENT_CONTEXTS = Object.freeze({
  form: {
    documentTypes: ["Form Builder", "Entity", "Contact Form Builder"],
    // Minimal structure a form needs: grid + tabs. No section/card/banner/etc.
    extra: ["row", "col", "tabs", "tab"],
    aiGroups: ["form"],
    paletteGroups: ["form", "system"],
  },
  print: {
    documentTypes: ["Print Format Builder"],
    extra: [],
    aiGroups: ["layout", "content", "print"],
    paletteGroups: ["layout", "content", "media", "print"],
  },
  desk: {
    documentTypes: ["Desk Page Builder"],
    extra: [],
    aiGroups: ["layout", "content", "desk"],
    paletteGroups: ["layout", "content", "media", "desk"],
  },
});

/** Groups that only a context listing them may offer (see ELEMENT_GROUPS.print). */
const isContextOnly = (group) => ELEMENT_GROUPS[group]?.contextOnly === true;

const contextFor = (document_type) =>
  Object.values(DOCUMENT_CONTEXTS)
    .find(c => c.documentTypes.includes(document_type)) || null;

const aiAllowedElements = (document_type) => {
  const ctx = contextFor(document_type);

  const allowed = new Set(ctx?.extra || []);
  for (const [el, { def }] of Object.entries(elementsDict)) {
    if (ctx ? ctx.aiGroups.includes(def.group) : (def.group !== "system" && !isContextOnly(def.group))) {
      allowed.add(el);
    }
  }
  for (const el of ctx?.exclude || []) allowed.delete(el);

  return elementsNames.filter(e => allowed.has(e));
};

/**
 * Grouped element definition for the designer sidebar, filtered by the
 * document being designed. Keeps elementsDefinition's group order and
 * element objects; groups left with no elements are dropped.
 */
export const paletteDefinition = (document_type) => {
  const ctx = contextFor(document_type);
  if (!ctx) {
    return Object.fromEntries(Object.entries(elementsDefinition).filter(([group]) => !isContextOnly(group)));
  }

  const groups = ctx.paletteGroups || ctx.aiGroups;
  const extra = new Set(ctx.extra || []);

  return Object.entries(elementsDefinition).reduce((acc, [group, elements]) => {
    const list = groups.includes(group)
      ? elements
      : elements.filter(e => extra.has(e.element));
    if (list.length) acc[group] = list;
    return acc;
  }, {});
};

// JSON Schema for the generated structure — one source for OpenAI structured
// outputs (json_schema) and Chrome's Prompt API (responseConstraint).
export const AIStructureSchema = (document_type) => {
  const elements = aiAllowedElements(document_type);
  const formats = [...new Set(Object.keys(inputType))];
  const nullable = (type) => ({ type: [type, "null"] });

  return {
    name: "doc_structure",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        elements: { type: "array", items: { "$ref": "#/$defs/element" } }
      },
      required: ["elements"],
      "$defs": {
        element: {
          type: "object",
          additionalProperties: false,
          properties: {
            element: { type: "string", enum: [...elements] },
            // node: only echoed back when editing an existing design; null for new elements
            node: nullable("string"),
            data: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                label: { type: "string" },
                format: { type: ["string", "null"], enum: [...formats, null] },
                options: nullable("string"),
                placeholder: nullable("string"),
                required: nullable("boolean")
              },
              required: ["name", "label", "format", "options", "placeholder", "required"]
            },
            elements: { type: "array", items: { "$ref": "#/$defs/element" } }
          },
          required: ["element", "node", "data", "elements"]
        }
      }
    }
  };
};

// Normalizes an AI-generated structure before it enters the designer: strips
// nulls/empties, coerces booleans to 1/0, drops duplicated node keys.
export const sanitizeAIStructure = (structure, seen = new Set()) => {
  if (!Array.isArray(structure)) return [];

  return structure.map((el) => {
    if (!el || typeof el !== "object" || !el.element) return null;

    const data = {};
    for (const [k, v] of Object.entries(el.data || {})) {
      if (v == null || v === "") continue;
      data[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
    }

    const out = { element: el.element, data };
    if (typeof el.node === "string" && el.node && !seen.has(el.node)) {
      out.node = el.node;
      seen.add(el.node);
    }

    const children = sanitizeAIStructure(el.elements || [], seen);
    if (children.length) out.elements = children;

    return out;
  }).filter(Boolean);
};

export const AIPrompt = (prompt, document_type, current = null) => {
  const exampleJSON = [
    {
      element: "row",
      elements: [
        {
          element: "col",
          elements: [
            {
              element: "input",
              data: {
                label: "Name",
                name: "name"
              }
            },
            {
              element: "input",
              data: {
                label: "Input 1",
                name: "input1"
              }
            }
          ]
        },
        {
          element: "col",
          elements: [
            {
              element: "input",
              data: {
                label: "Input 2",
                name: "input2"
              }
            },
            {
              element: "input",
              data: {
                label: "Input 3",
                name: "input3"
              }
            }
          ]
        }
      ],
    }
  ];

  const elements = aiAllowedElements(document_type);

  const editInstructions = current ? `
        You will receive the CURRENT design. Apply the request to it and return the FULL updated design:
        keep the "node" value of every element you keep, set "node" to null on new elements, and omit elements the request removes.` : "";

  const userContent = current
    ? `Current design:\n${JSON.stringify(current)}\n\nApply the following request to the current design:"${prompt}"`
    : `Resolve the following request:"${prompt}"`;

  return {
    system: {
      role: 'developer',
      content:
        `You are a strict JSON generator: example: ${JSON.stringify(exampleJSON)}. ALWAYS output valid JSON ONLY, nothing else (no commentary, no trailing commas, no explanation). If you cannot produce valid JSON, output {"error":"<short description>"} only.
        All elements MUST be objects with keys: "element" (string), data (object) {label, name}. If the element can have children, include an "elements" array. Follow the exact structure shown in examples.
        Use strict the following elements only: ${elements.join(",")}.
        If you need to use a element like: ${ [...new Set(Object.keys(inputType))].join(", ")} strict use element="input" and set format in data.format: ${ [...new Set(Object.keys(inputType))].join(", ")}.${editInstructions}
        `,
    },
    user: {
      content: userContent
    }
  }
}

export const GlobalEnvironment = () => {
  global.VALIDATION_ERROR = { code: 400, title: 'Validation error' };
  global.NOT_FOUND_ERROR = { code: 404, title: 'Not found' };
  global.INTERNAL_SERVER_ERROR = { code: 500, title: 'Internal server error' };
  global.UNAUTHORIZED_ERROR = { code: 401, title: 'Unauthorized' };
  global.FORBIDDEN_ERROR = { code: 403, title: 'Forbidden' };
  global.BAD_REQUEST_ERROR = { code: 400, title: 'Bad request' };
  global.CONFLICT_ERROR = { code: 409, title: 'Conflict' };
  global.NOT_ACCEPTABLE_ERROR = { code: 406, title: 'Not acceptable' };
  global.UNPROCESSABLE_ENTITY_ERROR = { code: 422, title: 'Unprocessable entity' };
  global.SERVICE_UNAVAILABLE_ERROR = { code: 503, title: 'Service unavailable' };
  global.INTERNAL_SERVER_ERROR = { code: 500, title: 'Internal server error' };
  global.NOT_IMPLEMENTED_ERROR = { code: 501, title: 'Not implemented' };
  global.GATEWAY_TIMEOUT_ERROR = { code: 504, title: 'Gateway timeout' };
  global.UNSUPPORTED_MEDIA_TYPE_ERROR = { code: 415, title: 'Unsupported media type' };
  global.LENGTH_REQUIRED_ERROR = { code: 411, title: 'Length required' };
  global.REQUEST_ENTITY_TOO_LARGE_ERROR = { code: 413, title: 'Request entity too large' };
  global.REQUEST_URI_TOO_LONG_ERROR = { code: 414, title: 'Request URI too long' };
}