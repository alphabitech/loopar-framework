import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __, interpolate, normalizeLanguage, baseLanguage, parseLanguageList,
  languageName, setI18nProvider, currentLanguage,
} from "../../packages/loopar/core/global/i18n.js";

const withProvider = (language, messages, fn) => {
  const prev = globalThis.__LOOPAR_I18N_PROVIDER__;
  setI18nProvider({ language: () => language, messages: () => messages });
  try { fn(); } finally { globalThis.__LOOPAR_I18N_PROVIDER__ = prev; }
};

test("normalizes language codes", () => {
  assert.equal(normalizeLanguage(" ES_mx "), "es-mx");
  assert.equal(normalizeLanguage("En"), "en");
  assert.equal(normalizeLanguage("../etc"), null);
  assert.equal(normalizeLanguage(""), null);
  assert.equal(baseLanguage("es-mx"), "es");
  assert.equal(baseLanguage("es"), null);
});

test("parses language lists", () => {
  assert.deepEqual(parseLanguageList("es, pt\nES, xx-!"), ["es", "pt"]);
  assert.deepEqual(parseLanguageList(["en:English", "es"]), ["en", "es"]);
  assert.deepEqual(parseLanguageList(null), []);
});

test("interpolates positional and named placeholders", () => {
  assert.equal(interpolate("{0} of {1}", [1, 2]), "1 of 2");
  assert.equal(interpolate("Hi {name}", { name: "Ana" }), "Hi Ana");
  assert.equal(interpolate("Keep {missing}", {}), "Keep {missing}");
});

test("__ translates with fallback to the source text", () => {
  withProvider("es", { Save: "Guardar", "{0} is required": "{0} es obligatorio", Empty: "" }, () => {
    assert.equal(currentLanguage(), "es");
    assert.equal(__("Save"), "Guardar");
    assert.equal(__("{0} is required", ["Name"]), "Name es obligatorio");
    assert.equal(__("Untranslated"), "Untranslated");
    assert.equal(__("Empty"), "Empty");
    assert.equal(__(null), null);
    assert.equal(__(42), 42);
  });
});

test("__ without a dictionary returns the source", () => {
  withProvider("en", null, () => assert.equal(__("Save {0}", ["x"]), "Save x"));
});

test("language names", () => {
  assert.equal(languageName("es"), "Español");
  assert.equal(languageName("es-mx"), "Español");
  assert.equal(languageName("xx"), "xx");
});
