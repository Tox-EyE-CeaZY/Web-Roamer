import { $, h, clamp, combo, debounce, copyText, host as hostOf } from './util.js';
import { icon, MARK } from './icons.js';
import { isNative, on, send } from './native.js';
import { initTopo, paintTopo } from './bg.js';
import { toast, dialog, showMenu, closeMenu, holdOverlay, favicon, popover, closePopover } from './ui.js';
import * as S from './store.js';
import * as G from './groups.js';
import * as Look from './sitetheme.js';
import * as E from './engines.js';
import * as B from './boards.js';
import { renderPage, INTERNAL } from './pages.js';

/**
 * The chrome: title bar with tabs and tab groups, the toolbar and address bar, the bookmarks bar, the find bar, the
 * desktop (several pages of a group side by side) and the internal pages (roamer:start, roamer:history ...).
 * Web pages are native views the Rust side lays over the holes this file measures and reports with 'layout'.
 */
const root = document.documentElement;
const plat = window.__plat || 'web';
root.dataset.plat = plat;
const REPO = 'https://github.com/Tox-EyE-CeaZY/Web-Roamer';
export const DOCS_THEMING = REPO + '/blob/main/docs/SITE-THEMING.md';

// ------------------------------------------------------------ look
const prefersLight = matchMedia('(prefers-color-scheme: light)');
function applyLook() {
  const th = S.settings.theme === 'system' ? (prefersLight.matches ? 'paper' : 'night') : S.settings.theme;
  root.dataset.theme = th;
  root.style.setProperty('--hue', S.settings.hue);
  root.classList.toggle('no-topo', !S.settings.topo);
  root.classList.toggle('no-grain', !S.settings.grain);
  root.dataset.bmbar = S.settings.bookmarksBar;
  root.classList.toggle('no-home', !S.settings.showHome);
  siteLook(true);
}
prefersLight.addEventListener?.('change', () => S.settings.theme === 'system' && (applyLook(), paintTopo()));

// ------------------------------------------------------------ tabs model
/**
 * {id, url, title, icon, loading, zoom, live (has a native page), pending (restored, not loaded yet), pinned, muted,
 *  audible, group (group id), opener, topic (the search that led here), seen (last shown), data (for roamer:source),
 *  look ({sdk, color, origin}: what the site asked the browser to look like)}
 */
const tabs = [];
/** {id, name, color, collapsed, desktop, split (0..1, the desktop's main divider), topics: [searches]} */
const groups = [];
let activeId = null;
let nextId = 1;
let nextGroup = 1;
const closedTabs = [];
const active = () => tabs.find((t) => t.id === activeId);
const byId = (id) => tabs.find((t) => t.id === id);
const groupById = (id) => groups.find((g) => g.id === id);
export const isInternal = (url) => /^roamer:/i.test(url || '');
const internalName = (url) => (url || '').slice(7).toLowerCase().split(/[?#]/)[0];
const isWeb = (t) => t && !isInternal(t.url);

/** What the user typed → an address. */
export function resolve(text) {
  const t = text.trim();
  if (!t) return null;
  if (isInternal(t)) return INTERNAL[internalName(t)] ? 'roamer:' + internalName(t) : 'roamer:start';
  // "? words" always searches (Ctrl+K / Ctrl+E start one)
  if (t.startsWith('?')) return t.slice(1).trim() ? searchUrl(t.slice(1).trim()) : null;
  // "e6 wolf": a search engine's keyword and what to look for
  const kw = E.keyword(t);
  if (kw && !/^(https?|file|about|data):/i.test(t)) return E.searchUrl(kw.engine, kw.query);
  if (/^(https?|file|about|data):/i.test(t)) return t;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /^[^\s/?#]+\.[a-z][a-z0-9-]{1,62}\.?(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t;
  return searchUrl(t);
}
/** An engine picked for the next search by scrolling over the address bar (or the start page's search box). */
let searchWith = null;
export const curEngine = () => (searchWith && E.byId(searchWith)) || E.all()[0];
export const searchUrl = (q, eng = curEngine()) => E.searchUrl(eng, q);
const homeUrl = () => (S.settings.home && resolve(S.settings.home)) || 'roamer:start';
const newTabUrl = () => {
  const n = S.settings.newTab;
  if (n === 'blank') return 'roamer:blank';
  if (n === 'home') return homeUrl();
  if (n === 'custom') return (S.settings.newTabPage && resolve(S.settings.newTabPage)) || 'roamer:start';
  return 'roamer:start';
};

function titleOf(t) {
  if (isInternal(t.url)) {
    const n = internalName(t.url);
    if (n === 'source') return 'Source · ' + (t.data ? hostOf(t.data.url) : '');
    return INTERNAL[n]?.title || 'Start';
  }
  return t.title || hostOf(t.url) || 'New tab';
}

export function newTab(url = newTabUrl(), { activate = true, after = activeId, pending = false, title = '', icon: ic = '', group = null, opener = null, data = null } = {}) {
  const t = { id: nextId++, url: '', title, icon: ic, loading: false, zoom: 1, live: false, pending: false, group, opener, data, topic: '' };
  const i = tabs.findIndex((x) => x.id === after);
  // tabs opened from a page sit right after it (and after its other children), like most browsers
  tabs.splice(i < 0 ? tabs.length : i + 1 + tabs.slice(i + 1).filter((x) => x.opener === after && opener === after).length, 0, t);
  normalize();
  if (pending && !isInternal(url)) Object.assign(t, { url, pending: true });
  else go(t, url, { quiet: true });
  if (activate) activate_(t.id, { focusPage: !isInternal(url) });
  else paintTabs(), think();
  saveSession();
  return t;
}

function go(t, url, { quiet, typed } = {}) {
  if (!url || !t) return;
  if (t.id === activeId) closeFind();
  // a new journey from the address bar: the tab is about whatever this search is (or nothing in particular)
  if (typed) t.topic = G.searchQuery(url);
  if (isInternal(url)) {
    if (t.live) send('drop', { id: t.id });
    Object.assign(t, { url, live: false, loading: false, icon: '', title: '', pending: false, audible: false, look: null });
  } else {
    if (!t.live) t.zoom = 1;
    if (hostOf(url) !== hostOf(t.url)) (t.icon = ''), (t.look = null);
    Object.assign(t, { url, title: '', live: true, loading: true, pending: false });
    send('nav', { id: t.id, url });
  }
  if (!quiet && t.id === activeId) present(!isInternal(url));
  else if (!quiet && deskTabs().includes(t)) present();
  else paintTabs();
  saveSession();
}

/** Navigate the current tab (or a new one). */
export function open(url, { newTab: inNew, background, typed } = {}) {
  if (!url) return;
  // a board search typed in the address bar belongs in Board Roamer
  if (typed && S.settings.boards === 'auto' && B.wants(url)) return handOff(url, { inNew });
  const t = active();
  if (inNew || background || t?.pinned && !isInternal(url) && hostOf(url) !== hostOf(t.url) && !typed) newTab(url, { activate: !background, group: t && deskOf(t) ? t.group : null });
  else go(t, url, { typed });
}

/** Show an image board link in Board Roamer; if that is not possible, open it here after all. */
const handing = new Map();
const stay = new Set(); // board addresses that Board Roamer could not take: they stay in the browser
export function handOff(url, { inNew, silent } = {}) {
  handing.set(url, { inNew });
  send('boardroamer', { url, path: S.settings.boardPath || '' });
  if (!silent) toast(`Opening ${B.boardName(url)} in Board Roamer…`, { ms: 2200 });
}
on('boardresult', (m) => {
  const h_ = handing.get(m.url);
  handing.delete(m.url);
  if (!h_ || m.ok) return;
  stay.add(m.url);
  const here = () => (h_.inNew ? newTab(m.url) : go(active(), m.url, { typed: true }));
  const why = {
    missing: 'Board Roamer isn’t installed here, or Web Roamer can’t find it. Opened on the site instead.',
    old: 'This Board Roamer is too old to take a search from Web Roamer. Update it and try again. Opened on the site instead.',
    start: 'Board Roamer wouldn’t start. Opened on the site instead.',
  }[m.why] || 'Board Roamer didn’t answer. Opened on the site instead.';
  here();
  toast(why, { err: true, ms: 7000, action: m.why === 'missing' ? 'Get Board Roamer' : 'Settings', run: () => (m.why === 'missing' ? open('https://github.com/Tox-EyE-CeaZY/Board-Roamer/releases', { newTab: true }) : openInternal('settings')) });
});

function activate_(id, { focusPage } = {}) {
  if (!byId(id)) return;
  const prev = activeId;
  activeId = id;
  const g = groupById(byId(id).group);
  if (g?.collapsed) g.collapsed = false;
  if (pageFs != null && pageFs !== id) leavePageFs();
  present(focusPage, prev);
  saveSession();
}

/** Load a restored tab the first time it is shown. */
function wake(t) {
  if (!t?.pending) return;
  t.pending = false;
  t.live = true;
  t.loading = true;
  send('nav', { id: t.id, url: t.url });
}

const inner = $('#inner');
function present(focusPage = false) {
  const t = active();
  if (!t) return;
  wake(t);
  t.seen = Date.now();
  const desk = deskOf(t);
  const internal = isInternal(t.url);
  root.classList.toggle('on-desk', !!desk);
  root.classList.toggle('on-internal', !desk && internal);
  root.classList.toggle('on-start', !desk && t.url === 'roamer:start');
  if (!desk && internal) renderPage(inner, internalName(t.url), api, null, t);
  else if (inner._page) {
    // leave nothing behind: coming back to the same page has to build it again (a stale one showed a blank start page)
    inner.replaceChildren();
    inner._page = null;
  }
  paintDesk(desk);
  layout();
  if (internal && !desk) send('focuschrome');
  else if (focusPage && t.live) send('focus', { id: t.id });
  paintTabs();
  paintBar();
  siteLook(false, true);
  scrollTabIntoView(t.id);
  think();
}

export function closeTab(id = activeId, { quiet } = {}) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  if (t.live) send('drop', { id: t.id });
  if (t.url !== 'roamer:start') closedTabs.push({ url: t.url, title: t.title, icon: t.icon, index: i, group: t.group, pinned: t.pinned });
  if (closedTabs.length > 25) closedTabs.shift();
  if (pageFs === id) leavePageFs();
  if (!tabs.length) {
    if (S.settings.lastTab === 'window' && !quiet) return closeWindow(true);
    normalize();
    newTab('roamer:start');
    return;
  }
  normalize();
  if (id === activeId) {
    // back to the tab that opened this one, else another page of the same desktop, else the neighbour on the right
    const sameDesk = t.group && tabs.filter((x) => x.group === t.group).sort((a, b) => (b.seen || 0) - (a.seen || 0))[0];
    const next = (t.opener && byId(t.opener)) || sameDesk || tabs[Math.min(i, tabs.length - 1)];
    activate_(next.id, { focusPage: true });
  } else if (deskTabs().length || t.group === active()?.group) present();
  else paintTabs();
  saveSession();
}

function reopenClosed() {
  const c = closedTabs.pop();
  if (!c) return;
  const t = newTab(c.url, { after: tabs[c.index - 1]?.id ?? null, title: c.title, icon: c.icon, group: groupById(c.group) ? c.group : null });
  if (c.pinned) setPinned(t, true);
  if (c.index === 0) moveTab(t.id, 0);
}

function moveTab(id, to) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  tabs.splice(clamp(to, 0, tabs.length), 0, t);
  normalize();
  paintTabs();
  saveSession();
}

const cycle = (d) => {
  const list = visibleTabs();
  const i = list.findIndex((t) => t.id === activeId);
  activate_(list[(i + d + list.length) % list.length].id, { focusPage: true });
};
/** Tabs as they appear in the strip (a collapsed group's tabs are skipped). */
const visibleTabs = () => tabs.filter((t) => t.id === activeId || !groupById(t.group)?.collapsed);

/** Pinned tabs first, and the tabs of a group always side by side; groups without tabs go away. */
function normalize() {
  const pinned = tabs.filter((t) => t.pinned);
  pinned.forEach((t) => (t.group = null));
  const rest = tabs.filter((t) => !t.pinned);
  const out = [...pinned];
  const done = new Set();
  for (const t of rest) {
    if (done.has(t.id)) continue;
    if (t.group && groupById(t.group)) {
      for (const x of rest) if (x.group === t.group && !done.has(x.id)) out.push(x), done.add(x.id);
    } else {
      t.group = null;
      out.push(t);
      done.add(t.id);
    }
  }
  tabs.splice(0, tabs.length, ...out);
  for (let i = groups.length - 1; i >= 0; i--) if (!tabs.some((t) => t.group === groups[i].id)) groups.splice(i, 1);
}

function setPinned(t, on) {
  t.pinned = on;
  if (on) t.group = null;
  normalize();
  present();
  saveSession();
}

function setMuted(t, on) {
  t.muted = on;
  if (t.live) send('mute', { id: t.id, on });
  paintTabs();
  saveSession();
}

const saveSession = debounce(() => {
  if (window.__secondary) return; // a second window leaves the first one's tabs alone
  S.saveSession({
    tabs: tabs.map((t) => ({ url: t.url === 'roamer:source' ? 'roamer:start' : t.url, title: t.title, icon: t.icon, pinned: !!t.pinned, muted: !!t.muted, group: t.group || null, topic: t.topic || '' })),
    groups: groups.map((g) => ({ ...g })),
    active: tabs.findIndex((t) => t.id === activeId),
  });
}, 400);

// ------------------------------------------------------------ tab groups
function createGroup(ids, name, { color, desktop = false, topics = [], edit = false } = {}) {
  const g = { id: nextGroup++, name: name || '', color: color || G.pickColor(name, groups), collapsed: false, desktop, split: 0.5, topics: topics.filter(Boolean) };
  groups.push(g);
  for (const id of ids) {
    const t = byId(id);
    if (t) (t.group = g.id), (t.pinned = false);
  }
  normalize();
  present();
  saveSession();
  if (edit) requestAnimationFrame(() => editGroup(g));
  return g;
}
/** Open a list of pages again as one tab group (a trail journey). */
function reopenAll(urls, name) {
  let after = activeId;
  const ids = urls.map((u, i) => {
    const t = newTab(u, { activate: i === 0, pending: i > 0, after });
    after = t.id;
    return t.id;
  });
  createGroup(ids, name);
}
function addToGroup(ids, gid) {
  const g = groupById(gid);
  if (!g) return;
  for (const id of ids) {
    const t = byId(id);
    if (!t) continue;
    t.group = gid;
    t.pinned = false;
    if (t.topic && !g.topics.includes(t.topic)) g.topics = [...g.topics, t.topic].slice(-8);
  }
  normalize();
  present();
  saveSession();
}
function ungroup(gid) {
  tabs.forEach((t) => t.group === gid && (t.group = null));
  normalize();
  present();
  saveSession();
}
async function closeGroup(gid) {
  const list = tabs.filter((t) => t.group === gid);
  if (list.length > 3 && !(await dialog({ title: `Close ${list.length} tabs?`, text: `Closes the group "${groupById(gid)?.name || 'Unnamed'}" and every tab in it.`, ok: 'Close group', danger: true }))) return;
  list.forEach((t) => closeTab(t.id, { quiet: true }));
}
function nameFor(list) {
  const topic = list.map((t) => t.topic).find(Boolean);
  if (topic) return G.topicName(topic);
  const web = list.filter(isWeb);
  if (web.length && web.every((t) => hostOf(t.url) === hostOf(web[0].url))) return G.siteName(web[0].url);
  const kind = web.length ? G.kindOf(web[0].url) : '';
  return kind && web.every((t) => G.kindOf(t.url) === kind) ? kind : '';
}

/** The little panel for naming, colouring and arranging a group. */
function editGroup(g, anchor) {
  anchor ||= tabsEl.querySelector(`.grp[data-g="${g.id}"]`);
  const name = h('input', { class: 'input', value: g.name, placeholder: 'Name this group', spellcheck: 'false' });
  name.addEventListener('input', () => ((g.name = name.value.slice(0, 40)), paintTabs(), saveSession()));
  name.addEventListener('keydown', (e) => e.key === 'Enter' && closePopover());
  const sw = h('div', { class: 'swatches' });
  const paintSw = () => sw.replaceChildren(...G.colorNames.map((c) => h('button', {
    class: 'sw' + (g.color === c ? ' on' : ''), title: c, style: { '--gh': G.COLORS[c] },
    onclick: () => ((g.color = c), paintSw(), paintTabs(), present(), saveSession()),
  })));
  paintSw();
  const n = tabs.filter((t) => t.group === g.id).length;
  const row = (ic, label, run, extra = '') => h('button', { class: 'pv-row ' + extra, onclick: () => (closePopover(), run()) }, h('i', { html: icon(ic, 15) }), h('span', {}, label));
  popover(h('div', { class: 'grp-edit', style: { '--gh': G.COLORS[g.color] } },
    h('div', { class: 'pv-kick' }, `TAB GROUP · ${n} TAB${n === 1 ? '' : 'S'}`),
    name, sw,
    h('div', { class: 'pv-rows' },
      row('plus', 'New tab in group', () => newTab(undefined, { after: tabs.filter((t) => t.group === g.id).pop()?.id, group: g.id })),
      row('desktop', g.desktop ? 'Back to one page at a time' : 'Desktop: show its pages side by side', () => setDesktop(g, !g.desktop)),
      row(g.collapsed ? 'eye' : 'minus', g.collapsed ? 'Expand' : 'Collapse', () => ((g.collapsed = !g.collapsed), paintTabs(), saveSession())),
      row('window', 'Move group to new window', () => moveToWindow(tabs.filter((t) => t.group === g.id))),
      row('layers', 'Ungroup', () => ungroup(g.id)),
      row('close', 'Close group', () => closeGroup(g.id), 'danger'))),
  { anchor, cls: 'pv-grp' });
  setTimeout(() => (name.focus(), name.select()), 30);
}

// ------------------------------------------------------------ smart groups
// The browser notices tabs that belong together (one search, one site, one kind of site) and offers to group them;
// in "auto" mode it just does it. Tabs opened from a grouped tab join that group; a new search about a group's
// subject is offered to (or put into) that group.
let offer = null;
const dismissed = new Set(S.memo.dismissed || []);
const think = debounce(() => {
  const mode = S.settings.smartGroups;
  const next = mode === 'off' ? null : G.suggest(tabs, groups, dismissed);
  if (next && mode === 'auto') return acceptOffer(next, true);
  if ((next?.key || null) !== (offer?.key || null)) {
    offer = next;
    paintTabs();
  }
}, 600);
function acceptOffer(s, auto) {
  offer = null;
  const ids = s.ids.filter(byId);
  if (!ids.length) return paintTabs();
  let g;
  if (s.into && groupById(s.into)) addToGroup(ids, s.into), (g = groupById(s.into));
  else g = createGroup(ids, s.name, { topics: [s.topic] });
  toast(auto ? `Grouped ${ids.length} tab${ids.length === 1 ? '' : 's'} into “${g.name}”` : `“${g.name}” · ${tabs.filter((t) => t.group === g.id).length} tabs`, {
    action: 'Undo', run: () => ids.forEach((id) => byId(id) && (byId(id).group = null)) || (dismiss(s), normalize(), present(), saveSession()),
  });
}
function dismiss(s) {
  dismissed.add(s.key);
  S.memo.dismissed = [...dismissed].slice(-200);
  S.saveMemo();
  offer = null;
  paintTabs();
  think();
}
/** Group everything that belongs together, in one go. */
function organize() {
  const plan = G.suggestAll(tabs, groups);
  if (!plan.length) return toast('Nothing to tidy up: no tabs share a search, a site or a kind of site yet');
  for (const s of plan) {
    if (s.into && groupById(s.into)) addToGroup(s.ids, s.into);
    else createGroup(s.ids, s.name, { topics: [s.topic] });
  }
  toast(`Made ${plan.length} group${plan.length === 1 ? '' : 's'} out of your tabs`);
}

// ------------------------------------------------------------ desktop: a group's pages side by side
const deskEl = h('div', { id: 'desk' });
$('#stage').append(deskEl);
const MAX_PANES = 6;
/** The group shown as a desktop when `t` is the active tab (null: one page at a time). */
function deskOf(t = active()) {
  const g = t && groupById(t.group);
  return g?.desktop && tabs.filter((x) => x.group === g.id).length >= 2 ? g : null;
}
/** The pages on the current desktop, in tab order (the most recently used ones when there are too many). */
function deskTabs(g = deskOf()) {
  if (!g) return [];
  let list = tabs.filter((t) => t.group === g.id);
  if (list.length > MAX_PANES) {
    const keep = new Set([...list].sort((a, b) => (b.id === activeId) - (a.id === activeId) || (b.seen || 0) - (a.seen || 0)).slice(0, MAX_PANES).map((t) => t.id));
    list = list.filter((t) => keep.has(t.id));
  }
  return list;
}
function setDesktop(g, on) {
  g.desktop = on;
  if (on && tabs.filter((t) => t.group === g.id).length < 2) {
    // a desktop of one: put a start page beside it to pick what goes there
    newTab('roamer:start', { after: tabs.filter((t) => t.group === g.id).pop()?.id, group: g.id, activate: false });
  }
  const t = active();
  if (on && t?.group !== g.id) activate_(tabs.find((x) => x.group === g.id).id);
  else present();
  saveSession();
}
/** Desktop for the current tab: its group's, or a new one with a start page beside the page. */
function toggleDesktop() {
  const t = active();
  if (!t) return;
  if (t.pinned) setPinned(t, false);
  const g = groupById(t.group);
  if (g) return setDesktop(g, !g.desktop);
  const ng = createGroup([t.id], nameFor([t]) || 'Desktop', { desktop: true });
  setDesktop(ng, true);
}
/** Put `other` next to the current page on a desktop. */
function showBeside(other) {
  const t = active();
  if (!t || other === t) return;
  let g = groupById(t.group);
  if (!g) g = createGroup([t.id], nameFor([t, other]) || 'Desktop');
  addToGroup([other.id], g.id);
  setDesktop(g, true);
}

/** Pane rectangles (stage coordinates) for n pages; `split` is where the main divider sits. */
function tile(n, split, W, H, gap = 10) {
  const sw = Math.round((W - gap) * split);
  const col = (x, w, rows) => Array.from({ length: rows }, (_, i) => {
    const rh = (H - gap * (rows - 1)) / rows;
    return { x, y: Math.round(i * (rh + gap)), w, h: Math.round(rh) };
  });
  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  if (n === 2) return [...col(0, sw, 1), ...col(sw + gap, W - sw - gap, 1)];
  if (n === 3) return [...col(0, sw, 1), ...col(sw + gap, W - sw - gap, 2)];
  if (n === 4) return [col(0, sw, 2)[0], col(sw + gap, W - sw - gap, 2)[0], col(0, sw, 2)[1], col(sw + gap, W - sw - gap, 2)[1]];
  const top = 3, bottom = n - 3;
  const row = (y, h, k) => Array.from({ length: k }, (_, i) => {
    const cw = (W - gap * (k - 1)) / k;
    return { x: Math.round(i * (cw + gap)), y, w: Math.round(cw), h };
  });
  const rh = Math.round((H - gap) / 2);
  return [...row(0, rh, top), ...row(rh + gap, H - rh - gap, bottom)];
}

const panes = new Map(); // tab id → {el, body, head}
let paneDrag = null;
function paintDesk(g) {
  if (!g) {
    for (const p of panes.values()) p.el.remove();
    panes.clear();
    deskEl.replaceChildren();
    return;
  }
  const list = deskTabs(g);
  for (const [id, p] of panes) if (!list.some((t) => t.id === id)) p.el.remove(), panes.delete(id);
  const W = deskEl.clientWidth, H = deskEl.clientHeight;
  const rects = tile(list.length, g.split ?? 0.5, W, H);
  deskEl.style.setProperty('--gh', G.COLORS[g.color]);
  list.forEach((t, i) => {
    wake(t);
    let p = panes.get(t.id);
    if (!p) {
      const body = h('div', { class: 'pane-b' }, h('div', { class: 'page-veil' }, h('span', {}, 'page tucked away while the menu is open')));
      const head = h('div', { class: 'pane-h', draggable: 'true' });
      const el = h('section', {
        class: 'pane', dataset: { id: t.id },
        onpointerdown: (e) => !e.target.closest('.pane-x') && t.id !== activeId && focusPane(t.id),
        ondragover: (e) => paneDrag != null && paneDrag !== t.id && (e.preventDefault(), el.classList.add('drop')),
        ondragleave: () => el.classList.remove('drop'),
        ondrop: (e) => {
          e.preventDefault();
          el.classList.remove('drop');
          if (paneDrag == null || paneDrag === t.id) return;
          // swap the two pages' places
          const a = tabs.findIndex((x) => x.id === paneDrag), b = tabs.findIndex((x) => x.id === t.id);
          [tabs[a], tabs[b]] = [tabs[b], tabs[a]];
          present();
          saveSession();
        },
      }, head, body);
      head.addEventListener('dragstart', (e) => ((paneDrag = t.id), (e.dataTransfer.effectAllowed = 'move'), e.dataTransfer.setData('text/plain', t.url)));
      head.addEventListener('dragend', () => (paneDrag = null));
      head.addEventListener('dblclick', () => setDesktop(g, false));
      p = { el, body, head };
      panes.set(t.id, p);
    }
    const r = rects[i];
    Object.assign(p.el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    p.el.classList.toggle('on', t.id === activeId);
    p.el.classList.toggle('loading', !!t.loading);
    p.head.replaceChildren(
      h('span', { class: 'pane-ic' }, t.loading ? h('i', { class: 'spin' }) : isInternal(t.url) ? h('i', { html: icon(INTERNAL[internalName(t.url)]?.icon || 'compass', 13) }) : favicon(t.icon, 13)),
      h('span', { class: 'pane-t' }, titleOf(t)),
      h('span', { class: 'pane-u' }, isInternal(t.url) ? '' : hostOf(t.url)),
      h('button', { class: 'pane-x', title: 'Show only this page', onclick: () => (activate_(t.id), setDesktop(g, false)), html: icon('maximize', 13) }),
      h('button', { class: 'pane-x', title: 'Take this page off the desktop', onclick: () => takeOff(t), html: icon('popout', 13) }),
      h('button', { class: 'pane-x', title: 'Close', onclick: () => closeTab(t.id), html: icon('close', 13) }));
    p.body.classList.toggle('web', !isInternal(t.url));
    if (isInternal(t.url)) {
      if (!p.inner) p.inner = h('div', { class: 'pane-inner' }), p.body.append(p.inner);
      renderPage(p.inner, internalName(t.url), api, null, t);
    } else if (p.inner) p.inner.remove(), (p.inner = null);
    if (!p.el.isConnected) deskEl.append(p.el);
  });
  // the main divider, draggable
  let split = deskEl.querySelector('.desk-split');
  if (list.length >= 2 && list.length <= 4) {
    if (!split) {
      split = h('div', { class: 'desk-split', title: 'Drag to resize' });
      split.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        split.setPointerCapture(e.pointerId);
        const r = deskEl.getBoundingClientRect();
        const move = (ev) => {
          const gg = deskOf();
          if (!gg) return;
          gg.split = clamp((ev.clientX - r.left) / r.width, 0.18, 0.82);
          paintDesk(gg);
          layout();
        };
        const up = () => (split.removeEventListener('pointermove', move), split.removeEventListener('pointerup', up), saveSession());
        split.addEventListener('pointermove', move);
        split.addEventListener('pointerup', up);
      });
      deskEl.append(split);
    }
    split.style.left = rects[0].x + rects[0].w + 'px';
  } else split?.remove();
}
function focusPane(id) {
  if (!byId(id) || id === activeId) return;
  activeId = id;
  for (const [pid, p] of panes) p.el.classList.toggle('on', pid === id);
  const t = active();
  if (isInternal(t.url)) send('focuschrome');
  paintTabs();
  paintBar();
  siteLook();
  saveSession();
}
function takeOff(t) {
  t.group = null;
  normalize();
  const g = deskOf();
  if (!g && t.id !== activeId) present();
  else present();
  saveSession();
}

// ------------------------------------------------------------ where pages go
const pageEl = $('#page');
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
function layout() {
  const t = active();
  const views = [];
  if (pageFs != null && byId(pageFs)?.live) views.push({ id: pageFs, x: 0, y: 0, w: innerWidth, h: innerHeight });
  else if (deskOf(t)) {
    for (const x of deskTabs()) if (x.live && !isInternal(x.url) && panes.get(x.id)) views.push({ id: x.id, ...rectOf(panes.get(x.id).body) });
  } else if (t?.live && !isInternal(t.url)) views.push({ id: t.id, ...rectOf(pageEl) });
  send('layout', { views });
}
new ResizeObserver(() => {
  if (deskOf()) paintDesk(deskOf());
  layout();
}).observe($('#stage'));
addEventListener('resize', layout);

// page full screen (a video's full screen button): the page takes the whole window until it lets go
let pageFs = null, fsByPage = false;
function enterPageFs(id) {
  pageFs = id;
  root.classList.add('page-fs');
  if (!root.classList.contains('fullscreen')) (fsByPage = true), send('win', { c: 'fson' });
  layout();
}
function leavePageFs() {
  if (pageFs == null) return;
  pageFs = null;
  root.classList.remove('page-fs');
  if (fsByPage) send('win', { c: 'fsoff' });
  fsByPage = false;
  layout();
}

// ------------------------------------------------------------ title bar + tab strip
const tabsEl = h('div', { class: 'tabstrip', id: 'tabs' });
const maxBtn = h('button', { class: 'tb-btn', title: 'Maximize', onclick: () => send('win', { c: 'max' }), html: icon('winMax', 14) });
function buildTitlebar() {
  const drag = {
    onmousedown: (e) => e.button === 0 && e.detail === 1 && e.target.closest('.tb-drag') && send('win', { c: 'drag' }),
    ondblclick: () => send('win', { c: 'max' }),
  };
  const bar = $('#titlebar');
  bar.append(
    h('div', { class: 'tb-drag tb-left', ...drag },
      h('span', { class: 'tb-mark', html: `<svg viewBox="0 0 40 40" width="16" height="16">${MARK}</svg>` }),
      h('span', { class: 'tb-name' }, 'WEB', h('i', {}, '/'), 'ROAMER')),
    h('div', { class: 'tb-tabs' }, tabsEl,
      h('button', { class: 'tab-new', title: 'New tab (Ctrl+T)', onclick: () => newTab(undefined, { group: deskOf() ? active().group : null }), html: icon('plus', 15) })),
    h('div', { class: 'tb-drag tb-fill', ...drag }),
    h('button', { class: 'tb-btn tb-search', title: 'Search tabs (Ctrl+Shift+A)', onclick: (e) => tabSearch(e.currentTarget), html: icon('chevDown', 15) }),
    plat === 'windows' || plat === 'linux'
      ? h('div', { class: 'tb-btns' },
        h('button', { class: 'tb-btn', title: 'Minimize', onclick: () => send('win', { c: 'min' }), html: icon('winMin', 14) }),
        maxBtn,
        h('button', { class: 'tb-btn close', title: 'Close', onclick: () => closeWindow(), html: icon('close', 14) }))
      : null,
  );
  // a mouse wheel over the tabs scrolls them sideways
  tabsEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) (tabsEl.scrollLeft += e.deltaY), e.preventDefault();
  }, { passive: false });
  // invisible edge handles so the undecorated window can still be resized
  if (plat === 'windows' || plat === 'linux') {
    for (const d of ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']) {
      document.body.append(h('i', { class: 'rz rz-' + d, onmousedown: (e) => (e.preventDefault(), send('win', { c: 'resize:' + d })) }));
    }
  }
}

async function closeWindow(force) {
  const live = tabs.filter((t) => !isInternal(t.url)).length;
  if (!force && S.settings.askClose && !S.settings.restoreTabs && live > 1) {
    const ok = await dialog({ title: `Close ${tabs.length} tabs?`, text: 'Turn on "Reopen tabs" in Settings to get them back next time.', ok: 'Close all', danger: true });
    if (!ok) return;
  }
  saveSession.flush();
  send('win', { c: 'close' });
}

let dragId = null;
function tabEl(t, g) {
  const lk = Look.tabLook(tabTheme(t));
  const el = h('div', {
    class: 'tab-i' + (lk ? ' looked' : '') + (t.id === activeId ? ' on' : '') + (t.loading ? ' loading' : '') + (t.pinned ? ' pin' : '') + (g ? ' in-grp' : '')
      + (deskTabs().includes(t) ? ' on-desk' : '') + (offer?.ids.includes(t.id) ? ' offered' : ''),
    title: titleOf(t) + (isInternal(t.url) ? '' : '\n' + t.url) + (t.muted ? '\n(muted)' : ''),
    draggable: 'true',
    style: { ...(g ? { '--gh': G.COLORS[g.color] } : null), ...lk?.style },
    dataset: { id: t.id, ...(lk?.shape ? { ts: lk.shape } : null), ...(lk?.tabStyle ? { tstyle: lk.tabStyle } : null) },
    onmousedown: (e) => e.button === 0 && !e.target.closest('.ti-x, .ti-snd') && t.id !== activeId && activate_(t.id, { focusPage: true }),
    onauxclick: (e) => e.button === 1 && (e.preventDefault(), closeTab(t.id)),
    oncontextmenu: (e) => (e.preventDefault(), tabMenu(t, e.clientX, e.clientY)),
    ondragstart: (e) => ((dragId = t.id), e.dataTransfer.setData('text/plain', t.url), (e.dataTransfer.effectAllowed = 'move')),
    ondragend: () => ((dragId = null), tabsEl.querySelectorAll('.drop-l,.drop-r,.drop').forEach((x) => x.classList.remove('drop-l', 'drop-r', 'drop'))),
    ondragover: (e) => {
      if (dragId == null) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(), left = e.clientX < r.left + r.width / 2;
      el.classList.toggle('drop-l', left);
      el.classList.toggle('drop-r', !left);
    },
    ondragleave: () => el.classList.remove('drop-l', 'drop-r'),
    ondrop: (e) => {
      e.preventDefault();
      const d = byId(dragId);
      if (!d || d === t) return;
      const left = el.classList.contains('drop-l');
      // the dragged tab joins whatever it lands among: the pinned tabs, a group, or the loose tabs
      d.pinned = !!t.pinned;
      d.group = t.pinned ? null : t.group;
      const from = tabs.indexOf(d);
      let to = tabs.indexOf(t) + (left ? 0 : 1);
      if (from < to) to--;
      moveTab(d.id, to);
      present();
    },
  },
  h('span', { class: 'ti-ic' }, t.loading ? h('i', { class: 'spin' }) : isInternal(t.url) ? h('i', { html: icon(INTERNAL[internalName(t.url)]?.icon || 'compass', 14) }) : favicon(t.icon, 14)),
  t.pinned ? null : h('span', { class: 'ti-t' }, titleOf(t)),
  t.audible || t.muted
    ? h('button', { class: 'ti-snd' + (t.muted ? ' muted' : ''), title: t.muted ? 'Unmute tab' : 'Mute tab', onclick: (e) => (e.stopPropagation(), setMuted(t, !t.muted)), html: icon(t.muted ? 'muted' : 'speaker', 13) })
    : null,
  t.pinned ? null : h('button', { class: 'ti-x', title: 'Close tab (Ctrl+W)', onclick: (e) => (e.stopPropagation(), closeTab(t.id)), html: icon('close', 11) }));
  return el;
}
function groupChip(g) {
  const n = tabs.filter((t) => t.group === g.id).length;
  return h('button', {
    class: 'grp' + (g.collapsed ? ' shut' : '') + (g.id === active()?.group ? ' cur' : '') + (g.desktop ? ' desk' : ''),
    style: { '--gh': G.COLORS[g.color] }, dataset: { g: g.id },
    title: `${g.name || 'Unnamed group'} · ${n} tab${n === 1 ? '' : 's'}${g.desktop ? ' · desktop' : ''}\nClick to ${g.collapsed ? 'expand' : 'collapse'}, right-click for more`,
    onclick: () => {
      g.collapsed = !g.collapsed;
      if (g.collapsed && active()?.group === g.id) {
        // collapsing the group you're in moves you to the nearest tab outside it
        const out = tabs.find((t) => t.group !== g.id);
        if (out) return activate_(out.id), saveSession();
        g.collapsed = false;
      }
      paintTabs();
      saveSession();
    },
    oncontextmenu: (e) => (e.preventDefault(), editGroup(g, e.currentTarget)),
    ondragover: (e) => dragId != null && (e.preventDefault(), e.currentTarget.classList.add('drop')),
    ondragleave: (e) => e.currentTarget.classList.remove('drop'),
    ondrop: (e) => {
      e.preventDefault();
      if (dragId != null) addToGroup([dragId], g.id);
    },
  }, h('span', {}, g.desktop ? h('i', { html: icon('desktop', 12) }) : null, h('b', {}, g.name || (g.collapsed ? '' : '·')), g.collapsed || !g.name ? h('em', {}, n) : null));
}
function offerChip(s) {
  return h('div', { class: 'offer', title: s.why + '\nOr turn this off in Settings → Tabs & groups', onmouseenter: () => tabsEl.classList.add('show-offer'), onmouseleave: () => tabsEl.classList.remove('show-offer') },
    h('button', { class: 'offer-go', onclick: () => acceptOffer(s) },
      h('i', { html: icon('sparkle', 12) }),
      h('span', {}, s.into ? `Add ${s.ids.length} to ` : `Group ${s.ids.length} · `, h('b', {}, s.name))),
    h('button', { class: 'offer-x', title: 'Not now', onclick: () => dismiss(s), html: icon('close', 10) }));
}
function paintTabs() {
  const out = [];
  const seenG = new Set();
  for (const t of tabs) {
    const g = groupById(t.group);
    if (g && !seenG.has(g.id)) seenG.add(g.id), out.push(groupChip(g));
    if (g?.collapsed && t.id !== activeId) continue;
    out.push(tabEl(t, g));
  }
  if (offer && offer.ids.some(byId)) out.push(offerChip(offer));
  tabsEl.replaceChildren(...out);
  root.classList.toggle('many-tabs', tabs.length > 1);
  deskBtn.classList.toggle('on', !!deskOf());
}
const scrollTabIntoView = (id) => tabsEl.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

function moveToWindow(list) {
  for (const t of list) if (isWeb(t)) send('newwindow', { url: t.url });
  list.forEach((t) => closeTab(t.id, { quiet: true }));
}

function tabMenu(t, x, y) {
  const i = tabs.indexOf(t);
  const g = groupById(t.group);
  const others = groups.filter((x) => x.id !== t.group);
  showMenu([
    { label: 'New tab to the right', icon: 'plus', run: () => newTab(undefined, { after: t.id, group: t.group }) },
    {
      label: g ? 'Move to group' : 'Add to group', icon: 'group', disabled: t.pinned,
      sub: () => [
        { label: 'New group', icon: 'plus', run: () => createGroup([t.id], nameFor([t]), { edit: true }) },
        others.length ? { sep: true } : null,
        ...others.map((o) => ({ label: o.name || 'Unnamed group', img: h('i', { class: 'grp-dot', style: { '--gh': G.COLORS[o.color] } }), run: () => addToGroup([t.id], o.id) })),
      ],
    },
    g && { label: 'Remove from group', icon: 'layers', run: () => takeOff(t) },
    t.id !== activeId ? { label: 'Show beside this tab (desktop)', icon: 'desktop', run: () => showBeside(t) } : null,
    { sep: true },
    { label: 'Reload', icon: 'reload', disabled: !t.live, run: () => send('reload', { id: t.id }) },
    { label: 'Duplicate', icon: 'copy', run: () => newTab(t.url, { after: t.id, group: t.group }) },
    { label: t.pinned ? 'Unpin' : 'Pin', icon: 'pin', run: () => setPinned(t, !t.pinned) },
    { label: t.muted ? 'Unmute tab' : 'Mute tab', icon: t.muted ? 'speaker' : 'muted', disabled: !isWeb(t), run: () => setMuted(t, !t.muted) },
    { label: S.bookmarkOf(t.url) ? 'Remove bookmark' : 'Bookmark this tab', icon: 'star', disabled: !isWeb(t), run: () => toggleBookmark(t) },
    { label: 'Copy address', icon: 'link', disabled: !isWeb(t), run: () => copyText(t.url).then(() => toast('Address copied')) },
    { label: 'Move to new window', icon: 'window', disabled: !isWeb(t), run: () => moveToWindow([t]) },
    { sep: true },
    { label: 'Close tab', icon: 'close', kbd: 'Ctrl+W', run: () => closeTab(t.id) },
    { label: 'Close other tabs', disabled: tabs.length < 2, run: () => tabs.filter((x) => x !== t && !x.pinned).forEach((x) => closeTab(x.id)) },
    { label: 'Close tabs to the right', disabled: i === tabs.length - 1, run: () => tabs.slice(i + 1).forEach((x) => closeTab(x.id)) },
    { sep: true },
    { label: 'Reopen closed tab', icon: 'restore', kbd: 'Ctrl+Shift+T', disabled: !closedTabs.length, run: reopenClosed },
    { label: 'Organize tabs', icon: 'sparkle', run: organize },
  ], x, y);
}

/** Find an open tab by typing (Ctrl+Shift+A), with the recently closed ones under it. */
function tabSearch(anchor) {
  const input = h('input', { class: 'input tq-q', placeholder: 'Search open tabs', spellcheck: 'false' });
  const list = h('div', { class: 'tq-list' });
  let items = [], cur = 0;
  const paint = () => {
    const f = input.value.trim().toLowerCase();
    const m = (x) => !f || (titleOf(x) + ' ' + x.url).toLowerCase().includes(f);
    items = [
      ...tabs.filter(m).map((t) => ({ t })),
      ...closedTabs.slice().reverse().filter((c) => !f || (c.title + ' ' + c.url).toLowerCase().includes(f)).slice(0, 6).map((c) => ({ c })),
    ];
    cur = clamp(cur, 0, Math.max(0, items.length - 1));
    let closedHead = false;
    list.replaceChildren(...items.flatMap((it, i) => {
      const row = (ic, title, sub, extra) => h('button', { class: 'tq-i' + (i === cur ? ' hi' : ''), onclick: () => pick(it), onmouseenter: () => ((cur = i), paint()) },
        h('span', { class: 'tq-ic' }, ic), h('span', { class: 'tq-t' }, title), h('span', { class: 'tq-u' }, sub), extra);
      if (it.t) {
        const g = groupById(it.t.group);
        return [row(isInternal(it.t.url) ? h('i', { html: icon('compass', 14) }) : favicon(it.t.icon, 14), titleOf(it.t), isInternal(it.t.url) ? '' : hostOf(it.t.url),
          g ? h('i', { class: 'grp-dot', title: g.name, style: { '--gh': G.COLORS[g.color] } }) : it.t.id === activeId ? h('em', {}, 'here') : null)];
      }
      const head = closedHead ? [] : [h('div', { class: 'cm-head' }, 'Recently closed')];
      closedHead = true;
      return [...head, row(favicon(it.c.icon, 14), it.c.title || it.c.url, hostOf(it.c.url), null)];
    }), !items.length ? h('p', { class: 'empty-note' }, 'No tab matches that') : null);
  };
  const pick = (it) => {
    closePopover();
    if (it.t) activate_(it.t.id, { focusPage: true });
    else {
      const i = closedTabs.indexOf(it.c);
      if (i >= 0) closedTabs.splice(i, 1);
      newTab(it.c.url, { title: it.c.title, icon: it.c.icon });
    }
  };
  input.addEventListener('input', () => ((cur = 0), paint()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault(), (cur = clamp(cur + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1)), paint();
    else if (e.key === 'Enter' && items[cur]) e.preventDefault(), pick(items[cur]);
  });
  paint();
  send('focuschrome');
  popover(h('div', { class: 'tsearch' }, h('div', { class: 'tq-top' }, input,
    h('button', { class: 'chipbtn', title: 'Group the tabs that belong together', onclick: () => (closePopover(), organize()) }, '✦ Organize')), list),
  { anchor: anchor || $('.tb-search'), align: 'right', cls: 'pv-tabs' });
  setTimeout(() => input.focus(), 20);
}

// ------------------------------------------------------------ toolbar + address bar
const q = h('input', { id: 'q', class: 'q', spellcheck: 'false', autocomplete: 'off', placeholder: 'Search or enter an address' });
const pretty = h('div', { class: 'addr-pretty' });
const addrIc = h('button', { class: 'a-ic', onclick: () => siteInfo() });
const zoomChip = h('button', { class: 'zoom-chip', title: 'Reset zoom (Ctrl+0)', onclick: () => setZoom(S.settings.defaultZoom || 1) });
const lookChip = h('button', { class: 'a-btn look-chip', onclick: () => lookOffer(), html: icon('brush', 16) });
const star = h('button', { class: 'a-btn', title: 'Bookmark this page (Ctrl+D)', onclick: () => toggleBookmark(active()) });
const go_ = h('button', { class: 'go', title: 'Go', onclick: () => submit(), html: icon('go', 18) });
const engChip = h('button', { class: 'eng-chip', hidden: true, title: 'Search with… (scroll over the address bar to switch)', onmousedown: (e) => e.preventDefault(), onclick: (e) => (engChip._hint ? (pickEngine(engChip._hint.id), q.focus()) : engineMenu(e.currentTarget)) });
const boardChip = h('button', { class: 'a-btn board-chip', hidden: true, title: 'Open this in Board Roamer', onclick: () => handOff(active().url), html: icon('layers', 16) });
const field = h('div', { class: 'field cut' }, addrIc, h('div', { class: 'q-wrap' }, q, pretty), engChip, zoomChip, boardChip, lookChip, star, go_);
const sugg = h('div', { class: 'sugg cut', hidden: true });
const btn = (ic, title, run, extra = {}) => h('button', { class: 'ibtn', title, onclick: run, html: icon(ic, 19), ...extra });
const backBtn = btn('back', 'Back (Alt+Left)', () => send('back', { id: activeId }));
const fwdBtn = btn('forward', 'Forward (Alt+Right)', () => send('fwd', { id: activeId }));
const reloadBtn = btn('reload', 'Reload (Ctrl+R)', () => reloadOrStop());
const homeBtn = btn('home', 'Home (Alt+Home)', () => open(homeUrl()), { class: 'ibtn home-btn' });
const deskBtn = btn('desktop', 'Desktop: this tab\'s group side by side', () => toggleDesktop());
const dlBtn = btn('download', 'Downloads (Ctrl+J)', () => openInternal('downloads'));
const dlBadge = h('i', { class: 'dotbadge', hidden: true });
dlBtn.append(dlBadge);
const menuBtn = btn('more', 'Menu (Alt+F)', (e) => mainMenu(e.currentTarget));
const updDot = h('i', { class: 'upd-dot', hidden: true });
menuBtn.append(updDot);

function buildToolbar() {
  $('#toolbar').append(
    h('div', { class: 'nav-btns' }, backBtn, fwdBtn, reloadBtn, homeBtn),
    h('div', { class: 'addr' }, field, sugg),
    h('div', { class: 'tool-btns' },
      deskBtn,
      btn('bookmarks', 'Bookmarks (Ctrl+Shift+O)', () => openInternal('bookmarks')),
      btn('history', 'History (Ctrl+H)', () => openInternal('history')),
      dlBtn,
      menuBtn),
  );
  for (const b of [backBtn, fwdBtn]) b.addEventListener('auxclick', (e) => e.button === 1 && toast('Middle-click history lists are not here yet'));
  // the first click into the address selects all of it (later clicks place the caret)
  q.addEventListener('mousedown', (e) => {
    if (document.activeElement === q) return;
    e.preventDefault();
    send('focuschrome');
    q.focus();
  });
  // scrolling over the address bar flips through the search engines
  field.addEventListener('wheel', (e) => {
    if (e.target.closest('.a-btn, .ibtn') || Math.abs(e.deltaY) < 1) return;
    e.preventDefault();
    cycleEngine(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  q.addEventListener('focus', () => {
    field.classList.add('focus');
    paintEngChip();
    if (!field.classList.contains('edited')) q.select();
  });
  q.addEventListener('blur', () => {
    field.classList.remove('focus');
    if (!field.classList.contains('edited')) searchWith = null;
    paintEngChip();
    setTimeout(() => {
      if (document.activeElement !== q) hideSugg();
    }, 150);
    paintAddress();
  });
  q.addEventListener('input', (e) => {
    field.classList.add('edited');
    typed = q.value;
    autocomplete(e.inputType || '');
    paintEngChip();
    suggest();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Ctrl+Enter: "example" → www.example.com
      if (e.ctrlKey && !e.altKey && /^[\w-]+$/.test(q.value.trim())) q.value = `www.${q.value.trim()}.com`, (suggIndex = -1), (suggItems = []);
      submit(e.altKey || (e.ctrlKey && e.shiftKey));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!sugg.hidden) return hideSugg();
      field.classList.remove('edited');
      searchWith = null;
      paintAddress(true);
      q.blur();
      const t = active();
      if (t?.live) send('focus', { id: t.id });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (sugg.hidden) return;
      e.preventDefault();
      moveSugg(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Delete' && e.shiftKey && suggItems[suggIndex]?.kind === 'history') {
      // Shift+Delete forgets a history suggestion, like other browsers
      e.preventDefault();
      const u = suggItems[suggIndex].url;
      S.removeVisits((x) => x.url === u);
      suggest();
    }
  });
}

function reloadOrStop() {
  const t = active();
  if (!t?.live) return;
  send(t.loading ? 'stop' : 'reload', { id: t.id });
}

function submit(inNew) {
  const pick = suggItems[suggIndex];
  // read the address before blurring: the blur puts the page's own address back in the field
  const url = pick ? pick.url : resolve(q.value);
  hideSugg();
  field.classList.remove('edited');
  q.blur();
  searchWith = null;
  paintEngChip();
  if (pick?.kind === 'tab') return activate_(pick.id, { focusPage: true });
  if (!url) return;
  open(url, { newTab: inNew, typed: true });
}

function paintAddress(force) {
  const t = active();
  if (!t) return;
  if (document.activeElement === q && !force) return;
  if (field.classList.contains('edited') && !force) return;
  const internal = isInternal(t.url);
  const bare = t.url === 'roamer:start' || t.url === 'roamer:blank';
  q.value = internal && bare ? '' : internal ? 'roamer:' + internalName(t.url) : t.url;
  let secure = false;
  pretty.replaceChildren();
  if (!internal) {
    try {
      const u = new URL(t.url);
      secure = u.protocol === 'https:';
      pretty.append(
        h('span', { class: 'p-scheme' }, u.protocol === 'https:' ? '' : u.protocol + '//'),
        h('span', { class: 'p-host' }, u.host),
        h('span', { class: 'p-rest' }, (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash));
    } catch {
      pretty.append(h('span', { class: 'p-host' }, t.url));
    }
  } else if (!bare) pretty.append(h('span', { class: 'p-scheme' }, 'roamer:'), h('span', { class: 'p-host' }, internalName(t.url)));
  const http = t.url.startsWith('http:');
  addrIc.innerHTML = icon(internal ? 'compass' : secure ? 'lock' : http ? 'unlock' : 'globe', 16);
  addrIc.className = 'a-ic' + (secure ? ' secure' : '') + (http ? ' insecure' : '');
  addrIc.title = internal ? 'Web Roamer page' : (secure ? 'Secure connection' : http ? 'This connection is not encrypted' : 'Local or special page') + ' · site info';
}

function paintBar() {
  const t = active();
  if (!t) return;
  paintAddress();
  const web = t.live && !isInternal(t.url);
  backBtn.disabled = fwdBtn.disabled = !web;
  reloadBtn.disabled = !web;
  reloadBtn.innerHTML = icon(t.loading ? 'close' : 'reload', 19);
  reloadBtn.title = t.loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)';
  const bm = !isInternal(t.url) && S.bookmarkOf(t.url);
  star.innerHTML = icon(bm ? 'starOn' : 'star', 16);
  star.classList.toggle('lit', !!bm);
  star.hidden = isInternal(t.url);
  zoomChip.hidden = !web || Math.abs(t.zoom - (S.settings.defaultZoom || 1)) < 0.001;
  zoomChip.textContent = Math.round(t.zoom * 100) + '%';
  paintLookChip();
  boardChip.hidden = !web || S.settings.boards === 'off' || !B.wants(t.url);
  root.classList.toggle('loading', !!t.loading);
  const title = titleOf(t);
  document.title = `${title} · Web Roamer`;
  send('title', { s: `${title} - Web Roamer` });
}

/** The lock (or globe): who this is, the zoom here, the site's look, a few shortcuts. */
function siteInfo() {
  const t = active();
  if (!t) return;
  if (isInternal(t.url)) return toast('This is one of Web Roamer’s own pages');
  let u;
  try {
    u = new URL(t.url);
  } catch {
    return;
  }
  const secure = u.protocol === 'https:';
  const hn = u.hostname;
  const zv = h('b', {}, Math.round(t.zoom * 100) + '%');
  const zoomBy = (d) => (zoomStep(d), (zv.textContent = Math.round(active().zoom * 100) + '%'));
  const look = t.look;
  const choice = S.themeSites[originOf(t.url)];
  const row = (ic, label, run, cls = '') => h('button', { class: 'pv-row ' + cls, onclick: () => (closePopover(), run()) }, h('i', { html: icon(ic, 15) }), h('span', {}, label));
  popover(h('div', { class: 'site-info' },
    h('div', { class: 'si-host' }, favicon(t.icon, 18, hn), h('b', {}, hn)),
    h('div', { class: 'si-sec ' + (secure ? 'ok' : u.protocol === 'http:' ? 'bad' : '') },
      h('i', { html: icon(secure ? 'lock' : u.protocol === 'http:' ? 'unlock' : 'globe', 15) }),
      h('span', {}, secure ? 'Connection is secure: what you send this site is encrypted.' : u.protocol === 'http:' ? 'Not secure: don’t type passwords or card numbers here.' : 'A local or special page.')),
    h('div', { class: 'si-row' }, h('span', {}, 'Zoom on this site'),
      h('button', { class: 'ibtn sm', onclick: () => zoomBy(-1), html: icon('minus', 14) }), zv,
      h('button', { class: 'ibtn sm', onclick: () => zoomBy(1), html: icon('plus', 14) }),
      h('button', { class: 'chipbtn', onclick: () => (setZoom(S.settings.defaultZoom || 1), (zv.textContent = Math.round(active().zoom * 100) + '%')) }, 'reset')),
    look?.sdk
      ? h('div', { class: 'si-row' }, h('span', {}, 'This site’s look for Web Roamer'),
        h('div', { class: 'seg' }, ...[['allow', 'Use'], ['block', 'Don’t']].map(([v, l]) => h('button', {
          class: 'seg-b' + ((choice || (S.settings.siteThemes === 'on' ? 'allow' : '')) === v ? ' on' : ''),
          onclick: () => (S.setThemeSite(originOf(t.url), v), closePopover(), siteLook(true, true)),
        }, l))))
      : null,
    h('div', { class: 'pv-rows' },
      row('link', 'Copy address', () => copyText(t.url).then(() => toast('Address copied'))),
      row('history', 'History of this site', () => openInternal('history', { filter: hn })),
      row('trash', 'Forget this site in history', () => {
        const n = S.history.filter((e) => hostOf(e.url) === hostOf(t.url)).length;
        S.removeVisits((e) => hostOf(e.url) === hostOf(t.url));
        toast(`Removed ${n} visit${n === 1 ? '' : 's'} to ${hostOf(t.url)}`);
      }),
      row('code', 'View page source', () => viewSource()))),
  { anchor: addrIc, cls: 'pv-site' });
}

// ------------------------------------------------------------ search engines
/** The engine the next search would use: a typed keyword, one scrolled to, or the default. */
function typedEngine() {
  const kw = E.keyword(q.value || '');
  return kw?.engine || null;
}
/** The engine of the site being viewed, if it has one of its own (a hint while the address bar is empty). */
function siteEngine() {
  const t = active();
  if (!t || isInternal(t.url)) return null;
  const hn = hostOf(t.url).replace(/^www\./, '');
  return E.all().find((e) => !e.def && e.url.includes('//') && hostOf(e.url).replace(/^www\./, '') === hn) || null;
}
function paintEngChip() {
  const kw = typedEngine();
  const focused = document.activeElement === q;
  const hint = !kw && !searchWith && focused && !q.value.trim() ? siteEngine() : null;
  engChip._hint = hint;
  const eng = kw || hint || curEngine();
  engChip.hidden = !(kw || searchWith || focused);
  engChip.classList.toggle('picked', !!kw || !!searchWith);
  engChip.classList.toggle('hint', !!hint);
  engChip.replaceChildren(h('span', {}, hint ? 'Search ' + eng.name : eng.name), eng.key ? h('kbd', {}, eng.key) : null);
  if (typeof startLiveRefresh === 'function') startLiveRefresh();
}
function cycleEngine(d) {
  const list = E.all();
  if (list.length < 2) return;
  if (document.activeElement !== q) focusAddress(q.value && field.classList.contains('edited') ? q.value : '');
  const cur = Math.max(0, list.findIndex((e) => e.id === curEngine().id));
  const next = list[(cur + d + list.length) % list.length];
  searchWith = next.id === list[0].id ? null : next.id;
  paintEngChip();
  engChip.classList.remove('flip');
  void engChip.offsetWidth;
  engChip.classList.add('flip');
  if (typed.trim()) suggest();
}
export function pickEngine(id) {
  searchWith = id === E.all()[0].id ? null : id;
  paintEngChip();
}
function engineMenu(anchor) {
  const list = E.all();
  const r = anchor.getBoundingClientRect();
  showMenu([
    { header: 'Search with' },
    ...list.map((e) => ({ label: e.name, kbd: e.key || null, checked: e.id === curEngine().id, run: () => (pickEngine(e.id), q.focus()) })),
    { sep: true },
    { label: 'Search engines…', icon: 'settings', run: () => openInternal('settings', { section: 'search' }) },
  ], r.left, r.bottom + 4);
}
// a site told us how it searches: add it, with a keyword
on('engine', (m) => {
  const e = E.found(m);
  // say so the first few times, then keep quiet: most sites have a search
  if (e && (S.memo.engineToasts || 0) < 3) {
    S.memo.engineToasts = (S.memo.engineToasts || 0) + 1;
    S.saveMemo();
    toast(`Found ${e.name}’s search. Type “${e.key} ” in the address bar to use it.`, { ms: 7000, action: 'Edit', run: () => openInternal('settings', { section: 'search' }) });
  }
});

// ------------------------------------------------------------ suggestions
let suggItems = [], suggIndex = -1, typed = '', remote = [], remoteFor = '', sugN = 0;
const askRemote = debounce((text) => {
  const eng = curEngine();
  if (!S.settings.suggestions || !eng.remote || resolve(text) !== searchUrl(text)) return;
  send('suggest', { n: ++sugN, q: text, engine: eng.id });
}, 120);
on('suggest', (m) => {
  if (m.n !== sugN || document.activeElement !== q || typed.trim() !== m.q) return;
  remote = m.list || [];
  remoteFor = m.q;
  suggest(true);
});
/** Finish a typed address from history inline ("yo" → "youtube.com"), like other browsers. */
function autocomplete(kind) {
  const text = q.value;
  if (kind.startsWith('delete') || !text || /\s/.test(text) || q.selectionStart !== text.length || text.length < 2) return;
  const low = text.toLowerCase().replace(/^https?:\/\//, '');
  let best = null, n = 0;
  for (const e of [...S.bookmarks, ...S.history.slice(0, 2000)]) {
    const hn = (e.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
    if (!hn.startsWith(low) || hn === low) continue;
    const c = S.visitCount(e.url) + (S.bookmarkOf(e.url) ? 5 : 0);
    if (c > n || !best) (best = hn), (n = c);
  }
  if (!best) return;
  q.value = text + best.slice(low.length);
  q.setSelectionRange(text.length, q.value.length);
}
function suggest(keepRemote) {
  const text = typed.trim();
  if (!text) return hideSugg();
  const low = text.toLowerCase();
  if (!keepRemote) {
    remote = remoteFor && low.startsWith(remoteFor.toLowerCase()) ? remote.filter((s) => s.toLowerCase().startsWith(low)) : [];
    askRemote(text);
  }
  // the inline completion wins when there is one
  const shown = q.value.trim();
  const target = resolve(shown !== text && q.selectionStart !== q.selectionEnd ? shown : text);
  const kw = E.keyword(text);
  const isSearch = !!kw || target === searchUrl(text);
  const items = [isSearch
    ? { kind: 'search', url: target, title: kw ? kw.query : text, typed: kw ? text : null, sub: `Search ${(kw?.engine || curEngine()).name}` }
    : { kind: 'go', url: target, title: target, sub: 'Go to address' }];
  const seen = new Set([target]);
  const match = (e) => (e.url || '').toLowerCase().includes(low) || (e.title || '').toLowerCase().includes(low);
  for (const t of tabs) {
    if (items.filter((x) => x.kind === 'tab').length >= 2) break;
    if (t.id !== activeId && isWeb(t) && match({ url: t.url, title: t.title }) && !seen.has(t.url)) seen.add(t.url), items.push({ kind: 'tab', id: t.id, url: t.url, title: titleOf(t), icon: t.icon });
  }
  for (const b of S.bookmarks) {
    if (items.length >= 6) break;
    if (match(b) && !seen.has(b.url)) seen.add(b.url), items.push({ kind: 'bookmark', url: b.url, title: b.title, icon: b.icon });
  }
  const hist = [];
  for (const e of S.history) {
    if (hist.length > 60) break;
    if (match(e) && !seen.has(e.url)) seen.add(e.url), hist.push(e);
  }
  // prefer addresses that start with what was typed, then the ones visited most
  const starts = (e) => hostOf(e.url).startsWith(low) || e.url.replace(/^https?:\/\/(www\.)?/, '').startsWith(low);
  hist.sort((a, b) => starts(b) - starts(a) || S.visitCount(b.url) - S.visitCount(a.url) || b.t - a.t);
  const histItems = hist.map((e) => ({ kind: 'history', url: e.url, title: e.title || e.url, icon: e.icon }));
  items.push(...histItems.splice(0, Math.max(0, 6 - items.length)));
  for (const s of remote) {
    if (items.filter((x) => x.kind === 'remote').length >= 4) break;
    if (s.toLowerCase() !== low) items.push({ kind: 'remote', url: searchUrl(s), title: s, sub: curEngine().name });
  }
  items.push(...histItems.splice(0, Math.max(0, 10 - items.length)));
  suggItems = items;
  suggIndex = -1;
  paintSugg();
  const sl = startLive();
  sugg.hidden = !!sl;
  holdOverlay('sugg', !sl);
  startLiveRefresh();
  if (sl) askInstant(text);
}
const KIND = { bookmark: 'bookmark', history: 'visited', search: 'search', go: 'address', remote: 'search', tab: 'switch to tab' };
function paintSugg() {
  // on the start page the suggestions fill the page itself (see startLiveRefresh), elsewhere they drop down from the address bar
  const into = startLive()?.live.querySelector('.live-rows') || sugg;
  into.replaceChildren(...suggItems.map((it, i) => h('div', {
    class: 'sg' + (i === suggIndex ? ' hi' : '') + ' k-' + it.kind,
    onmousedown: (e) => (e.preventDefault(), (suggIndex = i), submit(e.button === 1)),
    onmouseenter: () => ((suggIndex = i), into.querySelectorAll('.sg').forEach((el, j) => el.classList.toggle('hi', j === i))),
  },
  h('span', { class: 'sg-ic' }, it.kind === 'search' || it.kind === 'remote' ? h('i', { html: icon('search', 15) }) : it.kind === 'go' ? h('i', { html: icon('go', 15) }) : it.kind === 'tab' ? h('i', { html: icon('tab', 15) }) : favicon(it.icon, 15)),
  h('span', { class: 'sg-n' }, it.title),
  h('span', { class: 'sg-u' }, it.kind === 'search' || it.kind === 'go' || it.kind === 'remote' ? it.sub : it.url.replace(/^https?:\/\/(www\.)?/, '')),
  h('span', { class: 'sg-c' }, KIND[it.kind]))));
}
function moveSugg(d) {
  suggIndex = clamp(suggIndex + d, -1, suggItems.length - 1);
  paintSugg();
  const it = suggItems[suggIndex];
  if (!it) q.value = typed;
  else if (it.kind === 'search' || it.kind === 'remote') q.value = it.typed || it.title;
  else q.value = it.url;
}
function hideSugg() {
  sugg.hidden = true;
  suggItems = [];
  suggIndex = -1;
  holdOverlay('sugg', false);
  startLiveRefresh();
}

// ------------------------------------------------------------ the start page while you type
/**
 * Typing on the start page glides the search box up into the address bar, and the page shows what the search would
 * find (suggestions, an instant answer, a sum) while you go on typing there.
 */
let startRef = null, instN = 0, liveAnswer = null, liveTimer = 0;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const startLive = () => (startRef?.el.isConnected && !field.hidden && active()?.url === 'roamer:start' ? startRef : null);
const askInstant = debounce((text) => {
  if (!S.settings.instant || text.length < 3 || E.keyword(text) || /^(https?:|www\.)|^\S+\.\S{2,}$/i.test(text)) return;
  send('instant', { n: ++instN, q: text });
}, 260);
on('instant', (m) => {
  if (m.n !== instN) return;
  liveAnswer = m.answer ? { q: m.q, ...m.answer } : null;
  startLiveRefresh();
});
/** A sum typed into the search box, worked out here (no eval): + - * / ^ % and brackets. */
function calc(text) {
  const src = text.replace(/[×x]/gi, '*').replace(/÷/g, '/').replace(/,/g, '').trim();
  if (!/^[\d\s.+\-*/^%()]+$/.test(src) || !/\d\s*[+\-*/^%]\s*[\d(.]/.test(src)) return null;
  const tok = src.match(/\d*\.?\d+|[+\-*/^%()]/g) || [];
  let i = 0;
  const atom = () => {
    const c = tok[i++];
    if (c === '-') return -atom();
    if (c === '+') return atom();
    if (c === '(') {
      const v = add();
      if (tok[i++] !== ')') throw 0;
      return v;
    }
    if (c === undefined || !/^[\d.]/.test(c)) throw 0;
    return parseFloat(c);
  };
  const pow = () => {
    const b = atom();
    return tok[i] === '^' ? (i++, b ** pow()) : b;
  };
  const post = () => {
    let v = pow();
    while (tok[i] === '%') i++, (v /= 100);
    return v;
  };
  const mul = () => {
    let v = post();
    while (tok[i] === '*' || tok[i] === '/') v = tok[i++] === '*' ? v * post() : v / post();
    return v;
  };
  const add = () => {
    let v = mul();
    while (tok[i] === '+' || tok[i] === '-') v = tok[i++] === '+' ? v + mul() : v - mul();
    return v;
  };
  try {
    const v = add();
    return i === tok.length && Number.isFinite(v) ? +v.toPrecision(12) : null;
  } catch {
    return null;
  }
}
function startLiveRefresh() {
  const sl = startLive();
  if (!sl) {
    if (startRef?.el.isConnected) startRef.el.classList.remove('searching', 'leaving');
    return;
  }
  const text = typed.trim();
  const on = document.activeElement === q && field.classList.contains('edited') && !!text;
  clearTimeout(liveTimer);
  const { el, live } = sl;
  if (!on) {
    live.hidden = true;
    el.classList.remove('leaving');
    liveTimer = setTimeout(() => el.classList.remove('searching'), 0);
    return;
  }
  if (!el.classList.contains('searching')) {
    el.classList.add('leaving');
    const go_ = () => (el.classList.add('searching'), (live.hidden = false));
    if (reduceMotion.matches) go_();
    else liveTimer = setTimeout(go_, 230);
  } else live.hidden = false;
  // the card above the rows: a sum, or DuckDuckGo's instant answer
  const card = live.querySelector('.live-card');
  const sum = calc(text);
  const a = liveAnswer && liveAnswer.q === text ? liveAnswer : null;
  card.hidden = sum == null && !a;
  if (sum != null) {
    card.className = 'live-card cut sum';
    card.replaceChildren(h('span', { class: 'lc-kick' }, 'Calculator'), h('b', { class: 'lc-big' }, '= ' + sum.toLocaleString(undefined, { maximumFractionDigits: 10 })), h('span', { class: 'lc-sub' }, text));
  } else if (a) {
    card.className = 'live-card cut' + (a.image ? ' has-img' : '');
    card.replaceChildren(
      a.image ? h('img', { class: 'lc-img', src: a.image, alt: '', referrerpolicy: 'no-referrer', draggable: 'false', onerror: (e) => e.target.remove() }) : null,
      h('div', { class: 'lc-body' },
        h('span', { class: 'lc-kick' }, 'Instant answer' + (a.source ? ' · ' + a.source : '')),
        a.heading && !a.answer ? h('b', { class: 'lc-head' }, a.heading) : null,
        a.answer ? h('b', { class: 'lc-big' }, a.answer) : null,
        a.text ? h('p', { class: 'lc-text' }, a.text) : null,
        a.url ? h('a', { class: 'lc-open', href: a.url, onclick: (e) => (e.preventDefault(), open(a.url, { newTab: e.ctrlKey })) }, 'Read more ›') : null,
        a.related?.length ? h('div', { class: 'lc-rel' }, ...a.related.slice(0, 3).map((r) => h('button', { class: 'chip', title: r.text, onmousedown: (e) => e.preventDefault(), onclick: () => r.url && open(r.url, { newTab: false }) }, r.text.slice(0, 48)))) : null));
  }
}

/** A copy of the start page's search box flies up to the address bar, which takes over the typing. */
function glide(from, text) {
  const sl = startRef;
  focusAddress(text);
  if (!sl || !from.isConnected || reduceMotion.matches || !S.settings.glide) return;
  const a = from.getBoundingClientRect(), b = field.getBoundingClientRect();
  const ghost = h('div', { class: 'field cut glide-ghost' }, h('i', { class: 'f-ic', html: icon('search', 18) }), h('span', { class: 'gt' }, text));
  Object.assign(ghost.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
  document.body.append(ghost);
  from.classList.add('gone');
  field.classList.add('landing');
  const gt = ghost.querySelector('.gt');
  const mirror = () => (gt.textContent = q.value);
  q.addEventListener('input', mirror);
  const fin = () => {
    q.removeEventListener('input', mirror);
    ghost.remove();
    field.classList.remove('landing');
    field.classList.add('landed');
    setTimeout(() => field.classList.remove('landed'), 700);
    setTimeout(() => from.classList.remove('gone'), 300);
  };
  const move = ghost.animate([
    { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', fontSize: '16px', transform: 'scale(1)' },
    { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px', fontSize: '12.5px', transform: 'scale(1)' },
  ], { duration: 780, easing: 'cubic-bezier(.3,.85,.2,1)', fill: 'forwards' });
  move.onfinish = move.oncancel = fin;
}

export function focusAddress(text) {
  send('focuschrome');
  if (text != null) {
    q.value = text;
    typed = text;
    field.classList.add('edited');
  }
  q.focus();
  if (text) {
    q.setSelectionRange(text.length, text.length);
    suggest();
  } else q.select();
}

// ------------------------------------------------------------ bookmarks bar
const bmbar = $('#bmbar');
// Ctrl+Shift+B: hidden ↔ shown (on every page)
const toggleBar = () => S.setSetting('bookmarksBar', S.settings.bookmarksBar === 'never' ? 'always' : 'never');
const barChoices = () => [['always', 'Show on every page'], ['start', 'Only on the start page'], ['never', 'Hide']].map(([v, label]) =>
  ({ label, checked: S.settings.bookmarksBar === v, kbd: v === 'never' ? 'Ctrl+Shift+B' : null, run: () => S.setSetting('bookmarksBar', v) }));
bmbar.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.bm')) return;
  e.preventDefault();
  showMenu([{ header: 'Bookmarks bar' }, ...barChoices(), { sep: true }, { label: 'Add bookmark…', icon: 'plus', run: () => api.addBookmark() }, { label: 'Manage bookmarks', icon: 'bookmarks', run: () => openInternal('bookmarks') }], e.clientX, e.clientY);
});
function paintBookmarksBar() {
  bmbar.replaceChildren(
    ...S.bookmarks.map((b) => h('a', {
      class: 'bm', href: b.url, title: `${b.title}\n${b.url}`, draggable: 'false',
      onclick: (e) => (e.preventDefault(), open(b.url, { newTab: e.ctrlKey || e.metaKey })),
      onauxclick: (e) => e.button === 1 && (e.preventDefault(), open(b.url, { background: true })),
      oncontextmenu: (e) => (e.preventDefault(), bookmarkMenu(b, e.clientX, e.clientY, true)),
    }, h('span', {}, favicon(b.icon, 14, b.title), h('b', {}, b.title || hostOf(b.url))))),
    !S.bookmarks.length ? h('span', { class: 'bm-empty' }, 'Bookmarks you add with the star (Ctrl+D) show up here') : null,
  );
}
export function bookmarkMenu(b, x, y, fromBar) {
  showMenu([
    { header: b.title || b.url },
    { label: 'Open', icon: 'go', run: () => open(b.url) },
    { label: 'Open in new tab', icon: 'tab', run: () => open(b.url, { newTab: true }) },
    { label: 'Open in new window', icon: 'window', run: () => send('newwindow', { url: b.url }) },
    { label: 'Open beside this page (desktop)', icon: 'desktop', run: () => showBeside(newTab(b.url, { activate: false })) },
    { sep: true },
    { label: 'Edit…', icon: 'edit', run: () => editBookmark(b) },
    { label: 'Copy address', icon: 'link', run: () => copyText(b.url).then(() => toast('Address copied')) },
    { label: 'Delete', icon: 'trash', danger: true, run: () => deleteBookmark(b) },
    fromBar && { sep: true },
    fromBar && { label: 'Hide bookmarks bar', icon: 'eye', kbd: 'Ctrl+Shift+B', run: () => S.setSetting('bookmarksBar', 'never') },
  ], x, y);
}
export async function editBookmark(b) {
  const name = h('input', { class: 'input', value: b.title });
  const url = h('input', { class: 'input mono', value: b.url });
  const ok = await dialog({
    title: 'Edit bookmark', ok: 'Save',
    body: h('div', { class: 'dlg-fields' }, h('label', { class: 'dlg-field' }, h('span', {}, 'Name'), name), h('label', { class: 'dlg-field' }, h('span', {}, 'Address'), url)),
  });
  if (ok) S.updateBookmark(b.id, { title: name.value.trim() || b.title, url: resolve(url.value) || b.url });
}
export function deleteBookmark(b) {
  const i = S.bookmarks.indexOf(b);
  S.removeBookmark(b.id);
  toast(`Removed "${b.title}"`, { action: 'Undo', run: () => S.restoreBookmark(b, i) });
}
function toggleBookmark(t) {
  if (!t || isInternal(t.url)) return;
  const b = S.bookmarkOf(t.url);
  if (b) return deleteBookmark(b);
  const nb = S.addBookmark({ url: t.url, title: t.title || hostOf(t.url), icon: t.icon });
  toast('Bookmarked', { action: 'Edit', run: () => editBookmark(nb) });
}
function bookmarkAll() {
  const n = S.addBookmarks(tabs.filter(isWeb).map((t) => ({ url: t.url, title: t.title || hostOf(t.url), icon: t.icon })));
  toast(n ? `Bookmarked ${n} tab${n === 1 ? '' : 's'}` : 'Every open tab is bookmarked already');
}
async function addBookmarkDialog() {
  const name = h('input', { class: 'input', placeholder: 'Name' });
  const url = h('input', { class: 'input mono', placeholder: 'example.com' });
  const ok = await dialog({ title: 'Add bookmark', ok: 'Add', body: h('div', { class: 'dlg-fields' }, h('label', { class: 'dlg-field' }, h('span', {}, 'Address'), url), h('label', { class: 'dlg-field' }, h('span', {}, 'Name'), name)) });
  const u = ok && resolve(url.value);
  if (u && !isInternal(u)) S.addBookmark({ url: u, title: name.value.trim() || hostOf(u) });
}
function importBookmarks() {
  const input = h('input', { type: 'file', accept: '.html,.htm,text/html', style: 'display:none' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.remove();
    if (!f) return;
    const list = S.parseBookmarksHtml(await f.text());
    const n = S.addBookmarks(list);
    toast(list.length ? `Imported ${n} bookmark${n === 1 ? '' : 's'}${n < list.length ? ` (${list.length - n} you had already)` : ''}` : 'No bookmarks in that file', { err: !list.length });
  });
  document.body.append(input);
  input.click();
}
function exportBookmarks() {
  if (!S.bookmarks.length) return toast('No bookmarks to export yet');
  const name = `web-roamer-bookmarks-${new Date().toISOString().slice(0, 10)}.html`;
  if (isNative) send('savefile', { name, text: S.bookmarksHtml() });
  else {
    const a = h('a', { href: URL.createObjectURL(new Blob([S.bookmarksHtml()], { type: 'text/html' })), download: name });
    a.click();
  }
}
on('saved', (m) => toast(m.ok ? `Saved ${String(m.path).split(/[\\/]/).pop()} in your downloads folder` : 'Could not save the file', { err: !m.ok }));

// ------------------------------------------------------------ find in page
const findInput = h('input', { class: 'find-q', placeholder: 'Find in page', spellcheck: 'false' });
const findState = h('span', { class: 'find-state' });
const findbar = $('#findbar');
let lastFind = '', findAt = 0, findBack = false;
function findStep(back) {
  const v = findInput.value;
  if (!v) return (findState.textContent = ''), findbar.classList.remove('miss');
  const fresh = v !== lastFind;
  findBack = back;
  send('find', { id: activeId, q: v, back, fresh });
  if (fresh) findAt = 0;
  lastFind = v;
}
function buildFindbar() {
  findbar.append(
    h('span', { class: 'find-ic', html: icon('find', 15) }),
    findInput, findState,
    h('button', { class: 'ibtn sm', title: 'Previous (Shift+Enter)', onclick: () => findStep(true), html: icon('up', 15) }),
    h('button', { class: 'ibtn sm', title: 'Next (Enter)', onclick: () => findStep(false), html: icon('down', 15) }),
    h('button', { class: 'ibtn sm', title: 'Close (Esc)', onclick: () => closeFind(true), html: icon('close', 15) }));
  findInput.addEventListener('input', debounce(() => findStep(false), 180));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault(), findStep(e.shiftKey);
    else if (e.key === 'Escape') e.preventDefault(), closeFind(true);
  });
}
on('found', (m) => {
  if (m.id !== activeId) return;
  findbar.classList.toggle('miss', !m.ok);
  if (!m.ok) return (findState.textContent = 'not found');
  const n = m.n || 0;
  findAt = n ? ((findAt + (findBack ? -1 : 1) - 1 + n) % n) + 1 : 0;
  findState.textContent = n ? `${findAt} / ${n}` : '';
});
function openFind() {
  const t = active();
  if (!t?.live) return;
  findbar.hidden = false;
  send('focuschrome');
  findInput.focus();
  findInput.select();
  layout();
}
function closeFind(focusPage) {
  if (findbar.hidden) return;
  findbar.hidden = true;
  findbar.classList.remove('miss');
  findState.textContent = '';
  lastFind = '';
  layout();
  if (focusPage && active()?.live) send('focus', { id: activeId });
}

// ------------------------------------------------------------ zoom (remembered per site)
const ZOOMS = [0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function setZoom(z, t = active()) {
  if (!t?.live) return;
  t.zoom = z;
  send('zoom', { id: t.id, z });
  S.setSiteZoom(hostOf(t.url), z);
  for (const x of tabs) if (x !== t && x.live && hostOf(x.url) === hostOf(t.url)) (x.zoom = z), send('zoom', { id: x.id, z });
  paintBar();
}
function zoomStep(d) {
  const t = active();
  if (!t) return;
  const i = ZOOMS.findIndex((z) => z >= t.zoom - 0.001);
  setZoom(ZOOMS[clamp((i < 0 ? ZOOMS.length - 1 : i) + d, 0, ZOOMS.length - 1)]);
}
/** A page that arrived on a site gets that site's zoom. */
function siteZoom(t) {
  const z = S.zoomFor(hostOf(t.url));
  if (Math.abs(z - t.zoom) < 0.001) return;
  t.zoom = z;
  send('zoom', { id: t.id, z });
  if (t.id === activeId) paintBar();
}

// ------------------------------------------------------------ a site's look (the Site Theming SDK)
let lookNow = '', booted = false;
/** What this site's look would be, if the user lets it have one: the SDK theme, or just its theme-color. */
function allowedLook(origin, look) {
  const pref = S.settings.siteThemes, choice = S.themeSites[origin];
  if (look.sdk && pref !== 'off' && choice !== 'block' && (pref === 'on' || choice === 'allow')) return look.sdk;
  if (look.color && S.settings.themeColor) return { background: look.color };
  return null;
}
const originOf = (url) => {
  try {
    const u = new URL(url);
    // a local file has no origin of its own; its choices belong to that one file
    return u.protocol === 'file:' ? u.origin === 'null' ? u.protocol + '//' + u.pathname : u.origin : u.origin;
  } catch {
    return '';
  }
};
/** The look the tab's site asked for, if the user lets it have one. */
function lookFor(t) {
  if (!t || !isWeb(t) || !t.look) return null;
  const origin = originOf(t.url);
  return origin && t.look.origin === origin ? allowedLook(origin, t.look) : null;
}
/** lookFor, or the look this site had last time (so restored and loading tabs already wear it). */
function tabTheme(t) {
  if (!t || !isWeb(t)) return null;
  const own = lookFor(t);
  if (own || t.look) return own;
  const origin = originOf(t.url);
  const c = origin && S.memo.looks?.[origin];
  return c ? allowedLook(origin, c) : null;
}
const repaintTopo = debounce(() => paintTopo(), 120);
/**
 * Dress the browser in the focused tab's look. `from` says it should spread out: true from the active tab, or an
 * element to spread from (the look chip, say).
 */
function siteLook(force, from) {
  const theme = pageFs != null ? null : tabTheme(active());
  const key = JSON.stringify(theme);
  root.classList.toggle('framed', theme?.frame ?? !!S.settings.frame);
  if (key === lookNow && !force) return;
  lookNow = key;
  const run = () => {
    Look.apply(root, theme);
    repaintTopo();
    requestAnimationFrame(layout);
  };
  if (from && booted && S.settings.unfurl && !reduceMotion.matches) unfurl(run, from instanceof Element ? from : null);
  else run();
}
/** The new look starts at the tab and spreads out over the rest of the browser. */
function unfurl(run, el) {
  const r = (el || tabsEl.querySelector('.tab-i.on'))?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top + r.height / 2 : 16;
  const rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  if (document.startViewTransition) {
    try {
      root.classList.add('unfurling');
      const vt = document.startViewTransition(run);
      vt.ready.then(() => root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${rad}px at ${x}px ${y}px)`] },
        { duration: 900, easing: 'cubic-bezier(.22,.8,.25,1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
      vt.finished.finally(() => root.classList.remove('unfurling'));
      return;
    } catch {
      root.classList.remove('unfurling');
    }
  }
  run();
  const ring = h('i', { class: 'unfurl-ring', style: { left: x + 'px', top: y + 'px', '--r': rad * 2 + 'px' } });
  document.body.append(ring);
  ring.addEventListener('animationend', () => ring.remove());
}
function paintLookChip() {
  const t = active();
  const sdk = t && isWeb(t) && t.look?.sdk;
  let origin = '';
  try {
    origin = originOf(t?.url);
  } catch { /* not a web page */ }
  const choice = S.themeSites[origin];
  const on = !!lookFor(t) && !!sdk;
  lookChip.hidden = !sdk || S.settings.siteThemes === 'off';
  lookChip.classList.toggle('lit', on);
  lookChip.classList.toggle('ask', !!sdk && !choice && S.settings.siteThemes === 'ask');
  lookChip.title = on ? 'This site is styling Web Roamer · click to change' : 'This site has a look for Web Roamer · click to try it';
}
function lookOffer() {
  const t = active();
  if (!t?.look?.sdk) return;
  const origin = originOf(t.url);
  const choice = S.themeSites[origin];
  const sw = Look.swatches(t.look.sdk);
  popover(h('div', { class: 'look-offer' },
    h('div', { class: 'pv-kick' }, 'SITE LOOK'),
    h('div', { class: 'lo-sw' }, ...sw.map((c) => h('i', { style: { background: c } }))),
    h('p', {}, h('b', {}, hostOf(t.url)), ' would like to dress Web Roamer while you’re on it: ', Look.describe(t.look.sdk) || 'its own colours', '.'),
    h('p', { class: 'lo-fine' }, 'Only colours and a few styles. Sites can’t change the address bar, the security icon or anything outside their own tab.'),
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', onclick: () => (S.setThemeSite(origin, 'block'), closePopover(), siteLook(true, true), paintBar()) }, choice === 'block' ? 'Keep it off' : 'No thanks'),
      h('button', { class: 'btn primary', onclick: () => (S.setThemeSite(origin, 'allow'), closePopover(), siteLook(true, lookChip), paintBar()) }, choice === 'allow' ? 'Keep it on' : 'Use this look')),
    h('button', { class: 'lo-more', onclick: () => (closePopover(), open(DOCS_THEMING, { newTab: true })) }, 'For web developers: the Site Theming SDK →')),
  { anchor: lookChip, align: 'right', cls: 'pv-look' });
}
const rememberLook = (origin, look) => {
  const all = (S.memo.looks ||= {});
  if (look) all[origin] = look;
  else delete all[origin];
  const keys = Object.keys(all);
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete all[k];
  S.saveMemo();
};
on('sitetheme', (m) => {
  const t = byId(m.id);
  if (!t || !t.live) return;
  let origin = '';
  try {
    origin = originOf(m.url || t.url);
  } catch {
    return;
  }
  if (!origin) return;
  const sdk = Look.sanitize(m.theme?.sdk);
  const color = Look.rgbOf(m.theme?.color) ? String(m.theme.color) : '';
  t.look = sdk || color ? { sdk, color, origin } : null;
  rememberLook(origin, t.look);
  if (t.id === activeId) siteLook(false, true), paintBar();
  paintTabs();
});

// ------------------------------------------------------------ view source
function viewSource(t = active()) {
  if (!t?.live || isInternal(t.url)) return;
  send('source', { id: t.id });
}
on('source', (m) => {
  const from = byId(m.id);
  newTab('roamer:source', { after: m.id, data: { url: m.url, text: m.text }, group: from && deskOf(from) ? from.group : null });
});

// ------------------------------------------------------------ clearing browsing data
async function clearData() {
  const spans = [['Last hour', 3600e3], ['Today', 86400e3], ['Last 7 days', 7 * 86400e3], ['Last 4 weeks', 28 * 86400e3], ['All time', Infinity]];
  let pick = spans[4];
  const seg = h('div', { class: 'seg wrap' });
  const paintSeg = () => seg.replaceChildren(...spans.map((s) => h('button', { class: 'seg-b' + (s === pick ? ' on' : ''), onclick: () => ((pick = s), paintSeg()) }, s[0])));
  paintSeg();
  const box = (label, hint, on = true) => {
    const b = h('input', { type: 'checkbox', checked: on });
    return [b, h('label', { class: 'chk' }, b, h('span', {}, h('b', {}, label), h('small', {}, hint)))];
  };
  const [hist, histRow] = box('Browsing history', `${S.history.length} visits, for the period above`);
  const [dls, dlsRow] = box('Download list', 'The list only; downloaded files stay where they are');
  const [site, siteRow] = box('Cookies, cache and site data', 'Signs you out of websites. Always everything, whatever the period', false);
  const [prefs, prefsRow] = box('Per-site zoom and site looks', 'Zoom levels and Allow/Block choices for site looks', false);
  const ok = await dialog({ title: 'Clear browsing data', ok: 'Clear', danger: true, wide: true, body: h('div', { class: 'dlg-fields' }, h('div', { class: 'dlg-field' }, h('span', {}, 'Time range'), seg), histRow, dlsRow, siteRow, prefsRow) });
  if (!ok) return;
  const since = Date.now() - pick[1];
  const done = [];
  if (hist.checked) S.removeVisits((e) => e.t >= since), done.push('history');
  if (dls.checked) S.clearDownloads(), done.push('downloads');
  if (site.checked) send('clear'), done.push('site data');
  if (prefs.checked) S.clearSiteZoom(), Object.keys(S.themeSites).forEach((o) => S.setThemeSite(o, null)), done.push('site settings');
  toast(done.length ? `Cleared ${done.join(', ')}` : 'Nothing was selected');
}

// ------------------------------------------------------------ updates
function newer(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
export async function checkUpdates(manual) {
  const mine = api.info?.version;
  if (!mine || mine === 'dev') return manual && toast('Updates are checked in the installed app');
  try {
    const r = await fetch('https://api.github.com/repos/Tox-EyE-CeaZY/Web-Roamer/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    S.memo.update = { t: Date.now(), tag: j.tag_name, url: j.html_url, notes: (j.body || '').slice(0, 2000) };
    S.saveMemo();
    paintUpdate();
    if (manual) toast(newer(j.tag_name, mine) ? `Web Roamer ${j.tag_name.replace(/^v/, '')} is out` : `You’re on the latest version (${mine})`, newer(j.tag_name, mine) ? { action: canSelfUpdate() ? 'Update' : 'Get it', run: getUpdate } : {});
    return S.memo.update;
  } catch {
    if (manual) toast('Could not reach GitHub to check for updates', { err: true });
  }
}
/** Updating in place: {state: 'idle' | 'downloading' | 'ready' | 'error', pct, tag, error}. */
const upd = { state: 'idle' };
const canSelfUpdate = () => isNative && api.info?.selfUpdate;
/** Get the new version: downloaded and swapped in where the system allows it, else from the release page. */
export function getUpdate() {
  if (upd.state === 'ready') return restartToUpdate();
  if (!canSelfUpdate()) return S.memo.update && open(S.memo.update.url, { newTab: true });
  if (upd.state === 'downloading') return toast(`Downloading the update… ${upd.pct || 0}%`);
  Object.assign(upd, { state: 'downloading', pct: 0, error: '' });
  send('update');
  paintUpdate();
}
function restartToUpdate() {
  saveSession.flush();
  send('applyupdate');
}
on('update', (m) => {
  const was = upd.state;
  Object.assign(upd, m);
  if (m.state === 'ready' && was !== 'ready') toast(`Web Roamer ${String(m.tag).replace(/^v/, '')} is ready`, { action: 'Restart now', run: restartToUpdate, ms: 12000 });
  if (m.state === 'error') toast(m.error || 'The update failed', { err: true, action: 'Release page', run: () => S.memo.update && open(S.memo.update.url, { newTab: true }) });
  paintUpdate();
  const t = active();
  if (t?.url === 'roamer:settings') renderPage(inner, 'settings', api, 'update', t);
});
const updateReady = () => S.memo.update && api.info?.version && api.info.version !== 'dev' && newer(S.memo.update.tag, api.info.version);
function paintUpdate() {
  const ready = upd.state === 'ready';
  updDot.hidden = !updateReady() && !ready;
  updDot.classList.toggle('go', ready);
  menuBtn.title = ready ? 'Menu · restart to finish updating' : updateReady() ? `Menu · Web Roamer ${S.memo.update.tag.replace(/^v/, '')} is available` : 'Menu (Alt+F)';
  // found a new version: fetch it quietly so it only needs a restart
  if (updateReady() && upd.state === 'idle' && canSelfUpdate() && S.settings.autoUpdate) getUpdate();
}

// ------------------------------------------------------------ main menu
function mainMenu(anchor = menuBtn) {
  const t = active();
  const web = t?.live && !isInternal(t.url);
  const zv = h('b', {}, Math.round((t?.zoom || 1) * 100) + '%');
  const zoomRow = h('div', { class: 'cm-zoom' },
    h('span', { class: 'cm-t' }, 'Zoom'),
    h('button', { class: 'ibtn sm', title: 'Zoom out (Ctrl+−)', disabled: !web, onclick: () => (zoomStep(-1), (zv.textContent = Math.round(active().zoom * 100) + '%')), html: icon('minus', 14) }),
    zv,
    h('button', { class: 'ibtn sm', title: 'Zoom in (Ctrl++)', disabled: !web, onclick: () => (zoomStep(1), (zv.textContent = Math.round(active().zoom * 100) + '%')), html: icon('plus', 14) }),
    h('button', { class: 'ibtn sm', title: 'Full screen (F11)', onclick: () => (closeMenu(), send('win', { c: 'fs' })), html: icon('fullscreen', 14) }));
  const recent = S.recentVisits(8);
  const g = groupById(t?.group);
  showMenu([
    upd.state === 'ready'
      ? { label: `Restart to update to ${String(upd.tag).replace(/^v/, '')}`, icon: 'gift', run: restartToUpdate, title: 'Your tabs come back after the restart' }
      : updateReady() && { label: upd.state === 'downloading' ? `Downloading ${S.memo.update.tag.replace(/^v/, '')}… ${upd.pct || 0}%` : `Update to ${S.memo.update.tag.replace(/^v/, '')}`, icon: 'gift', run: getUpdate, title: canSelfUpdate() ? 'Download and install it' : 'Get the new version from GitHub' },
    (updateReady() || upd.state === 'ready') && { sep: true },
    { label: 'New tab', icon: 'plus', kbd: 'Ctrl+T', run: () => newTab() },
    { label: 'New window', icon: 'window', kbd: 'Ctrl+N', run: () => send('newwindow') },
    { label: deskOf() ? 'Leave desktop' : 'Desktop', icon: 'desktop', run: toggleDesktop, title: 'Pages of one group side by side' },
    { sep: true },
    {
      label: 'History', icon: 'history', sub: () => [
        { label: 'Show all history', icon: 'history', kbd: 'Ctrl+H', run: () => openInternal('history') },
        { label: 'Clear browsing data…', icon: 'trash', kbd: 'Ctrl+Shift+Del', run: clearData },
        closedTabs.length && { header: 'Recently closed' },
        ...closedTabs.slice(-6).reverse().map((c) => ({ label: c.title || c.url, img: favicon(c.icon, 14), run: () => (closedTabs.splice(closedTabs.indexOf(c), 1), newTab(c.url, { title: c.title, icon: c.icon })) })),
        closedTabs.length && { label: 'Reopen closed tab', icon: 'restore', kbd: 'Ctrl+Shift+T', run: reopenClosed },
        recent.length && { header: 'Recently roamed' },
        ...recent.map((e) => ({ label: e.title || e.url, img: favicon(e.icon, 14), run: () => open(e.url, { newTab: true }) })),
      ],
    },
    {
      label: 'Bookmarks', icon: 'bookmarks', sub: () => [
        { label: web && S.bookmarkOf(t.url) ? 'Edit this bookmark…' : 'Bookmark this tab', icon: 'star', kbd: 'Ctrl+D', disabled: !web, run: () => (S.bookmarkOf(t.url) ? editBookmark(S.bookmarkOf(t.url)) : toggleBookmark(t)) },
        { label: 'Bookmark all tabs', icon: 'tabs', run: bookmarkAll },
        { label: 'Bookmark manager', icon: 'bookmarks', kbd: 'Ctrl+Shift+O', run: () => openInternal('bookmarks') },
        { label: 'Bookmarks bar', icon: 'eye', sub: barChoices },
        { label: 'Import bookmarks…', icon: 'upload', run: importBookmarks },
        { label: 'Export bookmarks', icon: 'download', run: exportBookmarks },
        S.bookmarks.length && { sep: true },
        ...S.bookmarks.slice(0, 24).map((b) => ({ label: b.title || b.url, img: favicon(b.icon, 14, b.title), run: () => open(b.url) })),
      ],
    },
    {
      label: 'Tab groups', icon: 'group', sub: () => [
        { label: 'Organize tabs', icon: 'sparkle', run: organize, title: 'Group the tabs that share a search, a site or a kind of site' },
        { label: g ? `Edit “${g.name || 'group'}”…` : 'New group with this tab', icon: g ? 'edit' : 'plus', disabled: t?.pinned, run: () => (g ? editGroup(g) : createGroup([t.id], nameFor([t]), { edit: true })) },
        { label: 'Search tabs…', icon: 'find', kbd: 'Ctrl+Shift+A', run: () => tabSearch() },
        groups.length && { header: 'Open groups' },
        ...groups.map((x) => ({ label: `${x.name || 'Unnamed'} · ${tabs.filter((y) => y.group === x.id).length}`, img: h('i', { class: 'grp-dot', style: { '--gh': G.COLORS[x.color] } }), run: () => activate_(tabs.find((y) => y.group === x.id).id) })),
        { header: 'Smart groups' },
        ...[['off', 'Off'], ['suggest', 'Suggest groups'], ['auto', 'Group automatically']].map(([v, l]) => ({ label: l, checked: S.settings.smartGroups === v, run: () => (S.setSetting('smartGroups', v), think()) })),
      ],
    },
    { label: 'Downloads', icon: 'download', kbd: 'Ctrl+J', run: () => openInternal('downloads') },
    { sep: true },
    { node: zoomRow },
    { sep: true },
    { label: 'Print…', icon: 'print', kbd: 'Ctrl+P', disabled: !web, run: () => send('print', { id: activeId }) },
    { label: 'Find in page…', icon: 'find', kbd: 'Ctrl+F', disabled: !web, run: openFind },
    { label: 'Translate page', icon: 'translate', disabled: !web || !/^https?:/.test(t?.url), run: () => open(`https://translate.google.com/translate?sl=auto&tl=${(navigator.language || 'en').split('-')[0]}&u=${encodeURIComponent(t.url)}`, { newTab: true }) },
    {
      label: 'More tools', icon: 'code', sub: () => [
        { label: 'View page source', icon: 'code', kbd: 'Ctrl+U', disabled: !web, run: () => viewSource() },
        { label: 'Developer tools', icon: 'code', kbd: 'F12', disabled: !web, run: () => send('devtools', { id: activeId }) },
        { label: 'Copy page address', icon: 'link', disabled: !web, run: () => copyText(t.url).then(() => toast('Address copied')) },
        { label: t?.muted ? 'Unmute tab' : 'Mute tab', icon: t?.muted ? 'speaker' : 'muted', disabled: !web, run: () => setMuted(t, !t.muted) },
        { label: t?.pinned ? 'Unpin tab' : 'Pin tab', icon: 'pin', run: () => setPinned(t, !t.pinned) },
        { label: 'Reload every tab', icon: 'reload', run: () => tabs.forEach((x) => x.live && send('reload', { id: x.id })) },
        { label: 'Clear browsing data…', icon: 'trash', kbd: 'Ctrl+Shift+Del', run: clearData },
      ],
    },
    { sep: true },
    { label: 'Settings', icon: 'settings', kbd: 'Ctrl+,', run: () => openInternal('settings') },
    {
      label: 'Help', icon: 'help', sub: () => [
        { label: 'Keyboard shortcuts', icon: 'keyboard', run: () => openInternal('settings', { section: 'keys' }) },
        { label: 'What’s new', icon: 'gift', run: () => open(REPO + '/releases', { newTab: true }) },
        { label: 'Check for updates', icon: 'restore', run: () => checkUpdates(true) },
        { label: 'Report a problem', icon: 'info', run: () => open(REPO + '/issues/new', { newTab: true }) },
        { label: 'Site Theming SDK (for web developers)', icon: 'brush', run: () => open(DOCS_THEMING, { newTab: true }) },
        { sep: true },
        { label: 'About Web Roamer', icon: 'compass', run: () => openInternal('settings', { section: 'about' }) },
      ],
    },
    { sep: true },
    { label: 'Exit', icon: 'power', kbd: 'Ctrl+Shift+Q', run: () => closeWindow() },
  ], 0, 0, { anchor });
}

/** Internal pages open in a tab of their own (reusing it if one is open). `opts` reach the page (a section, a filter). */
export function openInternal(name, opts = null) {
  const url = 'roamer:' + name;
  pageOpts = opts;
  const there = tabs.find((t) => t.url === url);
  if (there) {
    if (there.id === activeId) {
      inner._page = null;
      return present();
    }
    return activate_(there.id);
  }
  const t = active();
  if (t && t.url === 'roamer:start' && !deskOf(t)) go(t, url);
  else newTab(url);
}
let pageOpts = null;

// ------------------------------------------------------------ keys
const KEYMAP = {
  'c+t': () => newTab(undefined, { group: deskOf() ? active().group : null }),
  'c+n': () => send('newwindow'),
  'cs+n': () => send('newwindow'),
  'c+w': () => closeTab(),
  'cs+w': () => closeWindow(),
  'cs+q': () => closeWindow(),
  'cs+t': reopenClosed,
  'c+tab': () => cycle(1),
  'cs+tab': () => cycle(-1),
  'c+pagedown': () => cycle(1),
  'c+pageup': () => cycle(-1),
  'c+9': () => activate_(tabs[tabs.length - 1].id, { focusPage: true }),
  'c+l': () => focusAddress(),
  'a+d': () => focusAddress(),
  '+f6': () => focusAddress(),
  'c+k': () => focusAddress('? '),
  'c+e': () => focusAddress('? '),
  'c+r': () => send('reload', { id: activeId }),
  '+f5': () => send('reload', { id: activeId }),
  'cs+r': () => send('hardreload', { id: activeId }),
  'c+f5': () => send('hardreload', { id: activeId }),
  'a+arrowleft': () => send('back', { id: activeId }),
  'a+arrowright': () => send('fwd', { id: activeId }),
  'a+home': () => open(homeUrl()),
  'c+d': () => toggleBookmark(active()),
  'c+h': () => openInternal('history'),
  'c+j': () => openInternal('downloads'),
  'cs+o': () => openInternal('bookmarks'),
  'cs+b': toggleBar,
  'cs+a': () => tabSearch(),
  'c+f': openFind,
  '+f3': () => (findbar.hidden ? openFind() : findStep(false)),
  's+f3': () => !findbar.hidden && findStep(true),
  'c+g': () => (findbar.hidden ? openFind() : findStep(false)),
  'cs+g': () => !findbar.hidden && findStep(true),
  'c+p': () => active()?.live && send('print', { id: activeId }),
  'c+u': () => viewSource(),
  'c+=': () => zoomStep(1),
  'c++': () => zoomStep(1),
  'cs++': () => zoomStep(1),
  'c+-': () => zoomStep(-1),
  'c+0': () => setZoom(S.settings.defaultZoom || 1),
  '+f11': () => send('win', { c: 'fs' }),
  '+f12': () => send('devtools', { id: activeId }),
  'c+,': () => openInternal('settings'),
  'cs+delete': clearData,
  'a+f': () => mainMenu(),
  'a+e': () => mainMenu(),
};
for (let n = 1; n <= 8; n++) KEYMAP['c+' + n] = () => visibleTabs()[n - 1] && activate_(visibleTabs()[n - 1].id, { focusPage: true });
KEYMAP['c+9'] = () => activate_(visibleTabs()[visibleTabs().length - 1].id, { focusPage: true });

function runKey(k) {
  const fn = KEYMAP[k];
  if (!fn) return false;
  closeMenu();
  closePopover();
  fn();
  return true;
}
document.addEventListener('keydown', (e) => {
  const k = combo(e);
  // typing in a field keeps its own editing keys
  if (e.target.matches?.('input, textarea') && ['c+a', 'c+c', 'c+v', 'c+x', 'c+z', 'cs+z', 'c+y', 'a+arrowleft', 'a+arrowright', 'c+k', 'c+e', 'cs+arrowleft', 'cs+arrowright'].includes(k)) return;
  if (k === '+escape' && pageFs != null) return leavePageFs();
  if (k === '+escape' && root.classList.contains('fullscreen')) return send('win', { c: 'fs' });
  if (k === '+escape' && active()?.loading && document.activeElement !== q) return send('stop', { id: activeId });
  if (runKey(k)) e.preventDefault();
});
// the mouse's back/forward buttons over the chrome
addEventListener('mouseup', (e) => {
  if (e.button === 3) send('back', { id: activeId });
  else if (e.button === 4) send('fwd', { id: activeId });
});

// ------------------------------------------------------------ messages from the native side
function paintDownloads() {
  const n = S.downloads.filter((d) => d.state === 'active').length;
  dlBadge.hidden = !n;
  dlBadge.textContent = n;
}
on('init', (m) => {
  api.info = m;
  if (S.settings.downloadsDir) send('dldir', { path: S.settings.downloadsDir });
  if (m.staged && m.version && newer(m.staged, m.version)) Object.assign(upd, { state: 'ready', tag: m.staged });
  paintUpdate();
  // look for a new release about twice a day
  if (S.settings.updates && Date.now() - (S.memo.update?.t || 0) > 12 * 3600e3) setTimeout(() => checkUpdates(false), 6000);
});
on('wstate', (m) => {
  root.classList.toggle('maxed', !!m.max);
  root.classList.toggle('fullscreen', !!m.fs);
  maxBtn.innerHTML = icon(m.max ? 'winRestore' : 'winMax', 14);
  maxBtn.title = m.max ? 'Restore' : 'Maximize';
  if (!m.fs && pageFs != null) (fsByPage = false), leavePageFs();
  requestAnimationFrame(layout);
});
/** A page of a supported image board was reached by a link, a redirect or a bookmark: Board Roamer takes over and the tab stays where it was. */
function autoHand(t, before) {
  if (S.settings.boards !== 'auto' || stay.has(t.url) || handing.has(t.url) || !B.wants(t.url) || t.id !== activeId) return;
  handOff(t.url);
  if (/^https?:/i.test(before) && !B.wants(before)) send('back', { id: t.id });
  else closeTab(t.id, { quiet: true });
}
on('tab', (m) => {
  const t = byId(m.id);
  if (!t || !t.live) return;
  if (m.url != null && m.url !== t.url && /^(https?|file|about|data):/i.test(m.url)) {
    if (hostOf(m.url) !== hostOf(t.url)) (t.icon = ''), (t.look = null);
    if (m.loading) t.title = ''; // a new document: its title comes in a moment
    const before = t.url;
    t.url = m.url;
    if (hostOf(before) !== hostOf(t.url)) siteZoom(t);
    onSearch(t);
    autoHand(t, before);
  }
  if (m.title != null) {
    t.title = m.title;
    S.touchVisit(t.url, { title: m.title });
  }
  if (m.icon != null) {
    t.icon = m.icon;
    S.touchVisit(t.url, { icon: m.icon });
    const b = S.bookmarkOf(t.url);
    if (b && b.icon !== m.icon) S.updateBookmark(b.id, { icon: m.icon });
  }
  if (m.audible != null) t.audible = m.audible;
  if (m.loading != null) {
    t.loading = m.loading;
    if (!m.loading) {
      S.recordVisit(t.url, t.title, t.icon);
      siteZoom(t);
      // a new document forgets it was muted
      if (t.muted) send('mute', { id: t.id, on: true });
    }
  }
  if (t.id === activeId) paintBar();
  if (deskTabs().includes(t)) paintDesk(deskOf());
  paintTabs();
  saveSession();
  if (m.url != null || m.loading === false) think();
});
/** A search results page: the tab is now about that search, and maybe belongs with a group about it. */
function onSearch(t) {
  const query = G.searchQuery(t.url);
  if (!query || query === t.topic) return;
  t.topic = query;
  const g = !t.group && !t.pinned && S.settings.smartGroups !== 'off' && G.groupForSearch(query, groups);
  if (g && S.settings.smartGroups === 'auto') {
    addToGroup([t.id], g.id);
    toast(`Added to “${g.name}”: it’s about the same thing`, { action: 'Undo', run: () => takeOff(t) });
  }
  const g2 = groupById(t.group);
  if (g2 && !g2.topics.includes(query)) g2.topics = [...g2.topics, query].slice(-8);
}
on('key', (m) => runKey(m.k));
on('pagefocus', (m) => deskTabs().some((t) => t.id === m.id) && focusPane(m.id));
on('pagefs', (m) => (m.on ? enterPageFs(m.id) : pageFs === m.id && leavePageFs()));
on('newtab', (m) => {
  const from = byId(m.opener);
  // pages opened from a page carry its subject and stay in its group
  const t = newTab(m.url, { after: m.opener, activate: !m.bg, group: from?.group || null, opener: m.opener });
  t.topic = from?.topic || '';
  if (m.bg) think();
});
on('dl', (m) => {
  const d = S.upsertDownload(m);
  if (m.state === 'active') {
    dlBtn.classList.remove('ping');
    void dlBtn.offsetWidth;
    dlBtn.classList.add('ping');
    toast(`Downloading ${d.name}`, { action: 'Show', run: () => openInternal('downloads') });
  } else if (m.state === 'done') toast(`Downloaded ${d.name}`, { action: 'Open', run: () => send('openfile', { path: d.path }) });
  else toast(`Download failed: ${d.name}`, { err: true });
  paintDownloads();
});

S.onChange((what) => {
  if (what === 'settings') {
    applyLook();
    paintTopo();
    requestAnimationFrame(layout);
    think();
  }
  if (what === 'themesites') siteLook(true, true), paintTabs();
  if (what === 'bookmarks' || what === 'settings' || what === 'themesites' || what === 'zoom') paintBookmarksBar(), paintBar();
  if (what === 'downloads') paintDownloads();
  // the open internal pages follow their data
  const t = active();
  if (t && isInternal(t.url) && !deskOf()) renderPage(inner, internalName(t.url), api, what, t);
  for (const [id, p] of panes) if (p.inner && byId(id)) renderPage(p.inner, internalName(byId(id).url), api, what, byId(id));
});

/** What the internal pages may do. */
export const api = {
  open, newTab, openInternal, focusAddress, resolve, searchUrl, editBookmark, deleteBookmark, bookmarkMenu, send, info: null,
  tabs: () => tabs, groups: () => groups, groupColor: (g) => G.COLORS[g.color], activate: (id) => activate_(id, { focusPage: true }),
  clearData, checkUpdates, importBookmarks, exportBookmarks, addBookmark: addBookmarkDialog, organize, toggleDesktop,
  get opts() {
    const o = pageOpts;
    pageOpts = null;
    return o;
  },
  reopen: reopenAll, registerStart: (r) => (startRef = r), glide, engine: curEngine, engineMenu,
  cycleEngine: (d) => {
    const list = E.all();
    const cur = Math.max(0, list.findIndex((e) => e.id === curEngine().id));
    pickEngine(list[(cur + d + list.length) % list.length].id);
  },
  updateReady, update: () => S.memo.update, upd: () => upd, getUpdate, canSelfUpdate, docsTheming: DOCS_THEMING, repo: REPO,
  forgetSuggestions: () => (dismissed.clear(), (S.memo.dismissed = []), S.saveMemo(), think()),
};

// ------------------------------------------------------------ boot
buildTitlebar();
buildToolbar();
buildFindbar();
paintBookmarksBar();
paintDownloads();
applyLook();
initTopo();

const restore = !window.__secondary && S.settings.restoreTabs && S.session?.tabs?.length ? S.session : null;
if (restore) {
  for (const g of restore.groups || []) groups.push({ split: 0.5, topics: [], ...g }), (nextGroup = Math.max(nextGroup, g.id + 1));
  restore.tabs.forEach((s, i) => {
    const t = newTab(s.url || 'roamer:start', { activate: false, pending: i !== restore.active, title: s.title, icon: s.icon, after: null, group: groupById(s.group) ? s.group : null });
    Object.assign(t, { pinned: !!s.pinned, muted: !!s.muted, topic: s.topic || '' });
  });
  normalize();
  activeId = tabs[clamp(restore.active, 0, tabs.length - 1)]?.id ?? null;
}
for (const url of window.__start || []) newTab(url, { activate: false, after: null }), (activeId = tabs[tabs.length - 1].id);
if (!tabs.length) newTab(homeUrl(), { activate: false });
activeId ??= tabs[0].id;
send('ready');
requestAnimationFrame(() => {
  present(!isInternal(active().url));
  booted = true;
  for (const t of tabs) if (t.muted && t.live) send('mute', { id: t.id, on: true });
  if (active().url === 'roamer:start') $('#inner .start-q')?.focus();
});
if (!isNative) root.classList.add('web');
