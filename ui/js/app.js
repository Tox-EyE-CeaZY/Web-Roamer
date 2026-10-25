import { $, h, clamp, combo, debounce, host as hostOf } from './util.js';
import { icon, MARK } from './icons.js';
import { isNative, on, send } from './native.js';
import { initTopo, paintTopo } from './bg.js';
import { toast, dialog, showMenu, closeMenu, holdOverlay, favicon } from './ui.js';
import * as S from './store.js';
import { renderPage, INTERNAL } from './pages.js';

/**
 * The chrome: title bar with tabs, the toolbar and address bar, the bookmarks bar, the find bar and the internal pages
 * (roamer:start, roamer:history ...). Web pages are native views the Rust side lays over #page; this file tells it
 * which tab to show and where.
 */
const root = document.documentElement;
const plat = window.__plat || 'web';
root.dataset.plat = plat;

// ------------------------------------------------------------ look
function applyLook() {
  root.dataset.theme = S.settings.theme;
  root.style.setProperty('--hue', S.settings.hue);
  root.classList.toggle('no-topo', !S.settings.topo);
  root.classList.toggle('no-grain', !S.settings.grain);
  root.classList.toggle('framed', !!S.settings.frame);
  root.classList.toggle('bm-on', !!S.settings.bookmarksBar);
}
applyLook();

// ------------------------------------------------------------ tabs model
/** {id, url, title, icon, loading, zoom, live (has a native page), pending (restored, not loaded yet)} */
const tabs = [];
let activeId = null;
let nextId = 1;
const closedTabs = [];
const active = () => tabs.find((t) => t.id === activeId);
const byId = (id) => tabs.find((t) => t.id === id);
export const isInternal = (url) => /^roamer:/i.test(url || '');
const internalName = (url) => (url || '').slice(7).toLowerCase();

/** What the user typed → an address. */
export function resolve(text) {
  const t = text.trim();
  if (!t) return null;
  if (isInternal(t)) return INTERNAL[internalName(t)] ? t.toLowerCase() : 'roamer:start';
  if (/^(https?|file|about|data):/i.test(t)) return t;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /^[^\s/?#]+\.[a-z][a-z0-9-]{1,62}\.?(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t;
  return searchUrl(t);
}
export const searchUrl = (q) => (S.ENGINES[S.settings.engine] || S.ENGINES.duckduckgo).url.replace('%s', encodeURIComponent(q));
const homeUrl = () => (S.settings.home && resolve(S.settings.home)) || 'roamer:start';
const newTabUrl = () => (S.settings.newTab === 'home' ? homeUrl() : 'roamer:start');

function titleOf(t) {
  if (isInternal(t.url)) return INTERNAL[internalName(t.url)]?.title || 'Start';
  return t.title || hostOf(t.url) || 'New tab';
}

export function newTab(url = newTabUrl(), { activate = true, after = activeId, pending = false, title = '', icon: ic = '' } = {}) {
  const t = { id: nextId++, url: '', title, icon: ic, loading: false, zoom: 1, live: false, pending: false };
  const i = tabs.findIndex((x) => x.id === after);
  // tabs opened from a page sit right after it (and after its other children), like most browsers
  tabs.splice(i < 0 ? tabs.length : i + 1 + tabs.slice(i + 1).filter((x) => x.opener === after).length, 0, t);
  if (after != null && !activate) t.opener = after;
  if (pending && !isInternal(url)) Object.assign(t, { url, pending: true });
  else go(t, url, { quiet: true });
  if (activate) activate_(t.id, { focusPage: !isInternal(url) });
  else paintTabs();
  saveSession();
  return t;
}

function go(t, url, { quiet } = {}) {
  if (!url) return;
  closeFind();
  if (isInternal(url)) {
    if (t.live) send('drop', { id: t.id });
    Object.assign(t, { url, live: false, loading: false, icon: '', title: '', pending: false });
  } else {
    if (!t.live) t.zoom = 1;
    if (hostOf(url) !== hostOf(t.url)) t.icon = '';
    Object.assign(t, { url, title: '', live: true, loading: true, pending: false });
    send('nav', { id: t.id, url });
  }
  if (!quiet && t.id === activeId) present(!isInternal(url));
  else paintTabs();
  saveSession();
}

/** Navigate the current tab (or a new one). */
export function open(url, { newTab: inNew, background } = {}) {
  if (!url) return;
  if (inNew || background) newTab(url, { activate: !background });
  else go(active(), url);
}

function activate_(id, { focusPage } = {}) {
  if (!byId(id)) return;
  activeId = id;
  present(focusPage);
  saveSession();
}

function present(focusPage = false) {
  const t = active();
  if (!t) return;
  if (t.pending) {
    t.pending = false;
    t.live = true;
    t.loading = true;
    send('nav', { id: t.id, url: t.url });
  }
  const internal = isInternal(t.url);
  send('show', { id: internal || !t.live ? null : t.id, focus: focusPage || internal });
  root.classList.toggle('on-internal', internal);
  const inner = $('#inner');
  if (internal) renderPage(inner, internalName(t.url), api);
  else inner.replaceChildren();
  paintTabs();
  paintBar();
  scrollTabIntoView(t.id);
}

export function closeTab(id = activeId) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  if (t.live) send('drop', { id: t.id });
  if (!isInternal(t.url) || t.url !== 'roamer:start') closedTabs.push({ url: t.url, title: t.title, icon: t.icon, index: i });
  if (closedTabs.length > 25) closedTabs.shift();
  if (!tabs.length) {
    newTab('roamer:start');
    return;
  }
  if (id === activeId) {
    // go back to the tab that opened this one, else the neighbour on the right, else the left
    const next = (t.opener && byId(t.opener)) || tabs[Math.min(i, tabs.length - 1)];
    activate_(next.id, { focusPage: true });
  } else paintTabs();
  saveSession();
}

function reopenClosed() {
  const c = closedTabs.pop();
  if (!c) return;
  const t = newTab(c.url, { after: tabs[c.index - 1]?.id ?? null, title: c.title, icon: c.icon });
  if (c.index === 0) moveTab(t.id, 0);
}

function moveTab(id, to) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  tabs.splice(clamp(to, 0, tabs.length), 0, t);
  paintTabs();
  saveSession();
}

const cycle = (d) => {
  const i = tabs.findIndex((t) => t.id === activeId);
  activate_(tabs[(i + d + tabs.length) % tabs.length].id, { focusPage: true });
};

const saveSession = debounce(() => {
  S.saveSession({
    tabs: tabs.map((t) => ({ url: t.url, title: t.title, icon: t.icon })),
    active: tabs.findIndex((t) => t.id === activeId),
  });
}, 400);

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
      h('button', { class: 'tab-new', title: 'New tab (Ctrl+T)', onclick: () => newTab(), html: icon('plus', 15) })),
    h('div', { class: 'tb-drag tb-fill', ...drag }),
    plat === 'windows' || plat === 'linux'
      ? h('div', { class: 'tb-btns' },
        h('button', { class: 'tb-btn', title: 'Minimize', onclick: () => send('win', { c: 'min' }), html: icon('winMin', 14) }),
        maxBtn,
        h('button', { class: 'tb-btn close', title: 'Close', onclick: closeWindow, html: icon('close', 14) }))
      : null,
  );
  // invisible edge handles so the undecorated window can still be resized
  if (plat === 'windows' || plat === 'linux') {
    for (const d of ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']) {
      document.body.append(h('i', { class: 'rz rz-' + d, onmousedown: (e) => (e.preventDefault(), send('win', { c: 'resize:' + d })) }));
    }
  }
}

async function closeWindow() {
  const live = tabs.filter((t) => !isInternal(t.url)).length;
  if (S.settings.askClose && !S.settings.restoreTabs && live > 1) {
    const ok = await dialog({ title: `Close ${tabs.length} tabs?`, text: 'Turn on "Reopen tabs" in Settings to get them back next time.', ok: 'Close all', danger: true });
    if (!ok) return;
  }
  saveSession.flush();
  send('win', { c: 'close' });
}

let dragId = null;
function paintTabs() {
  const strip = tabsEl;
  strip.replaceChildren(...tabs.map((t) => {
    const el = h('div', {
      class: 'tab-i' + (t.id === activeId ? ' on' : '') + (t.loading ? ' loading' : ''),
      title: titleOf(t) + (isInternal(t.url) ? '' : '\n' + t.url),
      draggable: 'true',
      dataset: { id: t.id },
      onmousedown: (e) => e.button === 0 && !e.target.closest('.ti-x') && t.id !== activeId && activate_(t.id, { focusPage: true }),
      onauxclick: (e) => e.button === 1 && (e.preventDefault(), closeTab(t.id)),
      oncontextmenu: (e) => (e.preventDefault(), tabMenu(t, e.clientX, e.clientY)),
      ondragstart: (e) => ((dragId = t.id), e.dataTransfer.setData('text/plain', t.url), (e.dataTransfer.effectAllowed = 'move')),
      ondragend: () => ((dragId = null), strip.querySelectorAll('.drop-l,.drop-r').forEach((x) => x.classList.remove('drop-l', 'drop-r'))),
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
        if (dragId == null || dragId === t.id) return;
        const left = el.classList.contains('drop-l');
        const from = tabs.findIndex((x) => x.id === dragId);
        let to = tabs.findIndex((x) => x.id === t.id) + (left ? 0 : 1);
        if (from < to) to--;
        moveTab(dragId, to);
      },
    },
    h('span', { class: 'ti-ic' }, t.loading ? h('i', { class: 'spin' }) : isInternal(t.url) ? h('i', { html: icon(INTERNAL[internalName(t.url)]?.icon || 'compass', 14) }) : favicon(t.icon, 14)),
    h('span', { class: 'ti-t' }, titleOf(t)),
    h('button', { class: 'ti-x', title: 'Close tab (Ctrl+W)', onclick: (e) => (e.stopPropagation(), closeTab(t.id)), html: icon('close', 11) }));
    return el;
  }));
  root.classList.toggle('many-tabs', tabs.length > 1);
}
const scrollTabIntoView = (id) => tabsEl.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

function tabMenu(t, x, y) {
  const i = tabs.indexOf(t);
  showMenu([
    { label: 'New tab to the right', icon: 'plus', run: () => newTab(undefined, { after: t.id }) },
    { sep: true },
    { label: 'Reload', icon: 'reload', disabled: !t.live, run: () => send('reload', { id: t.id }) },
    { label: 'Duplicate', icon: 'copy', run: () => newTab(t.url, { after: t.id }) },
    { label: S.bookmarkOf(t.url) ? 'Remove bookmark' : 'Bookmark this tab', icon: 'star', disabled: isInternal(t.url), run: () => toggleBookmark(t) },
    { sep: true },
    { label: 'Close tab', icon: 'close', kbd: 'Ctrl+W', run: () => closeTab(t.id) },
    { label: 'Close other tabs', disabled: tabs.length < 2, run: () => tabs.filter((x) => x !== t).forEach((x) => closeTab(x.id)) },
    { label: 'Close tabs to the right', disabled: i === tabs.length - 1, run: () => tabs.slice(i + 1).forEach((x) => closeTab(x.id)) },
    { sep: true },
    { label: 'Reopen closed tab', icon: 'restore', kbd: 'Ctrl+Shift+T', disabled: !closedTabs.length, run: reopenClosed },
  ], x, y);
}

// ------------------------------------------------------------ toolbar + address bar
const q = h('input', { id: 'q', class: 'q', spellcheck: 'false', autocomplete: 'off', placeholder: 'Search or enter an address' });
const pretty = h('div', { class: 'addr-pretty' });
const addrIc = h('span', { class: 'a-ic' });
const zoomChip = h('button', { class: 'zoom-chip', title: 'Reset zoom (Ctrl+0)', onclick: () => setZoom(1) });
const star = h('button', { class: 'a-btn', title: 'Bookmark this page (Ctrl+D)', onclick: () => toggleBookmark(active()) });
const go_ = h('button', { class: 'go', title: 'Go', onclick: () => submit(), html: icon('go', 18) });
const field = h('div', { class: 'field cut' }, addrIc, h('div', { class: 'q-wrap' }, q, pretty), zoomChip, star, go_);
const sugg = h('div', { class: 'sugg cut', hidden: true });
const btn = (ic, title, run, extra = {}) => h('button', { class: 'ibtn', title, onclick: run, html: icon(ic, 19), ...extra });
const backBtn = btn('back', 'Back (Alt+Left)', () => send('back', { id: activeId }));
const fwdBtn = btn('forward', 'Forward (Alt+Right)', () => send('fwd', { id: activeId }));
const reloadBtn = btn('reload', 'Reload (Ctrl+R)', () => reloadOrStop());
const dlBtn = btn('download', 'Downloads (Ctrl+J)', () => openInternal('downloads'));
const dlBadge = h('i', { class: 'dotbadge', hidden: true });
dlBtn.append(dlBadge);

function buildToolbar() {
  $('#toolbar').append(
    h('div', { class: 'nav-btns' }, backBtn, fwdBtn, reloadBtn, btn('home', 'Home', () => open(homeUrl()))),
    h('div', { class: 'addr' }, field, sugg),
    h('div', { class: 'tool-btns' },
      btn('bookmarks', 'Bookmarks', () => openInternal('bookmarks')),
      btn('history', 'History (Ctrl+H)', () => openInternal('history')),
      dlBtn,
      btn('more', 'Menu', (e) => mainMenu(e.currentTarget))),
  );
  // the first click into the address selects all of it (later clicks place the caret)
  q.addEventListener('mousedown', (e) => {
    if (document.activeElement === q) return;
    e.preventDefault();
    send('focuschrome');
    q.focus();
  });
  q.addEventListener('focus', () => {
    field.classList.add('focus');
    if (!field.classList.contains('edited')) q.select();
  });
  q.addEventListener('blur', () => {
    field.classList.remove('focus');
    setTimeout(() => {
      if (document.activeElement !== q) hideSugg();
    }, 150);
    paintAddress();
  });
  q.addEventListener('input', () => {
    field.classList.add('edited');
    suggest();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(e.altKey || e.ctrlKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!sugg.hidden) return hideSugg();
      field.classList.remove('edited');
      paintAddress(true);
      q.blur();
      const t = active();
      if (t?.live) send('show', { id: t.id, focus: true });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (sugg.hidden) return;
      e.preventDefault();
      moveSugg(e.key === 'ArrowDown' ? 1 : -1);
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
  const url = pick ? pick.url : resolve(q.value);
  hideSugg();
  field.classList.remove('edited');
  if (!url) return;
  q.blur();
  open(url, { newTab: inNew });
}

function paintAddress(force) {
  const t = active();
  if (!t) return;
  if (document.activeElement === q && !force) return;
  if (field.classList.contains('edited') && !force) return;
  const internal = isInternal(t.url);
  q.value = internal && t.url === 'roamer:start' ? '' : t.url;
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
  } else if (t.url !== 'roamer:start') pretty.append(h('span', { class: 'p-scheme' }, 'roamer:'), h('span', { class: 'p-host' }, internalName(t.url)));
  addrIc.innerHTML = icon(internal ? 'compass' : secure ? 'lock' : t.url.startsWith('http:') ? 'unlock' : 'globe', 16);
  addrIc.className = 'a-ic' + (secure ? ' secure' : '') + (t.url.startsWith('http:') ? ' insecure' : '');
  addrIc.title = internal ? 'Web Roamer page' : secure ? 'Secure connection' : 'This connection is not encrypted';
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
  zoomChip.hidden = !web || Math.abs(t.zoom - 1) < 0.001;
  zoomChip.textContent = Math.round(t.zoom * 100) + '%';
  root.classList.toggle('loading', !!t.loading);
  const title = titleOf(t);
  document.title = `${title} · Web Roamer`;
  send('title', { s: `${title} - Web Roamer` });
}

// ------------------------------------------------------------ suggestions
let suggItems = [], suggIndex = -1;
function suggest() {
  const text = q.value.trim();
  if (!text) return hideSugg();
  const low = text.toLowerCase();
  const target = resolve(text);
  const isSearch = target === searchUrl(text);
  const items = [isSearch
    ? { kind: 'search', url: target, title: text, sub: `Search ${S.ENGINES[S.settings.engine]?.name || ''}` }
    : { kind: 'go', url: target, title: target, sub: 'Go to address' }];
  const seen = new Set([target]);
  const match = (e) => (e.url || '').toLowerCase().includes(low) || (e.title || '').toLowerCase().includes(low);
  for (const b of S.bookmarks) {
    if (items.length >= 4) break;
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
  for (const e of hist.slice(0, 8 - items.length)) items.push({ kind: 'history', url: e.url, title: e.title || e.url, icon: e.icon });
  suggItems = items;
  suggIndex = -1;
  paintSugg();
  sugg.hidden = false;
  holdOverlay('sugg', true);
}
function paintSugg() {
  sugg.replaceChildren(...suggItems.map((it, i) => h('div', {
    class: 'sg' + (i === suggIndex ? ' hi' : '') + ' k-' + it.kind,
    onmousedown: (e) => (e.preventDefault(), (suggIndex = i), submit(e.button === 1)),
    onmouseenter: () => ((suggIndex = i), sugg.querySelectorAll('.sg').forEach((el, j) => el.classList.toggle('hi', j === i))),
  },
  h('span', { class: 'sg-ic' }, it.kind === 'search' ? h('i', { html: icon('search', 15) }) : it.kind === 'go' ? h('i', { html: icon('go', 15) }) : favicon(it.icon, 15)),
  h('span', { class: 'sg-n' }, it.title),
  h('span', { class: 'sg-u' }, it.kind === 'search' || it.kind === 'go' ? it.sub : it.url.replace(/^https?:\/\/(www\.)?/, '')),
  h('span', { class: 'sg-c' }, { bookmark: 'bookmark', history: 'visited', search: 'search', go: 'address' }[it.kind]))));
}
function moveSugg(d) {
  suggIndex = clamp(suggIndex + d, -1, suggItems.length - 1);
  paintSugg();
  const it = suggItems[suggIndex];
  if (it && it.kind !== 'search') q.value = it.url;
  else if (it) q.value = it.title;
}
function hideSugg() {
  sugg.hidden = true;
  suggItems = [];
  suggIndex = -1;
  holdOverlay('sugg', false);
}

export function focusAddress(text) {
  send('focuschrome');
  if (text != null) {
    q.value = text;
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
function paintBookmarksBar() {
  bmbar.replaceChildren(
    ...S.bookmarks.map((b) => h('a', {
      class: 'bm', href: b.url, title: `${b.title}\n${b.url}`, draggable: 'false',
      onclick: (e) => (e.preventDefault(), open(b.url, { newTab: e.ctrlKey || e.metaKey })),
      onauxclick: (e) => e.button === 1 && (e.preventDefault(), open(b.url, { background: true })),
      oncontextmenu: (e) => (e.preventDefault(), bookmarkMenu(b, e.clientX, e.clientY)),
    }, h('span', {}, favicon(b.icon, 14, b.title), h('b', {}, b.title || hostOf(b.url))))),
    !S.bookmarks.length ? h('span', { class: 'bm-empty' }, 'Bookmarks you add with the star (Ctrl+D) show up here') : null,
  );
}
export function bookmarkMenu(b, x, y) {
  showMenu([
    { header: b.title || b.url },
    { label: 'Open', icon: 'go', run: () => open(b.url) },
    { label: 'Open in new tab', icon: 'tab', run: () => open(b.url, { newTab: true }) },
    { sep: true },
    { label: 'Edit…', icon: 'edit', run: () => editBookmark(b) },
    { label: 'Copy address', icon: 'link', run: () => navigator.clipboard?.writeText(b.url) },
    { label: 'Delete', icon: 'trash', danger: true, run: () => deleteBookmark(b) },
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

// ------------------------------------------------------------ find in page
const findInput = h('input', { class: 'find-q', placeholder: 'Find in page', spellcheck: 'false' });
const findState = h('span', { class: 'find-state' });
const findbar = $('#findbar');
let lastFind = '';
function buildFindbar() {
  const step = (back) => {
    const v = findInput.value;
    if (!v) return;
    send('find', { id: activeId, q: v, back, fresh: v !== lastFind });
    lastFind = v;
  };
  findbar.append(
    h('span', { class: 'find-ic', html: icon('find', 15) }),
    findInput, findState,
    h('button', { class: 'ibtn sm', title: 'Previous (Shift+Enter)', onclick: () => step(true), html: icon('up', 15) }),
    h('button', { class: 'ibtn sm', title: 'Next (Enter)', onclick: () => step(false), html: icon('down', 15) }),
    h('button', { class: 'ibtn sm', title: 'Close (Esc)', onclick: () => closeFind(true), html: icon('close', 15) }));
  findInput.addEventListener('input', debounce(() => step(false), 180));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault(), step(e.shiftKey);
    else if (e.key === 'Escape') e.preventDefault(), closeFind(true);
  });
}
function openFind() {
  const t = active();
  if (!t?.live) return;
  findbar.hidden = false;
  send('focuschrome');
  findInput.focus();
  findInput.select();
  syncArea();
}
function closeFind(focusPage) {
  if (findbar.hidden) return;
  findbar.hidden = true;
  findbar.classList.remove('miss');
  findState.textContent = '';
  lastFind = '';
  syncArea();
  if (focusPage && active()?.live) send('focus', { id: activeId });
}

// ------------------------------------------------------------ zoom
const ZOOMS = [0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function setZoom(z) {
  const t = active();
  if (!t?.live) return;
  t.zoom = z;
  send('zoom', { id: t.id, z });
  paintBar();
}
function zoomStep(d) {
  const t = active();
  if (!t) return;
  const i = ZOOMS.findIndex((z) => z >= t.zoom - 0.001);
  setZoom(ZOOMS[clamp((i < 0 ? ZOOMS.length - 1 : i) + d, 0, ZOOMS.length - 1)]);
}

// ------------------------------------------------------------ main menu
function mainMenu(anchor) {
  const t = active();
  const web = t?.live && !isInternal(t.url);
  const zoomRow = h('div', { class: 'cm-zoom' },
    h('span', { class: 'cm-t' }, 'Zoom'),
    h('button', { class: 'ibtn sm', disabled: !web, onclick: () => (zoomStep(-1), (zv.textContent = Math.round(active().zoom * 100) + '%')), html: icon('minus', 14) }),
    h('b', {}, ''),
    h('button', { class: 'ibtn sm', disabled: !web, onclick: () => (zoomStep(1), (zv.textContent = Math.round(active().zoom * 100) + '%')), html: icon('plus', 14) }),
    h('button', { class: 'ibtn sm', title: 'Full screen (F11)', onclick: () => (closeMenu(), send('win', { c: 'fs' })), html: icon('fullscreen', 14) }));
  const zv = zoomRow.querySelector('b');
  zv.textContent = Math.round((t?.zoom || 1) * 100) + '%';
  showMenu([
    { label: 'New tab', icon: 'plus', kbd: 'Ctrl+T', run: () => newTab() },
    { label: 'Reopen closed tab', icon: 'restore', kbd: 'Ctrl+Shift+T', disabled: !closedTabs.length, run: reopenClosed },
    { sep: true },
    { label: 'Bookmarks', icon: 'bookmarks', run: () => openInternal('bookmarks') },
    { label: 'History', icon: 'history', kbd: 'Ctrl+H', run: () => openInternal('history') },
    { label: 'Downloads', icon: 'download', kbd: 'Ctrl+J', run: () => openInternal('downloads') },
    { label: 'Bookmarks bar', checked: S.settings.bookmarksBar, kbd: 'Ctrl+Shift+B', run: () => S.setSetting('bookmarksBar', !S.settings.bookmarksBar) },
    { sep: true },
    { node: zoomRow },
    { label: 'Find in page…', icon: 'find', kbd: 'Ctrl+F', disabled: !web, run: openFind },
    { label: 'Print…', icon: 'print', disabled: !web, run: () => send('print', { id: activeId }) },
    { label: 'Developer tools', icon: 'code', kbd: 'F12', disabled: !web, run: () => send('devtools', { id: activeId }) },
    { sep: true },
    { label: 'Settings', icon: 'settings', kbd: 'Ctrl+,', run: () => openInternal('settings') },
  ], 0, 0, { anchor });
}

/** Internal pages open in a tab of their own (reusing it if one is open). */
export function openInternal(name) {
  const url = 'roamer:' + name;
  const there = tabs.find((t) => t.url === url);
  if (there) return activate_(there.id);
  const t = active();
  if (t && t.url === 'roamer:start') go(t, url);
  else newTab(url);
}

// ------------------------------------------------------------ keys
const KEYMAP = {
  'c+t': () => newTab(),
  'c+n': () => newTab(),
  'c+w': () => closeTab(),
  'cs+t': reopenClosed,
  'c+tab': () => cycle(1),
  'cs+tab': () => cycle(-1),
  'c+pagedown': () => cycle(1),
  'c+pageup': () => cycle(-1),
  'c+9': () => activate_(tabs[tabs.length - 1].id, { focusPage: true }),
  'c+l': () => focusAddress(),
  'a+d': () => focusAddress(),
  '+f6': () => focusAddress(),
  'c+r': () => send('reload', { id: activeId }),
  '+f5': () => send('reload', { id: activeId }),
  'cs+r': () => send('hardreload', { id: activeId }),
  'c+f5': () => send('hardreload', { id: activeId }),
  'a+arrowleft': () => send('back', { id: activeId }),
  'a+arrowright': () => send('fwd', { id: activeId }),
  'c+d': () => toggleBookmark(active()),
  'c+h': () => openInternal('history'),
  'c+j': () => openInternal('downloads'),
  'cs+b': () => S.setSetting('bookmarksBar', !S.settings.bookmarksBar),
  'c+f': openFind,
  'c+=': () => zoomStep(1),
  'c++': () => zoomStep(1),
  'cs++': () => zoomStep(1),
  'c+-': () => zoomStep(-1),
  'c+0': () => setZoom(1),
  '+f11': () => send('win', { c: 'fs' }),
  '+f12': () => send('devtools', { id: activeId }),
  'c+,': () => openInternal('settings'),
  'cs+delete': () => openInternal('settings'),
};
for (let n = 1; n <= 8; n++) KEYMAP['c+' + n] = () => tabs[n - 1] && activate_(tabs[n - 1].id, { focusPage: true });

function runKey(k) {
  const fn = KEYMAP[k];
  if (!fn) return false;
  closeMenu();
  fn();
  return true;
}
document.addEventListener('keydown', (e) => {
  const k = combo(e);
  // typing in a field keeps its own editing keys
  if (e.target.matches?.('input, textarea') && ['c+a', 'c+c', 'c+v', 'c+x', 'c+z', 'a+arrowleft', 'a+arrowright'].includes(k)) return;
  if (k === '+escape' && root.classList.contains('fullscreen')) return send('win', { c: 'fs' });
  if (k === '+escape' && active()?.loading && document.activeElement !== q) return send('stop', { id: activeId });
  if (runKey(k)) e.preventDefault();
});
// the mouse's back/forward buttons over the chrome
addEventListener('mouseup', (e) => {
  if (e.button === 3) send('back', { id: activeId });
  else if (e.button === 4) send('fwd', { id: activeId });
});

// ------------------------------------------------------------ the page area
const pageEl = $('#page');
function syncArea() {
  const r = pageEl.getBoundingClientRect();
  send('area', { x: r.left, y: r.top, w: r.width, h: r.height });
}
new ResizeObserver(() => syncArea()).observe(pageEl);
addEventListener('resize', syncArea);

// ------------------------------------------------------------ messages from the native side
let dlCount = 0;
function paintDownloads() {
  const n = S.downloads.filter((d) => d.state === 'active').length;
  dlBadge.hidden = !n;
  dlBadge.textContent = n;
}
on('init', (m) => {
  api.info = m;
  if (S.settings.downloadsDir) send('dldir', { path: S.settings.downloadsDir });
});
on('wstate', (m) => {
  root.classList.toggle('maxed', !!m.max);
  root.classList.toggle('fullscreen', !!m.fs);
  maxBtn.innerHTML = icon(m.max ? 'winRestore' : 'winMax', 14);
  maxBtn.title = m.max ? 'Restore' : 'Maximize';
  requestAnimationFrame(syncArea);
});
on('tab', (m) => {
  const t = byId(m.id);
  if (!t || !t.live) return;
  if (m.url != null && m.url !== t.url && /^(https?|file|about|data):/i.test(m.url)) {
    if (hostOf(m.url) !== hostOf(t.url)) t.icon = '';
    if (m.loading) t.title = ''; // a new document: its title comes in a moment
    t.url = m.url;
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
  if (m.loading != null) {
    t.loading = m.loading;
    if (!m.loading) S.recordVisit(t.url, t.title, t.icon);
  }
  if (t.id === activeId) paintBar();
  paintTabs();
  saveSession();
});
on('key', (m) => runKey(m.k));
on('newtab', (m) => newTab(m.url, { after: m.opener }));
on('found', (m) => {
  findbar.classList.toggle('miss', !m.ok);
  findState.textContent = m.ok ? '' : 'not found';
});
on('dl', (m) => {
  const d = S.upsertDownload(m);
  if (m.state === 'active') {
    dlCount++;
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
    requestAnimationFrame(syncArea);
  }
  if (what === 'bookmarks' || what === 'settings') paintBookmarksBar(), paintBar();
  if (what === 'downloads') paintDownloads();
  // the open internal page follows its data
  const t = active();
  if (t && isInternal(t.url)) renderPage($('#inner'), internalName(t.url), api, what);
});

/** What the internal pages may do. */
export const api = {
  open, newTab, openInternal, focusAddress, resolve, searchUrl, editBookmark, deleteBookmark, bookmarkMenu, send, info: null,
  tabs: () => tabs,
};

// ------------------------------------------------------------ boot
buildTitlebar();
buildToolbar();
buildFindbar();
paintBookmarksBar();
paintDownloads();
initTopo();

const restore = S.settings.restoreTabs && S.session?.tabs?.length ? S.session : null;
if (restore) {
  restore.tabs.forEach((t, i) => newTab(t.url || 'roamer:start', { activate: false, pending: i !== restore.active, title: t.title, icon: t.icon, after: null }));
  activeId = tabs[clamp(restore.active, 0, tabs.length - 1)].id;
}
for (const url of window.__start || []) newTab(url, { activate: false, after: null }), (activeId = tabs[tabs.length - 1].id);
if (!tabs.length) newTab(homeUrl(), { activate: false });
activeId ??= tabs[0].id;
send('ready');
requestAnimationFrame(() => {
  syncArea();
  present(!isInternal(active().url));
  if (active().url === 'roamer:start') $('#inner .start-q')?.focus();
});
if (!isNative) root.classList.add('web');
