# Prompt for the Flavion project: a Web Roamer look

Paste everything below the line into your Flavion project.

---

I want Flavion sites to be able to dress **Web Roamer** (a small desktop browser) in the site's own look. Web Roamer has a
Site Theming SDK: a page describes a look, and Web Roamer shows it on the page's **tab** and then lets it spread from the
tab over the rest of the browser: colours, shapes, tab style, type. Other browsers ignore it, so it is safe to ship everywhere.
The people browsing decide whether sites may style the browser (Never / Ask / Always, per site).

Please add a **Web Roamer look** feature to Flavion:

1. **A look in the design tokens.** Flavion already has colours, type and shape choices. Add one place, a `roamer` section
   (or whatever fits Flavion's config), that maps those onto the Web Roamer look below, with sensible defaults taken from
   the site's own theme. If the site has light and dark modes, produce both and let the browser pick with `prefers-color-scheme`.
2. **Output.** Put this in the page's `<head>` on every page, as JSON in one meta tag:

   ```html
   <meta name="roamer-theme" content='{"background":"#14101f","accent":"#ff5fa2","text":"#f2ecff","pattern":"dots","shape":"slant","tabShape":"slant","tabStyle":"glow","font":"rounded"}'>
   ```

   For sites that switch themes at runtime, also include Web Roamer's small helper (`sdk/roamer-theme.js` in
   https://github.com/Tox-EyE-CeaZY/Web-Roamer) and call `RoamerTheme.apply({dark: {...}, light: {...}})`, or call
   `window.roamer.theme.set({...})` when `window.roamer` exists. `roamer.theme.clear()` removes the look.
3. **The keys Web Roamer understands** (anything else is dropped, never run):

   | Key | Values |
   | --- | --- |
   | `background`, `surface`, `accent`, `text` | a plain colour: `#rgb`, `#rrggbb`, `rgb()`, `hsl()`, `oklch()` or a colour name (no gradients, `var()`, `url()`) |
   | `scheme` | `dark` or `light` (a hint for mid-grey backgrounds) |
   | `pattern` | `topo`, `grid`, `dots`, `lines`, `none`: what sits behind the interface |
   | `shape` | `chamfer`, `square`, `round`, `pill`, `slant`: address bar, buttons, panels and menus |
   | `tabShape` | `chamfer`, `square`, `round`, `pill`, `slant`, `notch`: this site's own tab (defaults to `shape`) |
   | `tabStyle` | `solid`, `outline`, `glow`, `underline` |
   | `shadow` | `hard`, `soft`, `none` |
   | `border` | `none`, `thin`, `normal`, `thick` |
   | `density` | `compact`, `cozy`, `roomy` |
   | `font` | `display`, `sans`, `serif`, `mono`, `rounded`, `condensed`, `slab`, `hand` (system fonts only) |
   | `frame` | `true` or `false`: whether the page sits in a framed well |

4. **Map Flavion's choices onto them.** For each Flavion design option (radius, corner style, type scale, density, border
   weight, elevation, pattern or texture), pick the closest value above, and write the mapping down in the docs so it is
   predictable. Radius 0 is `square`, small radii are `chamfer` or `round`, fully round is `pill`; hard offset shadows are
   `hard`, blurred ones `soft`; a serif display face is `serif`, and so on.
5. **A preview.** In Flavion's editor, show the browser strip the look produces (a tab in `tabShape` and `tabStyle`, an
   address bar in `shape`, the backdrop and accent) next to the page, so the person building the site sees what Web Roamer
   visitors will see. Warn when the text colour will be adjusted: Web Roamer raises text to at least 7:1 contrast against
   the background (4.5:1 for secondary text, 2.6:1 for the accent), so pick colours that already pass.
6. **An off switch.** One setting to leave the meta tag out, and it should be off for any page that shows other people's content.

Rules to respect: a look is only plain data. It can't contain markup, scripts, images or text, can't change the address bar,
the lock icon or the window buttons, and belongs only to the site's own origin. Don't try to work around any of that.

Full reference: https://github.com/Tox-EyE-CeaZY/Web-Roamer/blob/main/docs/SITE-THEMING.md
