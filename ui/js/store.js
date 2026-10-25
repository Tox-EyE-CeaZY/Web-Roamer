// Everything the browser remembers lives in the chrome's own localStorage (kept in the app's profile folder):
// settings, bookmarks, history, the downloads list and the open tabs.

const K = 'wr1:';
const read = (k, d) => {
  try {
    const v = JSON.parse(localStorage.getItem(K + k));
    return v ?? d;
  } catch {
    return d;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(K + k, JSON.stringify(v));
  } catch (e) {
    console.warn('could not save', k, e);
  }
};

const listeners = new Set();
/** Called with the name of what changed ('settings', 'bookmarks', 'history', 'downloads'). */
export const onChange = (fn) => listeners.add(fn);
const changed = (what) => listeners.forEach((fn) => fn(what));

// ------------------------------------------------------------ settings
export const ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
};
/** The search engine in use (a custom one when the user typed its address in Settings). */
export const engine = () =>
  settings.engine === 'custom' && /%s/.test(settings.customEngine || '') ? { name: hostName(settings.customEngine), url: settings.customEngine } : ENGINES[settings.engine] || ENGINES.duckduckgo;
const hostName = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return 'your engine';
  }
};

const DEFAULTS = {
  theme: 'night',
  hue: 128,
  engine: 'duckduckgo',
  home: '', // empty = the start page
  newTab: 'start', // 'start' | 'home'
  bookmarksBar: 'start', // 'always' | 'start' (only on the start page) | 'never'
  restoreTabs: true,
  frame: true, // page sits in a framed well with a hard offset shadow
  topo: true,
  grain: true,
  downloadsDir: '',
  askClose: true, // confirm before closing a window with several tabs
  customEngine: '', // search address with %s, used when engine is 'custom'
  suggestions: true, // ask the search engine for suggestions while typing
  showHome: true,
  defaultZoom: 1,
  lastTab: 'start', // closing the last tab: 'start' (leaves a start page) | 'window' (closes the window)
  greeting: true,
  startTiles: 'auto', // 'auto' (bookmarks, else most visited) | 'bookmarks' | 'top' | 'off'
  startRecent: true,
  smartGroups: 'suggest', // 'off' | 'suggest' | 'auto'
  siteThemes: 'ask', // what sites using the Site Theming SDK may do: 'off' | 'ask' | 'on'
  themeColor: false, // tint the toolbar with a site's <meta name="theme-color">
  updates: true, // look for a new release now and then
  autoUpdate: true, // and download it, so it only takes a restart
  newTabPage: '', // an address for new tabs when newTab is 'custom'
  boards: 'auto', // image board searches typed in the address bar: 'auto' (open in Board Roamer) | 'chip' (only by the button) | 'off'
  boardPath: '', // where Board Roamer lives, when Web Roamer can't find it itself
  instant: true, // show instant answers (from DuckDuckGo) on the start page while typing
  glide: true, // the start page's search box glides into the address bar when you start typing
  unfurl: true, // a site's look spreads out from its tab
  accel: true, // draw pages with the graphics card (takes a restart)
  historyView: 'trail', // 'trail' | 'list'
};

export const settings = { ...DEFAULTS, ...read('settings', {}) };
// the bar used to be a plain on/off switch
if (typeof settings.bookmarksBar === 'boolean') settings.bookmarksBar = settings.bookmarksBar ? 'always' : 'never';
export function setSetting(k, v) {
  settings[k] = v;
  write('settings', settings);
  changed('settings');
}
export function resetSettings() {
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, DEFAULTS);
  write('settings', settings);
  changed('settings');
}

// ------------------------------------------------------------ per-site choices
// zoom per site {host: 1.25} and what each site may do to the browser's look {origin: 'allow' | 'block'}
export let siteZoom = read('zoom', {});
export const zoomFor = (host) => siteZoom[host] ?? settings.defaultZoom ?? 1;
export function setSiteZoom(host, z) {
  if (!host) return;
  if (Math.abs(z - (settings.defaultZoom || 1)) < 0.001) delete siteZoom[host];
  else siteZoom[host] = z;
  write('zoom', siteZoom);
  changed('zoom');
}
export function clearSiteZoom() {
  siteZoom = {};
  write('zoom', siteZoom);
  changed('zoom');
}
export let themeSites = read('themesites', {});
export function setThemeSite(origin, v) {
  if (v) themeSites[origin] = v;
  else delete themeSites[origin];
  write('themesites', themeSites);
  changed('themesites');
}

// ------------------------------------------------------------ bookmarks
// {id, url, title, icon, t}
export let bookmarks = read('bookmarks', []);
const saveBookmarks = () => (write('bookmarks', bookmarks), changed('bookmarks'));
const norm = (u) => (u || '').replace(/#.*$/, '').replace(/\/$/, '');
export const bookmarkOf = (url) => bookmarks.find((b) => norm(b.url) === norm(url));
export function addBookmark(b) {
  if (bookmarkOf(b.url)) return bookmarkOf(b.url);
  const nb = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url: b.url, title: b.title || b.url, icon: b.icon || '', t: Date.now() };
  bookmarks.push(nb);
  saveBookmarks();
  return nb;
}
export function removeBookmark(id) {
  bookmarks = bookmarks.filter((b) => b.id !== id);
  saveBookmarks();
}
export function updateBookmark(id, patch) {
  const b = bookmarks.find((x) => x.id === id);
  if (b) Object.assign(b, patch), saveBookmarks();
}
export function moveBookmark(id, toIndex) {
  const i = bookmarks.findIndex((b) => b.id === id);
  if (i < 0) return;
  const [b] = bookmarks.splice(i, 1);
  bookmarks.splice(Math.max(0, Math.min(bookmarks.length, toIndex)), 0, b);
  saveBookmarks();
}
export function restoreBookmark(b, index) {
  bookmarks.splice(Math.min(index, bookmarks.length), 0, b);
  saveBookmarks();
}

export function addBookmarks(list) {
  let n = 0;
  for (const b of list) {
    if (!/^(https?|file):/i.test(b.url || '') || bookmarkOf(b.url)) continue;
    bookmarks.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url: b.url, title: b.title || b.url, icon: b.icon || '', t: b.t || Date.now() });
    n++;
  }
  if (n) saveBookmarks();
  return n;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** The bookmarks as the HTML file every browser can import. */
export function bookmarksHtml() {
  const rows = bookmarks.map((b) => `    <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.round((b.t || Date.now()) / 1000)}"${/^data:image\//.test(b.icon) ? ` ICON="${esc(b.icon)}"` : ''}>${esc(b.title)}</A>`);
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n  <DT><H3>Web Roamer</H3>\n  <DL><p>\n${rows.join('\n')}\n  </DL><p>\n</DL><p>\n`;
}
/** Bookmarks out of an exported bookmarks file (Chrome, Edge, Firefox, Safari all write the same format). */
export function parseBookmarksHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return [...doc.querySelectorAll('a[href]')].map((a) => ({
    url: a.getAttribute('href'),
    title: a.textContent.trim(),
    icon: /^data:image\//.test(a.getAttribute('icon') || '') ? a.getAttribute('icon') : '',
    t: +a.getAttribute('add_date') * 1000 || Date.now(),
  }));
}

// ------------------------------------------------------------ history
// newest first: {url, title, icon, t}; `visits` counts per address for the suggestions
const HISTORY_MAX = 6000;
export let history = read('history', []);
const visits = new Map();
for (const e of history) visits.set(norm(e.url), (visits.get(norm(e.url)) || 0) + 1);
const saveHistory = () => (write('history', history), changed('history'));
let historyTimer;
const saveHistorySoon = () => (clearTimeout(historyTimer), (historyTimer = setTimeout(saveHistory, 800)));

export function recordVisit(url, title, icon) {
  if (!/^https?:/i.test(url)) return;
  const top = history[0];
  // a reload or a redirect back to the same address is one visit
  if (top && top.url === url && Date.now() - top.t < 30 * 60 * 1000) {
    top.t = Date.now();
    if (title) top.title = title;
    if (icon) top.icon = icon;
  } else {
    history.unshift({ url, title: title || '', icon: icon || '', t: Date.now() });
    visits.set(norm(url), (visits.get(norm(url)) || 0) + 1);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  }
  saveHistorySoon();
}
/** A title or favicon that arrived after the page finished loading. */
export function touchVisit(url, patch) {
  const e = history.find((x) => x.url === url && Date.now() - x.t < 6 * 3600 * 1000);
  if (!e) return;
  Object.assign(e, patch);
  saveHistorySoon();
}
/** The pages visited most recently, one per address. */
export function recentVisits(n = 8) {
  const seen = new Set();
  return history.filter((e) => !seen.has(norm(e.url)) && seen.add(norm(e.url))).slice(0, n);
}
export function removeVisits(pred) {
  history = history.filter((e) => !pred(e));
  visits.clear();
  for (const e of history) visits.set(norm(e.url), (visits.get(norm(e.url)) || 0) + 1);
  saveHistory();
}
export const visitCount = (url) => visits.get(norm(url)) || 0;

/** Most visited sites (one per address), for the start page when there are no bookmarks yet. */
export function topSites(n = 8) {
  const seen = new Map();
  for (const e of history) {
    const k = norm(e.url);
    if (!seen.has(k)) seen.set(k, { ...e, n: visits.get(k) || 1 });
  }
  return [...seen.values()].sort((a, b) => b.n - a.n || b.t - a.t).slice(0, n);
}

// ------------------------------------------------------------ downloads
// {dl, url, name, path, state: active|done|failed, t}
const RUN = Date.now();
export let downloads = read('downloads', []).map((d) => (d.state === 'active' ? { ...d, state: 'failed' } : d));
const saveDownloads = () => (write('downloads', downloads), changed('downloads'));
export function upsertDownload(d) {
  // the native side numbers downloads per run, so match on the running number only for downloads of this run
  const cur = downloads.find((x) => x.run === RUN && x.dl === d.dl);
  if (cur) Object.assign(cur, d);
  else downloads.unshift({ ...d, run: RUN, t: Date.now() });
  if (downloads.length > 300) downloads.length = 300;
  saveDownloads();
  return cur || downloads[0];
}
export function removeDownload(d) {
  downloads = downloads.filter((x) => x !== d);
  saveDownloads();
}
export function clearDownloads() {
  downloads = downloads.filter((x) => x.state === 'active');
  saveDownloads();
}

// ------------------------------------------------------------ session (open tabs and groups)
export const session = read('session', null);
export const saveSession = (s) => write('session', s);

// ------------------------------------------------------------ small things the browser remembers
export const memo = read('memo', {}); // {dismissed: [...group suggestion keys], update: {t, tag, url}}
export const saveMemo = () => write('memo', memo);

// ------------------------------------------------------------ other windows
// A second window shares this storage; follow what it changes so neither overwrites the other's bookmarks or settings.
addEventListener('storage', (e) => {
  if (!e.key?.startsWith(K)) return;
  const k = e.key.slice(K.length);
  if (k === 'settings') Object.assign(settings, read('settings', {})), changed('settings');
  else if (k === 'bookmarks') (bookmarks = read('bookmarks', [])), changed('bookmarks');
  else if (k === 'history') {
    history = read('history', []);
    visits.clear();
    for (const x of history) visits.set(norm(x.url), (visits.get(norm(x.url)) || 0) + 1);
    changed('history');
  } else if (k === 'zoom') (siteZoom = read('zoom', {})), changed('zoom');
  else if (k === 'themesites') (themeSites = read('themesites', {})), changed('themesites');
});
