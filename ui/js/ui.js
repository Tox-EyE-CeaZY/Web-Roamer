import { h } from './util.js';
import { icon } from './icons.js';
import { send } from './native.js';

// ------------------------------------------------------------ overlay
// Pages are native views drawn above the chrome, so anything the chrome opens over the page area (menus, dialogs,
// the address suggestions) has to ask for the page to step aside while it is open.
const holders = new Set();
export function holdOverlay(key, on) {
  const before = holders.size > 0;
  on ? holders.add(key) : holders.delete(key);
  const now = holders.size > 0;
  if (now !== before) {
    document.documentElement.classList.toggle('overlaid', now);
    send('overlay', { on: now });
  }
}

// ------------------------------------------------------------ toasts
export function toast(msg, { action, run, err, ms = 3600 } = {}) {
  const host = document.getElementById('toasts');
  const el = h('div', { class: 'toast' + (err ? ' err' : '') },
    h('span', {}, msg),
    action ? h('button', { class: 'toast-act', onclick: () => (run?.(), kill()) }, action) : null);
  host.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  let t = setTimeout(kill, ms);
  el.onmouseenter = () => clearTimeout(t);
  el.onmouseleave = () => (t = setTimeout(kill, 1600));
  function kill() {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 300);
  }
}

// ------------------------------------------------------------ dialogs
export function dialog({ title, text, body, ok = 'OK', cancel = 'Cancel', danger, wide }) {
  return new Promise((res) => {
    const key = {};
    const back = h('div', { class: 'dlg-back', onpointerdown: (e) => e.target === back && done(false) });
    const okBtn = h('button', { class: 'btn primary' + (danger ? ' danger' : ''), onclick: () => done(true) }, ok);
    const box = h('div', { class: 'dlg cut' + (wide ? ' wide' : '') },
      h('div', { class: 'dlg-title' }, title),
      text ? h('p', { class: 'dlg-text' }, text) : null,
      body || null,
      h('div', { class: 'dlg-actions' }, cancel ? h('button', { class: 'btn', onclick: () => done(false) }, cancel) : null, okBtn));
    back.append(box);
    const keys = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) done(true);
    };
    document.addEventListener('keydown', keys, true);
    holdOverlay(key, true);
    document.body.append(back);
    requestAnimationFrame(() => back.classList.add('in'));
    setTimeout(() => (box.querySelector('input') || okBtn).focus(), 30);
    function done(v) {
      document.removeEventListener('keydown', keys, true);
      back.classList.remove('in');
      holdOverlay(key, false);
      setTimeout(() => back.remove(), 200);
      res(v);
    }
  });
}

/** Ask for a line of text; resolves to the text or null. */
export async function prompt(title, value = '', { label, ok = 'Save' } = {}) {
  const input = h('input', { class: 'input', value });
  const ok_ = await dialog({ title, body: h('label', { class: 'dlg-field' }, label ? h('span', {}, label) : null, input), ok });
  return ok_ ? input.value : null;
}

// ------------------------------------------------------------ menus
// items: [{label, icon, kbd, run, danger, disabled, checked, sub: [items] | () => [items]}, {sep:true}, {header:'Text'},
// {node: Element}, falsy → skipped]. A row with `sub` opens a submenu beside it (hover, click or →).
let open = null;
export function closeMenu() {
  if (!open) return;
  open.levels.forEach((l) => l.el.remove());
  open.off();
  open = null;
  holdOverlay('menu', false);
}
export const menuOpen = () => !!open;

function buildMenu(items, level) {
  const el = h('div', { class: 'ctxm' + (level ? ' sub' : ''), role: 'menu', tabindex: '-1' });
  const rows = [];
  let prevSep = true;
  for (const it of items.flat()) {
    if (!it) continue;
    if (it.sep) {
      if (!prevSep) el.append(h('div', { class: 'cm-sep' }));
      prevSep = true;
      continue;
    }
    prevSep = false;
    if (it.header) {
      el.append(h('div', { class: 'cm-head' }, it.header));
      continue;
    }
    if (it.node) {
      el.append(it.node);
      continue;
    }
    const row = h('button', { class: 'cm-i' + (it.danger ? ' danger' : '') + (it.disabled ? ' off' : '') + (it.checked ? ' chk' : '') + (it.sub ? ' has-sub' : ''), type: 'button', title: it.title || null },
      h('i', { class: 'cm-ic', html: it.checked ? icon('check', 15) : it.icon ? icon(it.icon, 15) : it.img ? '' : '' }, it.img || null),
      h('span', { class: 'cm-t' }, it.label),
      it.kbd ? h('kbd', { class: 'cm-k' }, it.kbd) : null,
      it.sub ? h('i', { class: 'cm-more', html: icon('right', 13) }) : null);
    row._it = it;
    el.append(row);
    rows.push(row);
  }
  if (!rows.length && !el.querySelector('.ctxm > *')) el.append(h('div', { class: 'cm-empty' }, 'Nothing here yet'));
  return { el, rows, cur: -1, level };
}

function place(el, x, y, { anchor, beside } = {}) {
  const w = el.offsetWidth, hh = el.offsetHeight;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = r.right - w;
    y = r.bottom + 4;
  }
  if (beside) {
    const r = beside.getBoundingClientRect();
    x = r.right + w + 4 > innerWidth ? r.left - w - 2 : r.right + 2;
    y = r.top - 6;
    if (y + hh > innerHeight - 6) y = innerHeight - 6 - hh;
  }
  el.style.left = Math.max(6, Math.min(x, innerWidth - w - 6)) + 'px';
  el.style.top = Math.max(6, y + hh > innerHeight - 6 && !beside ? y - hh : y) + 'px';
}

export function showMenu(items, x, y, { anchor, onClose } = {}) {
  closeMenu();
  const opened = Date.now();
  const levels = [];
  const hi = (lv, row) => {
    lv.rows.forEach((r) => r.classList.toggle('hi', r === row));
    lv.cur = lv.rows.indexOf(row);
  };
  const trim = (n) => {
    // close the submenus deeper than level n
    while (levels.length > n + 1) {
      const l = levels.pop();
      l.el.remove();
      l.parentRow?.classList.remove('open');
    }
  };
  let subTimer = 0;
  const openSub = (lv, row, focus) => {
    const it = row._it;
    trim(lv.level);
    if (!it.sub || it.disabled) return;
    const child = buildMenu(typeof it.sub === 'function' ? it.sub() : it.sub, lv.level + 1);
    child.parentRow = row;
    row.classList.add('open');
    wire(child);
    levels.push(child);
    document.body.append(child.el);
    place(child.el, 0, 0, { beside: row });
    requestAnimationFrame(() => child.el.classList.add('in'));
    if (focus) {
      const first = child.rows.find((r) => !r._it.disabled);
      if (first) hi(child, first);
    }
  };
  function wire(lv) {
    for (const row of lv.rows) {
      const it = row._it;
      row.onmouseenter = () => {
        hi(lv, row);
        clearTimeout(subTimer);
        subTimer = setTimeout(() => (it.sub ? openSub(lv, row) : trim(lv.level)), it.sub ? 120 : 200);
      };
      row.onclick = (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        if (it.sub) return openSub(lv, row, true);
        closeMenu();
        it.run?.(e);
      };
    }
  }
  const root = buildMenu(items, 0);
  wire(root);
  levels.push(root);
  holdOverlay('menu', true);
  document.body.append(root.el);
  place(root.el, x, y, { anchor });
  requestAnimationFrame(() => root.el.classList.add('in'));
  root.el.focus({ preventScroll: true });
  const key = (e) => {
    const lv = levels[levels.length - 1];
    const live = lv.rows.filter((r) => !r._it.disabled);
    if (e.target.matches?.('input, textarea') && !['Escape', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    if (e.key === 'Escape') levels.length > 1 ? trim(levels.length - 2) : closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = live.indexOf(lv.rows[lv.cur]);
      hi(lv, live[(i + (e.key === 'ArrowDown' ? 1 : -1) + live.length) % live.length]);
    } else if (e.key === 'ArrowRight' && lv.rows[lv.cur]?._it.sub) openSub(lv, lv.rows[lv.cur], true);
    else if (e.key === 'ArrowLeft' && levels.length > 1) trim(levels.length - 2);
    else if (e.key === 'Enter' && lv.rows[lv.cur]) lv.rows[lv.cur].click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const away = (e) => !levels.some((l) => l.el.contains(e.target)) && closeMenu();
  // Focus can bounce when the page views step aside for the menu (WebView2 moves focus as it hides them), which used to
  // close the menu the moment it opened. Only a real switch to another app closes it.
  let blurTimer = 0;
  const blur = () => {
    if (Date.now() - opened < 600) return;
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => !document.hasFocus() && closeMenu(), 250);
  };
  document.addEventListener('keydown', key, true);
  setTimeout(() => document.addEventListener('pointerdown', away, true));
  addEventListener('blur', blur);
  open = {
    levels,
    off: () => {
      clearTimeout(subTimer);
      clearTimeout(blurTimer);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', away, true);
      removeEventListener('blur', blur);
      onClose?.();
    },
  };
  return root.el;
}

// ------------------------------------------------------------ popovers
// A panel of its own (tab search, site info, the site-look offer) under an anchor. Closes on Escape or a click outside.
let pop = null;
export function closePopover() {
  if (!pop) return;
  const p = pop;
  pop = null;
  p.el.remove();
  p.off();
  holdOverlay('popover', false);
}
export function popover(content, { anchor, x, y, cls = '', onClose, align = 'left' } = {}) {
  closePopover();
  closeMenu();
  const el = h('div', { class: 'popv cut ' + cls }, content);
  holdOverlay('popover', true);
  document.body.append(el);
  const w = el.offsetWidth;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = align === 'right' ? r.right - w : r.left;
    y = r.bottom + 6;
  }
  el.style.left = Math.max(6, Math.min(x ?? 0, innerWidth - w - 6)) + 'px';
  el.style.top = Math.max(6, y ?? 0) + 'px';
  requestAnimationFrame(() => el.classList.add('in'));
  const away = (e) => !el.contains(e.target) && !anchor?.contains(e.target) && closePopover();
  const key = (e) => e.key === 'Escape' && (e.preventDefault(), closePopover());
  setTimeout(() => document.addEventListener('pointerdown', away, true));
  document.addEventListener('keydown', key, true);
  pop = {
    el,
    off: () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key, true);
      onClose?.();
    },
  };
  return el;
}

/** A favicon that falls back to the globe (or a letter tile) when the site has none. */
export function favicon(src, size = 16, label = '') {
  const fallback = () => (label ? h('i', { class: 'fav-letter', style: { '--fs': size + 'px' } }, label[0].toUpperCase()) : h('i', { class: 'fav-globe', html: icon('globe', size) }));
  if (!src) return fallback();
  const img = h('img', { class: 'fav', src, width: size, height: size, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.onerror = () => img.replaceWith(fallback());
  return img;
}
