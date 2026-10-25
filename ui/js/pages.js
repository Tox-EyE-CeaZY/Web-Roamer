import { h, ago, clock, dayLabel, host, hash01, debounce } from './util.js';
import { icon, MARK } from './icons.js';
import { favicon, dialog, toast } from './ui.js';
import * as S from './store.js';

/** The browser's own pages (roamer:<name>). The chrome draws them in the page area; no web view is involved. */
export const INTERNAL = {
  start: { title: 'Start', icon: 'compass', build: start },
  history: { title: 'History', icon: 'history', build: historyPage },
  bookmarks: { title: 'Bookmarks', icon: 'bookmarks', build: bookmarksPage },
  downloads: { title: 'Downloads', icon: 'download', build: downloadsPage },
  settings: { title: 'Settings', icon: 'settings', build: settingsPage },
};

/**
 * Build the page into `host`, or, when it is already there, let it refresh for `what` changed
 * (so a search box keeps its focus while the list under it updates).
 */
export function renderPage(el, name, api, what) {
  const def = INTERNAL[name] || INTERNAL.start;
  if (el._page?.name === name && what) return el._page.update?.(what);
  if (el._page?.name === name && !what) return;
  const page = def.build(api);
  page.name = name;
  el._page = page;
  el.replaceChildren(page.el);
  el.scrollTop = 0;
}

const head = (kick, title, sub, ...tools) =>
  h('header', { class: 'pg-head' },
    h('div', { class: 'pg-title' }, h('span', { class: 'pg-kick' }, kick), h('h1', {}, title), sub ? h('p', { class: 'pg-sub' }, sub) : null),
    tools.length ? h('div', { class: 'pg-tools' }, ...tools) : null);

const searchBox = (placeholder, oninput) => {
  const i = h('input', { class: 'input pg-q', placeholder, spellcheck: 'false' });
  i.addEventListener('input', debounce(() => oninput(i.value.trim().toLowerCase()), 120));
  return h('label', { class: 'pg-search' }, h('i', { html: icon('search', 15) }), i);
};

/** Open on click, new tab on middle / Ctrl+click. */
const linkProps = (api, url) => ({
  href: url,
  onclick: (e) => (e.preventDefault(), api.open(url, { newTab: e.ctrlKey || e.metaKey })),
  onauxclick: (e) => e.button === 1 && (e.preventDefault(), api.open(url, { background: true })),
});

// ------------------------------------------------------------ start
function start(api) {
  const q = h('input', { class: 'start-q', placeholder: `Search ${S.ENGINES[S.settings.engine]?.name || 'the web'} or type an address`, spellcheck: 'false', autocomplete: 'off' });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && q.value.trim()) api.open(api.resolve(q.value), { newTab: e.altKey });
  });
  // typing hands over to the address bar, which has the suggestions
  q.addEventListener('input', () => {
    const v = q.value;
    q.value = '';
    api.focusAddress(v);
  });
  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 5 ? 'Night roaming' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  const tiles = h('div', { class: 'tiles' });
  const recent = h('div', { class: 'recent' });
  const paint = () => {
    const list = S.bookmarks.length ? S.bookmarks.slice(0, 12) : S.topSites(8);
    tilesHead.firstChild.textContent = S.bookmarks.length ? 'Bookmarks' : 'Most visited';
    tiles.replaceChildren(
      ...list.map((b) => {
        const hue = Math.round(hash01(host(b.url)) * 360);
        return h('a', { class: 'tile-site', style: { '--th': hue }, title: b.url, ...linkProps(api, b.url), oncontextmenu: (e) => b.id && (e.preventDefault(), api.bookmarkMenu(b, e.clientX, e.clientY)) },
          h('span', { class: 'ts-ic' }, favicon(b.icon, 26, b.title || host(b.url))),
          h('span', { class: 'ts-t' }, b.title || host(b.url)),
          h('span', { class: 'ts-h' }, host(b.url)));
      }),
      !list.length ? h('p', { class: 'empty-note' }, 'Your bookmarks land here. Star a page (Ctrl+D) to pin it to this board.') : null,
    );
    const seen = new Set();
    const rec = S.history.filter((e) => !seen.has(e.url) && seen.add(e.url)).slice(0, 6);
    recent.replaceChildren(...rec.map((e) => h('a', { class: 'rc', ...linkProps(api, e.url) },
      h('span', { class: 'rc-ic' }, favicon(e.icon, 15)),
      h('span', { class: 'rc-t' }, e.title || e.url),
      h('span', { class: 'rc-h' }, host(e.url)),
      h('span', { class: 'rc-a' }, ago(e.t)))));
    recentWrap.hidden = !rec.length;
  };
  const tilesHead = h('h2', { class: 'sec-t' }, '', h('button', { class: 'sec-more', onclick: () => api.openInternal('bookmarks') }, 'Manage'));
  const recentWrap = h('section', { class: 'start-sec' }, h('h2', { class: 'sec-t' }, 'Recently roamed', h('button', { class: 'sec-more', onclick: () => api.openInternal('history') }, 'All history')), recent);
  const el = h('div', { class: 'start' },
    h('div', { class: 'start-hero' },
      h('span', { class: 'start-mark', html: `<svg viewBox="0 0 40 40" width="64" height="64">${MARK}</svg>` }),
      h('div', {},
        h('span', { class: 'pg-kick' }, 'WEB', h('i', {}, '/'), 'ROAMER', h('em', {}, ' · ', now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))),
        h('h1', { class: 'start-h' }, `${greet}. Where to?`))),
    h('div', { class: 'field cut start-field' }, h('i', { class: 'f-ic', html: icon('search', 20) }), q,
      h('button', { class: 'go', title: 'Go', onclick: () => q.value.trim() && api.open(api.resolve(q.value)), html: icon('go', 18) })),
    h('section', { class: 'start-sec' }, tilesHead, tiles),
    recentWrap);
  paint();
  setTimeout(() => q.focus(), 0);
  return { el, update: (w) => (w === 'bookmarks' || w === 'history') && paint() };
}

// ------------------------------------------------------------ history
function historyPage(api) {
  let filter = '';
  const list = h('div', { class: 'hist' });
  const count = h('span');
  const paint = () => {
    const items = filter ? S.history.filter((e) => (e.title || '').toLowerCase().includes(filter) || e.url.toLowerCase().includes(filter)) : S.history;
    count.textContent = `${S.history.length} visit${S.history.length === 1 ? '' : 's'} kept on this computer`;
    const shown = items.slice(0, 400);
    const out = [];
    let day = '';
    for (const e of shown) {
      const d = dayLabel(e.t);
      if (d !== day) out.push(h('h3', { class: 'day' }, h('span', {}, (day = d))));
      out.push(h('div', { class: 'hrow' },
        h('span', { class: 'h-time' }, clock(e.t)),
        h('a', { class: 'h-link', title: e.url, ...linkProps(api, e.url) },
          h('span', { class: 'h-ic' }, favicon(e.icon, 16)),
          h('span', { class: 'h-t' }, e.title || e.url),
          h('span', { class: 'h-h' }, host(e.url))),
        h('button', { class: 'ibtn sm h-x', title: 'Remove from history', onclick: () => S.removeVisits((x) => x === e), html: icon('close', 14) })));
    }
    if (!shown.length) out.push(h('p', { class: 'empty-note' }, filter ? 'Nothing in your history matches that.' : 'No history yet. Go roam.'));
    if (items.length > shown.length) out.push(h('p', { class: 'empty-note' }, `Showing the latest ${shown.length} of ${items.length}. Search to narrow it down.`));
    list.replaceChildren(...out);
  };
  const clear = async () => {
    const choice = h('div', { class: 'seg' });
    const spans = [['Last hour', 3600e3], ['Today', 86400e3], ['Last 7 days', 7 * 86400e3], ['Everything', Infinity]];
    let pick = spans[3];
    const paintSeg = () => choice.replaceChildren(...spans.map((s) => h('button', { class: 'seg-b' + (s === pick ? ' on' : ''), onclick: () => ((pick = s), paintSeg()) }, s[0])));
    paintSeg();
    const ok = await dialog({ title: 'Clear history', text: 'Removes the pages you visited from this list. Bookmarks stay.', body: choice, ok: 'Clear', danger: true });
    if (!ok) return;
    const since = Date.now() - pick[1];
    S.removeVisits((e) => e.t >= since);
    toast('History cleared');
  };
  const el = h('div', { class: 'pg' },
    head('HISTORY', 'Where you’ve been', count, searchBox('Search history', (v) => ((filter = v), paint())),
      h('button', { class: 'btn danger', onclick: clear, html: icon('trash', 15) + '<span>Clear…</span>' })),
    list);
  paint();
  return { el, update: (w) => w === 'history' && paint() };
}

// ------------------------------------------------------------ bookmarks
function bookmarksPage(api) {
  let filter = '';
  const list = h('div', { class: 'bmk' });
  const count = h('span');
  const paint = () => {
    count.textContent = `${S.bookmarks.length} bookmark${S.bookmarks.length === 1 ? '' : 's'}`;
    const items = filter ? S.bookmarks.filter((b) => (b.title || '').toLowerCase().includes(filter) || b.url.toLowerCase().includes(filter)) : S.bookmarks;
    let dragId = null;
    list.replaceChildren(...items.map((b) => h('div', {
      class: 'bk cut', draggable: filter ? 'false' : 'true',
      ondragstart: (e) => ((dragId = b.id), (e.dataTransfer.effectAllowed = 'move')),
      ondragover: (e) => dragId && (e.preventDefault(), e.currentTarget.classList.add('drop')),
      ondragleave: (e) => e.currentTarget.classList.remove('drop'),
      ondrop: (e) => {
        e.preventDefault();
        if (dragId && dragId !== b.id) S.moveBookmark(dragId, S.bookmarks.indexOf(b));
      },
      oncontextmenu: (e) => (e.preventDefault(), api.bookmarkMenu(b, e.clientX, e.clientY)),
    },
    h('a', { class: 'bk-link', title: b.url, ...linkProps(api, b.url) },
      h('span', { class: 'bk-ic' }, favicon(b.icon, 20, b.title)),
      h('span', { class: 'bk-t' }, b.title || host(b.url)),
      h('span', { class: 'bk-u' }, b.url.replace(/^https?:\/\/(www\.)?/, ''))),
    h('div', { class: 'bk-act' },
      h('button', { class: 'ibtn sm', title: 'Edit', onclick: () => api.editBookmark(b), html: icon('edit', 14) }),
      h('button', { class: 'ibtn sm', title: 'Delete', onclick: () => api.deleteBookmark(b), html: icon('trash', 14) })))),
    !items.length ? h('p', { class: 'empty-note' }, filter ? 'No bookmark matches that.' : 'No bookmarks yet. Press the star in the address bar (or Ctrl+D) on any page.') : null);
  };
  const add = async () => {
    const name = h('input', { class: 'input', placeholder: 'Name' });
    const url = h('input', { class: 'input mono', placeholder: 'example.com' });
    const ok = await dialog({ title: 'Add bookmark', ok: 'Add', body: h('div', { class: 'dlg-fields' }, h('label', { class: 'dlg-field' }, h('span', {}, 'Address'), url), h('label', { class: 'dlg-field' }, h('span', {}, 'Name'), name)) });
    const u = ok && api.resolve(url.value);
    if (u && !u.startsWith('roamer:')) S.addBookmark({ url: u, title: name.value.trim() || host(u) });
  };
  const el = h('div', { class: 'pg' },
    head('BOOKMARKS', 'Your waypoints', count, searchBox('Search bookmarks', (v) => ((filter = v), paint())),
      h('button', { class: 'btn primary', onclick: add, html: icon('plus', 15) + '<span>Add</span>' })),
    h('p', { class: 'pg-hint' }, 'Drag to reorder. The order here is the order of the bookmarks bar.'),
    list);
  paint();
  return { el, update: (w) => w === 'bookmarks' && paint() };
}

// ------------------------------------------------------------ downloads
function downloadsPage(api) {
  const list = h('div', { class: 'dls' });
  const paint = () => {
    list.replaceChildren(...S.downloads.map((d) => h('div', { class: 'dl cut st-' + d.state },
      h('span', { class: 'dl-ic' }, d.state === 'active' ? h('i', { class: 'spin big' }) : h('i', { html: icon(d.state === 'done' ? 'file' : 'close', 22) })),
      h('div', { class: 'dl-body' },
        d.state === 'done'
          ? h('button', { class: 'dl-name', title: d.path, onclick: () => api.send('openfile', { path: d.path }) }, d.name)
          : h('span', { class: 'dl-name' }, d.name),
        h('span', { class: 'dl-meta' }, host(d.url), ' · ', ago(d.t)),
        d.state === 'active' ? h('i', { class: 'dl-bar' }) : null),
      h('span', { class: 'dl-state' }, { active: 'Downloading', done: 'Done', failed: 'Failed' }[d.state]),
      h('div', { class: 'dl-act' },
        d.state === 'done' ? h('button', { class: 'ibtn sm', title: 'Show in folder', onclick: () => api.send('reveal', { path: d.path }), html: icon('folder', 15) }) : null,
        d.state === 'failed' ? h('button', { class: 'ibtn sm', title: 'Try again', onclick: () => api.open(d.url, { newTab: true }), html: icon('reload', 15) }) : null,
        h('button', { class: 'ibtn sm', title: 'Copy address', onclick: () => navigator.clipboard?.writeText(d.url), html: icon('link', 15) }),
        d.state !== 'active' ? h('button', { class: 'ibtn sm', title: 'Remove from list', onclick: () => S.removeDownload(d), html: icon('close', 15) }) : null))),
    !S.downloads.length ? h('p', { class: 'empty-note' }, 'Nothing downloaded yet.') : null);
  };
  const folder = () => S.settings.downloadsDir || api.info?.downloads || '';
  const el = h('div', { class: 'pg' },
    head('DOWNLOADS', 'Carried home', h('span', { class: 'mono' }, folder()),
      h('button', { class: 'btn', onclick: () => api.send('reveal', { path: folder() }), html: icon('folder', 15) + '<span>Open folder</span>' }),
      h('button', { class: 'btn', onclick: () => S.clearDownloads(), html: icon('trash', 15) + '<span>Clear list</span>' })),
    list);
  paint();
  return { el, update: (w) => w === 'downloads' && paint() };
}

// ------------------------------------------------------------ settings
function settingsPage(api) {
  const set = S.setSetting;
  const tgl = (k, label, hint) => {
    const b = h('button', { class: 'tgl' + (S.settings[k] ? ' on' : ''), role: 'switch', onclick: () => (set(k, !S.settings[k]), b.classList.toggle('on', !!S.settings[k])) }, h('i'));
    return row(label, hint, b);
  };
  const seg = (k, opts) => {
    const el = h('div', { class: 'seg wrap' });
    const paint = () => el.replaceChildren(...opts.map(([v, l]) => h('button', { class: 'seg-b' + (S.settings[k] === v ? ' on' : ''), onclick: () => (set(k, v), paint()) }, l)));
    paint();
    return el;
  };
  const text = (k, placeholder, after = (v) => v) => {
    const i = h('input', { class: 'input mono', value: S.settings[k], placeholder });
    i.addEventListener('change', () => set(k, after(i.value.trim())));
    return i;
  };
  const row = (label, hint, ctl) => h('div', { class: 'srow' }, h('div', { class: 'sr-l' }, h('b', {}, label), hint ? h('small', {}, hint) : null), h('div', { class: 'sr-c' }, ctl));
  const sec = (title, ...rows) => h('section', { class: 'ssec cut' }, h('h2', { class: 'ss-t' }, title), ...rows);

  const themes = h('div', { class: 'themes' });
  const paintThemes = () => themes.replaceChildren(...[['night', 'Night'], ['paper', 'Paper'], ['violet', 'Violet']].map(([v, l]) =>
    h('button', { class: 'theme-card' + (S.settings.theme === v ? ' on' : ''), dataset: { t: v }, onclick: () => (set('theme', v), paintThemes()) }, h('i'), h('span', {}, l))));
  paintThemes();
  const hue = h('input', { type: 'range', min: 0, max: 360, value: S.settings.hue });
  hue.addEventListener('input', () => document.documentElement.style.setProperty('--hue', hue.value));
  hue.addEventListener('change', () => set('hue', +hue.value));

  const el = h('div', { class: 'pg pg-settings' },
    head('SETTINGS', 'Tune the roamer', `Web Roamer ${api.info?.version || ''}`),
    h('div', { class: 'scols' },
      sec('Look',
        row('Theme', null, themes),
        row('Accent', 'Slide to recolour every highlight', h('div', { class: 'hue-wrap' }, hue, h('button', { class: 'chipbtn', onclick: () => (set('hue', 128), (hue.value = 128)) }, 'reset'))),
        tgl('topo', 'Contour map', 'The topographic lines behind the interface'),
        tgl('grain', 'Film grain'),
        tgl('frame', 'Framed pages', 'Pages sit in a well with a hard offset shadow; off fills the window edge to edge')),
      sec('Browsing',
        row('Search engine', null, seg('engine', Object.entries(S.ENGINES).map(([k, e]) => [k, e.name]))),
        row('Home page', 'Leave empty for the start page', text('home', 'roamer:start')),
        row('New tabs open', null, seg('newTab', [['start', 'Start page'], ['home', 'Home page']])),
        tgl('restoreTabs', 'Reopen tabs', 'Bring back the tabs you had open last time'),
        tgl('bookmarksBar', 'Bookmarks bar', 'Ctrl+Shift+B'),
        tgl('askClose', 'Ask before closing many tabs', 'Only when tabs are not reopened next time')),
      sec('Downloads',
        row('Save to', `Empty uses ${api.info?.downloads || 'your Downloads folder'}`, text('downloadsDir', api.info?.downloads || '', (v) => (api.send('dldir', { path: v }), v)))),
      sec('Privacy',
        row('History', `${S.history.length} visits`, h('button', { class: 'btn danger', onclick: () => api.openInternal('history') }, 'Manage')),
        row('Site data', 'Cookies, cache and saved logins of every site', h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (await dialog({ title: 'Clear site data?', text: 'You will be signed out of websites. Bookmarks and history stay.', ok: 'Clear', danger: true })) {
              api.send('clear');
              toast('Site data cleared');
            }
          },
        }, 'Clear…'))),
      sec('Keys',
        h('dl', { class: 'keys' }, ...[
          ['Ctrl+T', 'New tab'], ['Ctrl+W', 'Close tab'], ['Ctrl+Shift+T', 'Reopen closed tab'], ['Ctrl+Tab', 'Next tab'], ['Ctrl+1…9', 'Go to tab'],
          ['Ctrl+L', 'Address bar'], ['Ctrl+R / F5', 'Reload'], ['Alt+← / →', 'Back / forward'], ['Ctrl+D', 'Bookmark'], ['Ctrl+F', 'Find'],
          ['Ctrl+H', 'History'], ['Ctrl+J', 'Downloads'], ['Ctrl+ + / − / 0', 'Zoom'], ['F11', 'Full screen'], ['F12', 'Developer tools'],
        ].flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)]))),
    ));
  return { el };
}

