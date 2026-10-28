import { themes } from './themes.js';
import chroma from 'chroma-js';

export const NEUTRAL_THEMES = ['slate', 'gray', 'zinc', 'neutral', 'stone'];

/** Theme name of a palette built from the site's own brand colors. */
export const CUSTOM_THEME = 'custom';

const validHex = (value) => {
  if (typeof value !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())) return null;
  return value.trim().toLowerCase();
};

/**
 * Brand colors of a custom theme: `primary` is required, `accent`,
 * `background` and `foreground` (light mode) are optional. Null when the
 * primary is missing or invalid.
 */
export function normalizeBrand(brand) {
  const primary = validHex(brand?.primary);
  if (!primary) return null;
  return {
    primary,
    accent: validHex(brand.accent),
    background: validHex(brand.background),
    foreground: validHex(brand.foreground),
  };
}

const presetColor = (themeName) => (themes.find(t => t.name === themeName) || themes.find(t => t.name === 'blue')).color;

/** Base color of a theme: the brand primary for a custom theme, else the preset's. */
export function themeBaseColor(themeName, brand = null) {
  const custom = themeName === CUSTOM_THEME ? normalizeBrand(brand) : null;
  return custom?.primary || presetColor(themeName);
}

export function isNeutralTheme(themeName, color = null) {
  if (NEUTRAL_THEMES.includes(themeName)) {
    return true;
  }
  
  if (color) {
    const base = chroma(color);
    return base.get('hsl.s') < 0.15;
  }
  
  return false;
}

export function generateThemeCSS(themeName, options = {}) {
  const {
    includeTitles = true,
    minify = false,
    contrastThreshold = 4.5,
    darkMode = 'auto',
    darkIntensity = 0.95,
    darkCustomColor = null,
    brand = null
  } = options;

  const custom = themeName === CUSTOM_THEME ? normalizeBrand(brand) : null;
  const baseTextHex = themeBaseColor(themeName, custom);

  let darkBgColor;
  if (darkMode === 'custom' && darkCustomColor) {
    darkBgColor = applyIntensityToColor(darkCustomColor, darkIntensity);
  } else {
    darkBgColor = deriveDarkBackground(baseTextHex, darkIntensity);
  }

  const lightMode = generateLightModeColors(baseTextHex, contrastThreshold, themeName);
  if (custom) applyBrandToLightMode(lightMode, custom, contrastThreshold);
  const darkMode_colors = generateDarkModeColors(
    darkBgColor,
    baseTextHex,
    themeName,
    contrastThreshold
  );

  return buildCSS(lightMode, darkMode_colors, includeTitles, minify);
}

function applyIntensityToColor(color, intensity = 0.95) {
  if (intensity === 0) {
    return '#000000';
  }
  
  const base = chroma(color);
  const h = base.get('hsl.h') || 0;
  const s = base.get('hsl.s');
  
  const targetLightness = intensity * 0.20;
  
  return chroma.hsl(h, s, targetLightness).hex();
}

function deriveDarkBackground(themeColor, intensity = 0.95) {
  if (intensity === 0) {
    return '#000000';
  }
  
  const base = chroma(themeColor);
  const isNeutral = base.get('hsl.s') < 0.15;
  
  const h = base.get('hsl.h') || 0;
  const s = base.get('hsl.s');
  
  const targetLightness = intensity * 0.20;
  
  if (isNeutral) {
    return chroma.hsl(h, s * 0.5, targetLightness).hex();
  } else {
    return chroma.hsl(h, s * 0.7, targetLightness).hex();
  }
}

function generateLightModeColors(baseTextHex, contrastThreshold, themeName) {
  const background = chroma('white').alpha(1);
  
  const baseColor = chroma(baseTextHex);
  const isNeutral = isNeutralTheme(themeName, baseTextHex);
  
  let text;
  if (isNeutral) {
    text = baseColor.darken(2.5).alpha(1);
  } else {
    text = chroma.mix('#09090b', baseTextHex, 0.15, 'rgb').alpha(1);
  }
  
  if (chroma.contrast(text, background) < contrastThreshold) {
    text = chroma('#09090b').alpha(1);
  }
  
  let card;
  if (isNeutral) {
    card = baseColor.brighten(3.5).desaturate(0.5).alpha(1);
  } else {
    card = chroma.mix('#fafafa', baseTextHex, 0.03, 'rgb').alpha(1);
  }
  
  let primary = baseColor.alpha(1);
  let primaryContrast = chroma.contrast(primary, background);
  if (primaryContrast < contrastThreshold) {
    let darkenAmount = 0;
    while (primaryContrast < contrastThreshold && darkenAmount < 2.5) {
      darkenAmount += 0.15;
      primary = baseColor.darken(darkenAmount).saturate(0.3).alpha(1);
      primaryContrast = chroma.contrast(primary, background);
    }
  }
  
  const primaryForeground = chroma.contrast(primary, 'white') >= contrastThreshold 
    ? chroma('white').alpha(1)
    : chroma('black').alpha(1);

  const primaryHue = primary.get('hsl.h');
  const secondaryHue = isNaN(primaryHue) ? 0 : (primaryHue + 30) % 360;
  const secondary = chroma.hsl(secondaryHue, 0.048, 0.959).alpha(1);
  const secondaryForeground = text;

  const popover = chroma.mix('white', baseTextHex, 0.02, 'rgb').alpha(1);
  const border = chroma.mix('#e5e7eb', baseTextHex, 0.08, 'rgb').alpha(1);

  return {
    background,
    foreground: text,
    card,
    cardForeground: text,
    popover,
    popoverForeground: text,
    primary,
    primaryForeground,
    secondary,
    secondaryForeground,
    muted: secondary,
    mutedForeground: chroma.mix('#71717a', baseTextHex, 0.15, 'rgb').alpha(1),
    accent: secondary,
    accentForeground: secondaryForeground,
    destructive: chroma.hsl(0, 0.842, 0.602).alpha(1),
    destructiveForeground: chroma('white').alpha(1),
    border,
    input: border,
    ring: primary
  };
}

function generateDarkModeColors(bgColor, baseTextHex, themeName, contrastThreshold) {
  const isCustom = themeName === CUSTOM_THEME;
  const background = chroma(bgColor).alpha(1);
  const baseColor = chroma(baseTextHex);
  const isNeutral = isNeutralTheme(themeName, baseTextHex);
  
  const text = chroma('#fafafa').alpha(1);
  
  let card;
  if (isNeutral) {
    card = background.darken(0.15).alpha(1);
  } else {
    card = chroma.mix(background.hex(), baseTextHex, 0.05, 'rgb').darken(0.1).alpha(1);
  }
  
  let primary;
  if (isNeutral) {
    primary = chroma('#f5f5f5').alpha(1);
  } else {
    primary = baseColor.saturate(0.5).alpha(1);
    // A deep brand color would vanish on the dark background: lighten it
    // (same hue) until it reads. Presets keep their tuned colors.
    for (let i = 0; isCustom && i < 20 && chroma.contrast(primary, background) < contrastThreshold; i++) {
      primary = primary.brighten(0.25).alpha(1);
    }
  }
  
  const primaryLuminance = primary.luminance();
  const primaryForeground = primaryLuminance > 0.5
    ? chroma('black').alpha(1)
    : chroma('white').alpha(1);

  const primaryHue = primary.get('hsl.h');
  const secondaryHue = isNaN(primaryHue) ? 0 : (primaryHue + 30) % 360;
  const secondary = chroma.hsl(secondaryHue, 0.065, 0.151).alpha(1);

  const popover = chroma.mix(background.hex(), baseTextHex, 0.03, 'rgb').alpha(1);
  const border = chroma.mix(background.hex(), baseTextHex, 0.1, 'rgb').brighten(0.2).alpha(1);

  return {
    background,
    foreground: text,
    card,
    cardForeground: text,
    popover,
    popoverForeground: text,
    primary,
    primaryForeground,
    secondary,
    secondaryForeground: text,
    muted: secondary,
    mutedForeground: chroma('#a1a1aa').alpha(1),
    accent: secondary,
    accentForeground: text,
    destructive: chroma.hsl(0, 0.722, 0.506).alpha(1),
    destructiveForeground: chroma('white').alpha(1),
    border,
    input: border,
    ring: primary
  };
}

/** Light-mode tokens a custom brand sets (accent, background, text). */
function applyBrandToLightMode(colors, brand, contrastThreshold) {
  const readableOn = (bg) => (chroma.contrast('white', bg) >= chroma.contrast('#09090b', bg) ? chroma('white') : chroma('#09090b')).alpha(1);

  if (brand.background) {
    const background = chroma(brand.background).alpha(1);
    colors.background = background;
    colors.card = chroma.mix(brand.background, 'white', 0.55, 'rgb').alpha(1);
    colors.popover = colors.card;
    colors.border = chroma.mix(brand.background, brand.primary, 0.12, 'rgb').darken(0.2).alpha(1);
    colors.input = colors.border;
    colors.muted = chroma.mix(brand.background, brand.primary, 0.06, 'rgb').alpha(1);
  }

  if (brand.foreground && chroma.contrast(brand.foreground, colors.background) >= contrastThreshold) {
    const text = chroma(brand.foreground).alpha(1);
    colors.foreground = text;
    colors.cardForeground = text;
    colors.popoverForeground = text;
    colors.mutedForeground = chroma.mix(brand.foreground, colors.background.hex(), 0.2, 'rgb').alpha(1);
    if (chroma.contrast(colors.mutedForeground, colors.background) < contrastThreshold) colors.mutedForeground = text;
  }

  if (brand.accent) {
    const accent = chroma(brand.accent).alpha(1);
    const onAccent = brand.foreground && chroma.contrast(brand.foreground, accent) >= contrastThreshold
      ? chroma(brand.foreground).alpha(1)
      : readableOn(accent);
    colors.secondary = accent;
    colors.secondaryForeground = onAccent;
    colors.accent = accent;
    colors.accentForeground = onAccent;
  }
}

function toHSLString(color) {
  let h = color.get('hsl.h');
  if (isNaN(h)) h = 0;
  
  const s = color.get('hsl.s') * 100;
  const l = color.get('hsl.l') * 100;
  
  return `${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%`;
}

function buildCSS(lightMode, darkMode, includeTitles, minify) {
  const lightVars = generateCSSVariables(lightMode);
  const darkVars = generateCSSVariables(darkMode);
  
  const titleStyles = includeTitles
    ? generateTitleStyles()
    : '';

  if (minify) {
    return minifyCSS(`
      :root{${lightVars}}
      .dark{${darkVars}}
      ${titleStyles}
    `);
  }

  return `
:root {
${indent(lightVars, 2)}
}

.dark {
${indent(darkVars, 2)}
}
${titleStyles}
`.trim();
}

function generateCSSVariables(colors) {
  const variables = [
    ['--background', colors.background],
    ['--foreground', colors.foreground],
    ['--card', colors.card],
    ['--card-foreground', colors.cardForeground],
    ['--popover', colors.popover],
    ['--popover-foreground', colors.popoverForeground],
    ['--primary', colors.primary],
    ['--primary-foreground', colors.primaryForeground],
    ['--secondary', colors.secondary],
    ['--secondary-foreground', colors.secondaryForeground],
    ['--muted', colors.muted],
    ['--muted-foreground', colors.mutedForeground],
    ['--accent', colors.accent],
    ['--accent-foreground', colors.accentForeground],
    ['--destructive', colors.destructive],
    ['--destructive-foreground', colors.destructiveForeground],
    ['--border', colors.border],
    ['--input', colors.input],
    ['--ring', colors.ring],
    ['--radius', '0.5rem']
  ];

  return variables
    .map(([prop, value]) => {
      const colorValue = typeof value === 'string' ? value : toHSLString(value);
      return `${prop}: ${colorValue};`;
    })
    .join('\n');
}

function generateTitleStyles() {
  const opacities = [95, 85, 75, 65, 55, 45];
  const rules = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
    .map((tag, i) => `${tag}{color:hsl(var(--foreground)/${opacities[i]}%)}`)
    .join('');
  // In @layer base so they stay defaults: unlayered rules beat every
  // Tailwind utility (those live in @layer utilities), which made classes
  // like `text-primary` on a title/subtitle silently lose to these colors.
  return `@layer base{${rules}}`;
}

function indent(text, spaces) {
  const indentation = ' '.repeat(spaces);
  return text
    .split('\n')
    .map(line => line.trim() ? indentation + line : line)
    .join('\n');
}

function minifyCSS(css) {
  return css
    .replace(/\s+/g, ' ')
    .replace(/\s*{\s*/g, '{')
    .replace(/\s*}\s*/g, '}')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s*;\s*/g, ';')
    .replace(/;\s*}/g, '}')
    .trim();
}

export function generateThemeVariations(options = {}) {
  const availableThemes = themes.map(t => t.name);
  
  return availableThemes.reduce((acc, themeName) => {
    acc[themeName] = generateThemeCSS(themeName, options);
    return acc;
  }, {});
}

export function isValidColor(color) {
  try {
    chroma(color);
    return true;
  } catch (e) {
    return false;
  }
}

export function getContrast(color1, color2) {
  try {
    return chroma.contrast(color1, color2);
  } catch (e) {
    return 0;
  }
}

export function previewDarkBackground(themeName, intensity = 0.95, mode = 'auto', customColor = null, brand = null) {
  if (mode === 'custom' && customColor) {
    return applyIntensityToColor(customColor, intensity);
  }

  return deriveDarkBackground(themeBaseColor(themeName, brand), intensity);
}