'use strict';

import { loopar, generateThemeCSS, normalizeBrand } from 'loopar';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Normalized theme config from the ThemeCustomizer JSON (null when unset). */
export function parseThemeConfig(raw) {
  const config = loopar.utils.JSONparse(raw, {}) || {};
  if (!config.theme) return null;
  return {
    theme: config.theme,
    darkMode: ['auto', 'custom'].includes(config.darkMode) ? config.darkMode : 'auto',
    darkIntensity: clamp(config.darkIntensity ?? 0.95, 0, 1),
    darkCustomColor: config.darkCustomColor || '#0a0a0a',
    includeTitles: config.includeTitles !== false,
    brand: normalizeBrand(config.brand),
  };
}

/** Minified CSS for a theme config, or null when no theme is set. */
export function buildThemeCSS(raw, { fallbackTheme = null } = {}) {
  const config = parseThemeConfig(raw) || (fallbackTheme ? parseThemeConfig(JSON.stringify({ theme: fallbackTheme })) : null);
  if (!config) return null;
  return generateThemeCSS(config.theme, {
    darkMode: config.darkMode,
    darkIntensity: config.darkIntensity,
    darkCustomColor: config.darkCustomColor,
    includeTitles: config.includeTitles,
    brand: config.brand,
    minify: true,
    contrastThreshold: 4.5,
  });
}
