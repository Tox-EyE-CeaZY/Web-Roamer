import { h, debounce, host } from './util.js';
import { icon, MARK } from './icons.js';
import { dialog, toast } from './ui.js';
import * as S from './store.js';

/**
 * roamer:settings. Sections down the left (and a search over every setting), the controls on the right.
 * Every control writes straight to the store; the chrome follows through S.onChange.
 */
export function settingsPage(api) {
  const set = S.setSetting;
  const opts = api.opts || {};
  const row = (label, hint, ctl, keys = '') => h('div', { class: 'srow', dataset: { find: (label + ' ' + (hint || '') + ' ' + keys).toLowerCase() } },
    h('div', { class: 'sr-l' }, h('b', {}, label), hint ? h('small', {}, hint) : null), h('div', { class: 'sr-c' }, ctl));
  const tgl = (k, label, hint, after) => {
    const b = h('button', { class: 'tgl' + (S.settings[k] ? ' on' : ''), role: 'switch', 'aria-label': label, onclick: () => (set(k, !S.settings[k]), b.classList.toggle('on', !!S.settings[k]), after?.()) }, h('i'));
    return row(label, hint, b);
  };
  const seg = (k, choices, after) => {
    const el = h('div', { class: 'seg wrap' });
    const paint = () => el.replaceChildren(...choices.map(([v, l]) => h('button', { class: 'seg-b' + (S.settings[k] === v ? ' on' : ''), onclick: () => (set(k, v), paint(), after?.(v)) }, l)));
    paint();
    return el;
  };
  const text = (k, placeholder, after = (v) => v) => {
    const i = h('input', { class: 'input mono', value: S.settings[k] ?? '', placeholder, spellcheck: 'false' });
    i.addEventListener('change', () => set(k, after(i.value.trim())));
    return i;
  };
  const button = (label, run, cls = '') => h('button', { class: 'btn ' + cls, onclick: run }, label);
  const sections = [];
  const sec = (id, title, ic, ...rows) => {
    const el = h('section', { class: 'ssec cut', id: 'set-' + id }, h('h2', { class: 'ss-t' }, h('i', { html: icon(ic, 15) }), title), ...rows);
    sections.push({ id, title, ic, el });
    return el;
  };

  // ---------- appearance
  const themes = h('div', { class: 'themes' });
  const paintThemes = () => themes.replaceChildren(...[['night', 'Night'], ['paper', 'Paper'], ['violet', 'Violet'], ['system', 'System']].map(([v, l]) =>
    h('button', { class: 'theme-card' + (S.settings.theme === v ? ' on' : ''), dataset: { t: v }, onclick: () => (set('theme', v), paintThemes()) }, h('i'), h('span', {}, l))));
  paintThemes();
  const hue = h('input', { type: 'range', min: 0, max: 360, value: S.settings.hue, 'aria-label': 'Accent colour' });
  hue.addEventListener('input', () => document.documentElement.style.setProperty('--hue', hue.value));
  hue.addEventListener('change', () => set('hue', +hue.value));
  const ZOOMS = [[0.8, '80%'], [0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%'], [1.5, '150%']];

  // ---------- search
  const custom = text('customEngine', 'https://example.com/search?q=%s', (v) => {
    if (v && !/^https?:\/\/.+%s/.test(v)) {
      toast('A search address needs http(s):// and %s where the words go', { err: true });
      return S.settings.customEngine;
    }
    if (v) set('engine', 'custom');
    return v;
  });
  const engines = seg('engine', [...Object.entries(S.ENGINES).map(([k, e]) => [k, e.name]), ['custom', 'Custom']], (v) => v === 'custom' && !S.settings.customEngine && custom.focus());

  // ---------- site looks
  const siteList = h('div', { class: 'site-list' });
  const paintSites = () => {
    const entries = Object.entries(S.themeSites);
    siteList.replaceChildren(...entries.map(([o, v]) => h('div', { class: 'site-row' },
      h('span', { class: 'mono' }, host(o)), h('em', { class: v === 'allow' ? 'ok' : 'no' }, v === 'allow' ? 'allowed' : 'blocked'),
      h('button', { class: 'ibtn sm', title: 'Forget this choice', onclick: () => (S.setThemeSite(o, null), paintSites()), html: icon('close', 13) }))),
    !entries.length ? h('small', { class: 'faint' }, 'Sites you allow or block show up here.') : null);
  };
  paintSites();
  const zoomList = h('div', { class: 'site-list' });
  const paintZooms = () => {
    const entries = Object.entries(S.siteZoom);
    zoomList.replaceChildren(...entries.map(([hn, z]) => h('div', { class: 'site-row' },
      h('span', { class: 'mono' }, hn), h('em', {}, Math.round(z * 100) + '%'),
      h('button', { class: 'ibtn sm', title: 'Back to the default zoom', onclick: () => (S.setSiteZoom(hn, S.settings.defaultZoom || 1), paintZooms()), html: icon('close', 13) }))),
    !entries.length ? h('small', { class: 'faint' }, 'Zoom a site with Ctrl + / − and it is remembered here.') : null);
  };
  paintZooms();

  // ---------- about
  const info = api.info || {};
  const st = api.upd();
  const upd = h('div', { class: 'upd' });
  const paintUpd = (checking) => {
    const u = api.update(), st = api.upd();
    upd.replaceChildren(
      checking ? h('span', {}, h('i', { class: 'spin' }), ' Checking…')
        : st.state === 'ready' ? h('span', { class: 'upd-new' }, `Version ${String(st.tag).replace(/^v/, '')} is downloaded. `, h('button', { class: 'linkbtn', onclick: () => api.getUpdate() }, 'Restart to update'))
          : st.state === 'downloading' ? h('span', {}, h('i', { class: 'spin' }), ` Downloading ${u?.tag || ''}… ${st.pct || 0}%`)
            : api.updateReady() ? h('span', { class: 'upd-new' }, `Version ${u.tag.replace(/^v/, '')} is out. `, h('button', { class: 'linkbtn', onclick: () => api.getUpdate() }, api.canSelfUpdate() ? 'Update now' : 'Download it'))
              : u ? h('span', {}, `Up to date · checked ${new Date(u.t).toLocaleString()}`) : h('span', {}, 'Not checked yet'),
      h('button', { class: 'chipbtn', onclick: async () => (paintUpd(true), await api.checkUpdates(true), paintUpd()) }, 'check now'));
  };
  paintUpd();

  const keys = [
    ['Ctrl+T', 'New tab'], ['Ctrl+N', 'New window'], ['Ctrl+W', 'Close tab'], ['Ctrl+Shift+T', 'Reopen closed tab'], ['Ctrl+Tab', 'Next tab'],
    ['Ctrl+1…9', 'Go to tab'], ['Ctrl+Shift+A', 'Search tabs'], ['Ctrl+L', 'Address bar'], ['Ctrl+K', 'Search the web'], ['Ctrl+Enter', 'example → www.example.com'],
    ['Alt+Enter', 'Open in a new tab'], ['Ctrl+R / F5', 'Reload'], ['Esc', 'Stop loading'], ['Alt+← / →', 'Back / forward'], ['Alt+Home', 'Home'],
    ['Ctrl+D', 'Bookmark'], ['Ctrl+Shift+B', 'Bookmarks bar'], ['Ctrl+Shift+O', 'Bookmarks'], ['Ctrl+F / F3', 'Find / find next'], ['Ctrl+P', 'Print'],
    ['Ctrl+U', 'View source'], ['Ctrl+H', 'History'], ['Ctrl+J', 'Downloads'], ['Ctrl+ + / − / 0', 'Zoom'], ['F11', 'Full screen'], ['F12', 'Developer tools'],
    ['Alt+F', 'Menu'], ['Ctrl+,', 'Settings'], ['Ctrl+Shift+Del', 'Clear browsing data'], ['Ctrl+Shift+Q', 'Exit'],
    ['Shift+Delete', 'Forget a history suggestion'], ['Ctrl / middle click', 'Open a link in the background'],
  ];

  const content = h('div', { class: 'scontent' },
    sec('look', 'Appearance', 'brush',
      row('Theme', 'System follows your computer’s light or dark mode', themes, 'night paper violet dark light'),
      row('Accent', 'Slide to recolour every highlight', h('div', { class: 'hue-wrap' }, hue, h('button', { class: 'chipbtn', onclick: () => (set('hue', 128), (hue.value = 128)) }, 'reset')), 'colour color hue'),
      tgl('topo', 'Contour map', 'The topographic lines behind the interface'),
      tgl('grain', 'Film grain'),
      tgl('frame', 'Framed pages', 'Pages sit in a well with a hard offset shadow; off fills the window edge to edge'),
      tgl('showHome', 'Home button', 'Next to reload in the toolbar'),
      row('Bookmarks bar', 'Ctrl+Shift+B hides or shows it', seg('bookmarksBar', [['always', 'Always'], ['start', 'Start page'], ['never', 'Hidden']])),
      row('Page zoom', 'For every site you haven’t zoomed yourself', seg('defaultZoom', ZOOMS), 'size text bigger smaller')),
    sec('start', 'Start page', 'compass',
      tgl('greeting', 'Greeting', '“Morning. Where to?”'),
      row('Shortcuts', 'The tiles under the search box', seg('startTiles', [['auto', 'Bookmarks, else most visited'], ['bookmarks', 'Bookmarks'], ['top', 'Most visited'], ['off', 'None']]), 'tiles'),
      tgl('startRecent', 'Recently roamed', 'The last pages you visited'),
      row('Home page', 'The house button and Alt+Home; empty for the start page', text('home', 'roamer:start')),
      row('New tabs open', null, seg('newTab', [['start', 'Start page'], ['home', 'Home page']]))),
    sec('search', 'Search & address bar', 'search',
      row('Search engine', 'Used by the address bar and the start page', engines, 'google bing duckduckgo brave'),
      row('Custom engine', 'Its search address, with %s where the words go', custom),
      tgl('suggestions', 'Search suggestions', 'Ask the search engine for suggestions while you type (it sees what you type)')),
    sec('tabs', 'Tabs & groups', 'group',
      tgl('restoreTabs', 'Reopen tabs', 'Bring back the tabs and groups you had open last time'),
      row('Closing the last tab', null, seg('lastTab', [['start', 'Leaves a start page'], ['window', 'Closes the window']])),
      tgl('askClose', 'Ask before closing many tabs', 'Only when tabs are not reopened next time'),
      row('Smart groups', 'Groups tabs that share a search, a site or a kind of site (shopping, video, dev docs…)', seg('smartGroups', [['off', 'Off'], ['suggest', 'Suggest'], ['auto', 'Automatic']]), 'tab groups organize'),
      row('Dismissed suggestions', 'Groups you said “not now” to are not offered again', button('Offer them again', () => (api.forgetSuggestions(), toast('Group suggestions reset')))),
      row('Desktop', 'Shows the pages of one group side by side. Right-click a tab → “Show beside this tab”, or use the toolbar’s desktop button.', button('Try it', () => api.toggleDesktop()), 'split tile side by side')),
    sec('looks', 'Site looks', 'layers',
      row('Let sites style Web Roamer', 'Sites made with the Site Theming SDK can recolour the browser while you’re on them', seg('siteThemes', [['off', 'Never'], ['ask', 'Ask'], ['on', 'Always']]), 'theme sdk'),
      tgl('themeColor', 'Tint with a site’s theme colour', 'Most sites name one colour for browsers (theme-color); use it as the backdrop'),
      row('Your choices', null, siteList),
      row('For web developers', 'How a site describes its look', button('Read the SDK', () => api.open(api.docsTheming, { newTab: true })))),
    sec('privacy', 'Privacy & data', 'shield',
      row('Clear browsing data', 'History, the download list, cookies and cache', button('Clear…', () => api.clearData(), 'danger'), 'cookies cache delete'),
      row('History', `${S.history.length} visits kept on this computer`, button('Manage', () => api.openInternal('history'))),
      row('Zoom by site', null, zoomList),
      row('Data folder', 'Your profile: cookies, cache, bookmarks and history', h('span', { class: 'mono path' }, info.data || '—'))),
    sec('downloads', 'Downloads', 'download',
      row('Save to', `Empty uses ${info.downloads || 'your Downloads folder'}`, text('downloadsDir', info.downloads || '', (v) => (api.send('dldir', { path: v }), v)), 'folder'),
      row('Downloads folder', null, button('Open', () => api.send('reveal', { path: S.settings.downloadsDir || info.downloads || '' })))),
    sec('bookmarks', 'Bookmarks', 'bookmarks',
      row('Import', 'An HTML bookmarks file from Chrome, Edge, Firefox or Safari', button('Import…', () => api.importBookmarks()), 'import export html'),
      row('Export', `${S.bookmarks.length} bookmarks as an HTML file any browser can read`, button('Export', () => api.exportBookmarks()))),
    sec('keys', 'Keyboard shortcuts', 'keyboard',
      h('dl', { class: 'keys', dataset: { find: keys.flat().join(' ').toLowerCase() } }, ...keys.flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)]))),
    sec('about', 'About', 'compass',
      h('div', { class: 'about', dataset: { find: 'about version update' } },
        h('span', { class: 'about-mark', html: `<svg viewBox="0 0 40 40" width="48" height="48">${MARK}</svg>` }),
        h('div', {},
          h('b', { class: 'about-name' }, 'WEB', h('i', {}, '/'), 'ROAMER'),
          h('div', { class: 'mono' }, `Version ${info.version || 'dev'} · ${info.plat || 'web'}`),
          upd)),
      tgl('updates', 'Look for updates', 'Checks GitHub for a new release about twice a day'),
      tgl('autoUpdate', 'Download updates by themselves', 'A new version is fetched and checked in the background, then it only takes a restart'),
      st && st.state === 'error' ? row('Last update', st.error, h('span')) : null,
      row('Project', 'Source code, releases and where to report problems', h('div', { class: 'btn-row' },
        button('GitHub', () => api.open(api.repo, { newTab: true })),
        button('Report a problem', () => api.open(api.repo + '/issues/new', { newTab: true })))),
      row('Reset settings', 'Back to how Web Roamer came; bookmarks and history stay', button('Reset…', async () => {
        if (await dialog({ title: 'Reset all settings?', text: 'Look, search, tabs and privacy settings go back to their defaults. Bookmarks, history and open tabs stay.', ok: 'Reset', danger: true })) {
          S.resetSettings();
          toast('Settings reset');
        }
      }, 'danger'))),
  );

  // the list of sections, and a search over everything
  const nav = h('nav', { class: 'snav' });
  const findBox = h('input', { class: 'input', placeholder: 'Search settings', spellcheck: 'false' });
  const none = h('p', { class: 'empty-note', hidden: true }, 'No setting matches that.');
  const go = (id) => content.querySelector('#set-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  nav.append(
    h('label', { class: 'pg-search' }, h('i', { html: icon('search', 15) }), findBox),
    ...sections.map((s) => h('button', { class: 'snav-i', dataset: { id: s.id }, onclick: () => go(s.id) }, h('i', { html: icon(s.ic, 15) }), h('span', {}, s.title))));
  findBox.addEventListener('input', debounce(() => {
    const f = findBox.value.trim().toLowerCase();
    let any = false;
    for (const s of sections) {
      let n = 0;
      for (const r of s.el.querySelectorAll('[data-find]')) {
        const hit = !f || r.dataset.find.includes(f) || s.title.toLowerCase().includes(f);
        r.hidden = !hit;
        n += hit;
      }
      s.el.hidden = !n;
      any ||= !!n;
    }
    none.hidden = any;
  }, 100));
  // light up the section in view
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) nav.querySelectorAll('.snav-i').forEach((b) => b.classList.toggle('on', b.dataset.id === e.target.id.slice(4)));
  }, { rootMargin: '-10% 0px -70% 0px' });
  sections.forEach((s) => io.observe(s.el));

  const el = h('div', { class: 'pg pg-settings' },
    h('header', { class: 'pg-head' }, h('div', { class: 'pg-title' }, h('span', { class: 'pg-kick' }, 'SETTINGS'), h('h1', {}, 'Tune the roamer'), h('p', { class: 'pg-sub' }, `Web Roamer ${info.version || ''}`))),
    h('div', { class: 'sgrid' }, nav, h('div', {}, none, content)));
  if (opts.section) requestAnimationFrame(() => go(opts.section));
  return {
    el,
    update: (w) => {
      if (w === 'themesites') paintSites();
      if (w === 'zoom' || w === 'settings') paintZooms();
      if (w === 'update') paintUpd();
    },
  };
}
