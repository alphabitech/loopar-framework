'use strict';

import { loopar, generateThemeCSS, normalizeBrand, getCompany, COMPANY_THEME } from 'loopar';

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

/**
 * Minified CSS for a theme config, or null when no theme is set.
 * A "company" theme is the custom palette of `companyBrand`; without a brand
 * color it falls back to `fallbackTheme` (or slate).
 */
export function buildThemeCSS(raw, { fallbackTheme = null, companyBrand = null } = {}) {
  const config = parseThemeConfig(raw) || (fallbackTheme ? parseThemeConfig(JSON.stringify({ theme: fallbackTheme })) : null);
  if (!config) return null;
  if (config.theme === COMPANY_THEME) {
    const brand = normalizeBrand(companyBrand);
    config.theme = brand ? 'custom' : (fallbackTheme || 'slate');
    config.brand = brand;
  }
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

/** True when a theme config follows the Company brand. */
export const usesCompanyBrand = (raw) => parseThemeConfig(raw)?.theme === COMPANY_THEME;

/** buildThemeCSS, reading the Company brand when the theme follows it. */
export async function themeCSS(raw, options = {}) {
  const companyBrand = usesCompanyBrand(raw) ? (await getCompany())?.brand || null : null;
  return buildThemeCSS(raw, { ...options, companyBrand });
}
