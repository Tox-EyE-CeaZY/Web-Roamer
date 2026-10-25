# Site Theming SDK

Web Roamer lets a website suggest how the browser around it should look while you're on it: the backdrop, the
accent colour, the pattern behind the interface, the shapes of things, its own tab and the typeface. The look
starts at the site's tab and spreads out over the rest of the browser. It is **opt-in on both sides**: the
site has to describe a look, and the person browsing decides whether sites may use it (Settings → Site looks:
*Never*, *Ask* (the default) or *Always*, plus Allow/Block per site).

Other browsers simply ignore all of this, so it is safe to ship on any site.

## The quick way: one meta tag

```html
<meta name="roamer-theme" content='{"background":"#14101f","accent":"#ff5fa2","pattern":"dots"}'>
```

`content` is JSON. For hand-written tags a `key: value; key: value` form works too:

```html
<meta name="roamer-theme" content="background: #14101f; accent: #ff5fa2; pattern: dots">
```

Changing or replacing the tag later (for a dark/light switch on your site) updates the browser straight away.

## From JavaScript

Web Roamer puts a small, frozen `window.roamer` object in every page before your scripts run:

```js
if (window.roamer) {
  roamer.theme.set({ background: '#0d1b2a', accent: '#4cc9f0', font: 'sans' });
  // ...later
  roamer.theme.clear(); // back to the meta tag (if any), or to no look at all
}
```

`roamer.theme.set()` wins over the meta tag. A `roamer:ready` event fires on `window` once the page is parsed.

Prefer not to think about detection? Include [`sdk/roamer-theme.js`](../sdk/roamer-theme.js): it does the
detection, keeps a meta tag in step for you, and follows `prefers-color-scheme` if you give it two looks:

```html
<script src="roamer-theme.js"></script>
<script>
  RoamerTheme.apply({
    dark:  { background: '#101418', accent: '#7cf29c' },
    light: { background: '#f6f2ea', accent: '#2f7d4f' },
  });
</script>
```

## What a look can say

| Key | Values | What it does |
| --- | --- | --- |
| `background` | a colour | The backdrop of the whole browser: title bar, tabs, toolbar, menus. Panels and lines are derived from it. |
| `surface` | a colour | Optional: panels and fields. Ignored when too far from `background` to read as one theme. |
| `accent` | a colour | Highlights: the active tab, focus rings, buttons, the contour lines. |
| `text` | a colour | Optional: the main text colour. |
| `scheme` | `dark` \| `light` | Optional hint for mid-grey backgrounds. Normally worked out from `background`. |
| `pattern` | `topo` \| `grid` \| `dots` \| `lines` \| `none` | What sits behind the interface (`topo` is Web Roamer's contour map). |
| `shape` | `chamfer` \| `square` \| `round` \| `pill` \| `slant` | The shape of the address bar, buttons, panels and menus. `chamfer` is Web Roamer's cut corner. |
| `tabShape` | `chamfer` \| `square` \| `round` \| `pill` \| `slant` \| `notch` | The shape of **your tab**. Defaults to `shape`. |
| `tabStyle` | `solid` \| `outline` \| `glow` \| `underline` | How your tab is drawn: filled (the default), just an outline, a lit-from-inside glow, or a plain underline. |
| `shadow` | `hard` \| `soft` \| `none` | The shadow under the framed page: Web Roamer's hard offset one, a soft glow, or none. |
| `border` | `none` \| `thin` \| `normal` \| `thick` | How heavy the lines around panels and the page are. |
| `density` | `compact` \| `cozy` \| `roomy` | How much room the interface takes: smaller type and tabs, or larger. |
| `font` | `display` \| `sans` \| `serif` \| `mono` \| `rounded` \| `condensed` \| `slab` \| `hand` | The interface typeface, from fonts already on the computer (each name is a list of common fonts, with a fallback). |
| `frame` | `true` \| `false` | Whether your page sits in a framed well or fills the window edge to edge. |

Colours can be `#rgb`, `#rrggbb`, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()` or a colour
name. Anything else (other keys, `url()`, `var()`, gradients, images, longer strings) is dropped without a word.

Sites that only have the standard `<meta name="theme-color">` can tint the browser too, when the person turns on
*Tint with a site's theme colour*. A `roamer-theme` look takes precedence.

## What Web Roamer guarantees (and what you can't do)

- **Readable, always.** Text is pushed until it reaches at least 7:1 contrast with your background, secondary text
  4.5:1, and the accent 2.6:1. You choose the colours; the browser keeps them legible.
- **Only your tab.** Your **tab** always wears your colours, shape and style, even when it is in the background, so
  several themed sites sit side by side in the tab bar. The rest of the browser takes your look only while your page
  is the focused tab (or the focused page of a desktop) and gives it back the moment someone switches away, spreading
  out from the tab when it arrives and again when it leaves. It never reaches Web Roamer's own pages (start,
  settings, history...). People can turn the spreading animation off (Settings → Site looks) and it is skipped for
  anyone who asks their system for reduced motion.
- **No code.** A look is data: a short list of named choices and plain colours. Nothing a site sends is ever run
  by the browser, no styles or markup are accepted, and unknown or malformed values are dropped.
- **No disguises.** A look cannot change the address bar's text, the lock/not-secure icon, the window buttons,
  menus' contents or any wording. There is no way to add text, images or links to the browser.
- **Same origin only.** A look belongs to the origin of the page that set it, and it's checked against the tab's real
  address on the native side, not what the page claims.
- **The person decides.** In *Ask* mode a paintbrush appears in the address bar; nothing changes until they press
  *Use this look*. They can block a site at any time from the site info panel (the lock) or Settings → Site looks.

## Try it

Open [`docs/theme-demo.html`](theme-demo.html) in Web Roamer (drag it onto the window or open it as a `file://`
address). It has buttons for a few looks and shows what Web Roamer reports back.
