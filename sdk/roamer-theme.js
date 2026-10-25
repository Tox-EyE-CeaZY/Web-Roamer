/*! Web Roamer Site Theming SDK helper · MIT · https://github.com/Tox-EyE-CeaZY/Web-Roamer/blob/main/docs/SITE-THEMING.md
 *
 * RoamerTheme.apply(look)            one look: {background, accent, pattern, ...}
 * RoamerTheme.apply({dark, light})   two looks, chosen by the visitor's prefers-color-scheme
 * RoamerTheme.clear()
 * RoamerTheme.isRoamer               true inside Web Roamer
 *
 * Works in every browser: outside Web Roamer it only keeps a <meta name="roamer-theme"> tag up to date, which other
 * browsers ignore.
 */
(function (root) {
  'use strict';
  var mq = root.matchMedia ? root.matchMedia('(prefers-color-scheme: light)') : null;
  var current = null;

  function pick(look) {
    if (look && (look.dark || look.light)) return (mq && mq.matches ? look.light : look.dark) || look.dark || look.light;
    return look;
  }
  function meta() {
    var m = document.querySelector('meta[name="roamer-theme"]');
    if (!m) {
      m = document.createElement('meta');
      m.name = 'roamer-theme';
      (document.head || document.documentElement).appendChild(m);
    }
    return m;
  }
  function paint() {
    var look = pick(current);
    if (!look) return;
    meta().content = JSON.stringify(look);
    if (root.roamer && root.roamer.theme) root.roamer.theme.set(look);
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (current) paint(); });

  root.RoamerTheme = {
    isRoamer: !!root.roamer,
    apply: function (look) {
      current = look || null;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint, { once: true });
      else paint();
    },
    clear: function () {
      current = null;
      var m = document.querySelector('meta[name="roamer-theme"]');
      if (m) m.parentNode.removeChild(m);
      if (root.roamer && root.roamer.theme) root.roamer.theme.clear();
    },
  };
})(typeof window !== 'undefined' ? window : this);
