/**
 * The Site Theming SDK, browser side: a website describes how it would like Web Roamer to look
 * (<meta name="roamer-theme"> or window.roamer.theme.set(), see docs/SITE-THEMING.md) and this file turns that into the
 * chrome's colours. Everything a site sends is checked here: only known keys, only plain colours and a few named
 * choices, and text is always kept readable. A site can never touch the address bar's contents, the security icon,
 * the browser's own pages or any other tab.
 */

const KEYS = ['accent', 'background', 'surface', 'text', 'scheme', 'pattern', 'shape', 'font', 'frame', 'tabShape', 'tabStyle', 'shadow', 'border', 'density'];
export const PATTERNS = ['topo', 'grid', 'dots', 'lines', 'none'];
export const SHAPES = ['chamfer', 'square', 'round', 'pill', 'slant'];
export const TAB_SHAPES = [...SHAPES, 'notch'];
export const TAB_STYLES = ['solid', 'outline', 'glow', 'underline'];
export const SHADOWS = ['hard', 'soft', 'none'];
export const BORDERS = ['none', 'thin', 'normal', 'thick'];
export const DENSITIES = ['compact', 'cozy', 'roomy'];
export const FONTS = {
  display: "'Bricolage Grotesque', 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif",
  sans: "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif",
  mono: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  rounded: "'Nunito', 'Varela Round', 'Segoe UI Rounded', 'Arial Rounded MT Bold', 'Segoe UI', system-ui, sans-serif",
  condensed: "'Bahnschrift SemiCondensed', 'Roboto Condensed', 'Arial Narrow', 'Segoe UI', system-ui, sans-serif",
  slab: "'Rockwell', 'Roboto Slab', 'Courier New', Georgia, serif",
  hand: "'Segoe Print', 'Bradley Hand', 'Chalkboard SE', 'Comic Sans MS', cursive",
};

// ------------------------------------------------------------ colours
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([0-9a-z.,%\s/+-]{1,60}\)|[a-z]{3,20})$/i;
const cv = document.createElement('canvas');
cv.width = cv.height = 1;
const cx = cv.getContext('2d', { willReadFrequently: true });

/** [r, g, b] (0-255) of a CSS colour, or null when it isn't a plain colour. */
export function rgbOf(v) {
  if (typeof v !== 'string') return null;
  v = v.trim();
  if (!COLOR_RE.test(v) || /^(transparent|currentcolor|inherit|initial|unset|revert)$/i.test(v)) return null;
  if (window.CSS?.supports && !CSS.supports('color', v)) return null;
  cx.clearRect(0, 0, 1, 1);
  cx.fillStyle = '#000';
  cx.fillStyle = v;
  cx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data;
  if (a < 8) return null;
  return [r, g, b];
}
const hex = ([r, g, b]) => '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const lum = (c) => {
  const [r, g, b] = c.map((x) => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Move `c` toward `to` until it stands out from `bg` by `min`. */
function lift(c, bg, to, min) {
  for (let t = 0; t <= 1.0001 && contrast(c, bg) < min; t += 0.08) c = mix(c, to, 0.08);
  return c;
}

// ------------------------------------------------------------ checking what a site sent
/** Only the keys and values this browser understands; null when nothing usable is left. */
export function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (v == null) continue;
    if (['accent', 'background', 'surface', 'text'].includes(k)) {
      if (rgbOf(v)) t[k] = String(v).trim();
    } else if (k === 'scheme') {
      if (v === 'dark' || v === 'light') t[k] = v;
    } else if (k === 'pattern') {
      if (PATTERNS.includes(v)) t[k] = v;
    } else if (k === 'shape' || k === 'tabShape' || k === 'tabStyle' || k === 'shadow' || k === 'border' || k === 'density') {
      const list = { shape: SHAPES, tabShape: TAB_SHAPES, tabStyle: TAB_STYLES, shadow: SHADOWS, border: BORDERS, density: DENSITIES }[k];
      if (list.includes(v)) t[k] = v;
    } else if (k === 'font') {
      if (FONTS[v]) t[k] = v;
    } else if (k === 'frame') {
      if (typeof v === 'boolean' || v === 'true' || v === 'false') t[k] = v === true || v === 'true';
    }
  }
  return Object.keys(t).length ? t : null;
}

// ------------------------------------------------------------ turning a theme into the chrome's colours
const VARS = ['--f-mono', '--bg', '--bg2', '--bg3', '--line', '--line2', '--ink', '--dim', '--faint', '--accent', '--accent-ink', '--hot', '--topo-rgb', '--topo-op', '--shade', '--f-display'];

/**
 * CSS custom properties for a (sanitized) theme. `base` is the browser's own accent, used when the site sets none.
 */
export function palette(t, base) {
  const out = {};
  const bgIn = rgbOf(t.background);
  const acIn = rgbOf(t.accent) || base;
  if (bgIn) {
    // the backdrop decides dark or light; `scheme` only settles the in-between greys
    const L = lum(bgIn);
    const dark = L < 0.12 || (L < 0.3 && t.scheme !== 'light');
    const bg = bgIn;
    const toward = dark ? [255, 255, 255] : [0, 0, 0];
    const surf = rgbOf(t.surface);
    const bg2 = surf && Math.abs(lum(surf) - lum(bg)) < 0.25 ? surf : mix(bg, toward, 0.05);
    const bg3 = mix(bg2, toward, 0.07);
    let ink = rgbOf(t.text) || (dark ? [240, 244, 234] : [28, 34, 30]);
    if (contrast(ink, bg) < 7) ink = lift(ink, bg, toward, 7);
    const dim = lift(mix(ink, bg, 0.28), bg, toward, 4.5);
    const faint = lift(mix(ink, bg, 0.48), bg, toward, 3);
    Object.assign(out, {
      '--bg': hex(bg), '--bg2': hex(bg2), '--bg3': hex(bg3), '--ink': hex(ink), '--dim': hex(dim), '--faint': hex(faint),
      '--line': `rgb(${ink.map(Math.round).join(' ')} / .12)`, '--line2': `rgb(${ink.map(Math.round).join(' ')} / .24)`,
      '--shade': `rgb(${bg.map((x) => Math.round(x * 0.5)).join(' ')} / .6)`,
      '--hot': dark ? '#ff7a59' : '#c2410c',
    });
    out.scheme = dark ? 'dark' : 'light';
    if (acIn) {
      const ac = lift(acIn, bg, ink, 2.6);
      out['--accent'] = hex(ac);
      out['--accent-ink'] = contrast([0, 0, 0], ac) > contrast([255, 255, 255], ac) ? '#0b0f0c' : '#ffffff';
      out['--topo-rgb'] = ac.map(Math.round).join(' ');
    }
  } else if (rgbOf(t.accent)) {
    // only an accent: it has to read against the browser's own backdrop
    const bg = rgbOf(getComputedStyle(document.documentElement).getPropertyValue('--bg')) || [16, 26, 28];
    const ink = lum(bg) < 0.2 ? [255, 255, 255] : [0, 0, 0];
    const ac = lift(acIn, bg, ink, 2.6);
    out['--accent'] = hex(ac);
    out['--accent-ink'] = contrast([0, 0, 0], ac) > contrast([255, 255, 255], ac) ? '#0b0f0c' : '#ffffff';
    out['--topo-rgb'] = ac.map(Math.round).join(' ');
  }
  if (t.font) {
    out['--f-display'] = FONTS[t.font];
    if (t.font === 'mono') out['--f-mono'] = FONTS.mono;
  }
  return out;
}

/** Dress the chrome in a site's look, or (theme null) take it off again. */
export function apply(root, theme) {
  for (const k of VARS) root.style.removeProperty(k);
  root.style.removeProperty('color-scheme');
  delete root.dataset.sitePattern;
  delete root.dataset.siteShape;
  delete root.dataset.siteFrame;
  for (const k of ['siteShadow', 'siteBorder', 'siteDensity']) delete root.dataset[k];
  root.classList.toggle('site-look', !!theme);
  if (!theme) return;
  const base = rgbOf(getComputedStyle(root).getPropertyValue('--accent'));
  const p = palette(theme, base);
  for (const [k, v] of Object.entries(p)) if (k.startsWith('--')) root.style.setProperty(k, v);
  if (p.scheme) root.style.setProperty('color-scheme', p.scheme);
  if (theme.pattern) root.dataset.sitePattern = theme.pattern;
  if (theme.shape) root.dataset.siteShape = theme.shape;
  if (theme.frame != null) root.dataset.siteFrame = theme.frame ? 'on' : 'off';
  if (theme.shadow) root.dataset.siteShadow = theme.shadow;
  if (theme.border) root.dataset.siteBorder = theme.border;
  if (theme.density) root.dataset.siteDensity = theme.density;
}

/**
 * How a tab dresses itself in its site's look, whether or not it is the one being viewed:
 * {style: CSS custom properties, shape, tabStyle}. The tab only ever changes its own colours, shape and type.
 */
export function tabLook(theme, base) {
  if (!theme) return null;
  const p = palette(theme, base);
  const style = {};
  if (p['--bg3']) (style['--tb-bg'] = p['--bg3']), (style['--tb-bg2'] = p['--bg2']), (style['--tb-ink'] = p['--ink']), (style['--tb-dim'] = p['--dim']);
  if (p['--accent']) style['--tb-acc'] = p['--accent'];
  if (theme.font) style['--tb-font'] = FONTS[theme.font];
  const shape = theme.tabShape || (theme.shape && theme.shape !== 'chamfer' ? theme.shape : '');
  if (!Object.keys(style).length && !shape && !theme.tabStyle) return null;
  return { style, shape, tabStyle: theme.tabStyle || '' };
}

/** A short description of a theme, for the "this site has a look" offer. */
export function describe(t) {
  const bits = [];
  if (t.background) bits.push((lum(rgbOf(t.background)) < 0.2 ? 'dark' : 'light') + ' backdrop');
  if (t.accent) bits.push('accent colour');
  if (t.pattern && t.pattern !== 'topo') bits.push(t.pattern === 'none' ? 'no pattern' : t.pattern + ' pattern');
  if (t.font && t.font !== 'display') bits.push(t.font + ' type');
  if (t.shape && t.shape !== 'chamfer') bits.push(t.shape + ' shapes');
  if (t.tabShape || t.tabStyle) bits.push('its own tab');
  return bits.join(' · ');
}

/** The swatches to preview a theme with: [backdrop, surface, accent]. */
export function swatches(t) {
  const base = rgbOf(getComputedStyle(document.documentElement).getPropertyValue('--accent'));
  const p = palette(t, base);
  return [p['--bg'], p['--bg3'], p['--accent']].filter(Boolean);
}
