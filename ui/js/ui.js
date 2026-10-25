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
// items: [{label, icon, kbd, run, danger, disabled, checked}, {sep:true}, {header:'Text'}, falsy → skipped]
let open = null;
export function closeMenu() {
  if (!open) return;
  open.el.remove();
  open.off();
  open = null;
  holdOverlay('menu', false);
}
export const menuOpen = () => !!open;

export function showMenu(items, x, y, { anchor } = {}) {
  closeMenu();
  const el = h('div', { class: 'ctxm', role: 'menu', tabindex: '-1' });
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
    const row = h('button', { class: 'cm-i' + (it.danger ? ' danger' : '') + (it.disabled ? ' off' : '') + (it.checked ? ' chk' : ''), type: 'button' },
      h('i', { class: 'cm-ic', html: it.checked ? icon('check', 15) : it.icon ? icon(it.icon, 15) : '' }),
      h('span', { class: 'cm-t' }, it.label),
      it.kbd ? h('kbd', { class: 'cm-k' }, it.kbd) : null);
    row.onmouseenter = () => hi(row);
    row.onclick = (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      closeMenu();
      it.run?.(e);
    };
    row._it = it;
    el.append(row);
    rows.push(row);
  }
  holdOverlay('menu', true);
  document.body.append(el);
  const w = el.offsetWidth, hh = el.offsetHeight;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = r.right - w;
    y = r.bottom + 4;
  }
  el.style.left = Math.max(6, Math.min(x, innerWidth - w - 6)) + 'px';
  el.style.top = Math.max(6, y + hh > innerHeight - 6 ? y - hh : y) + 'px';
  requestAnimationFrame(() => el.classList.add('in'));
  el.focus();
  let cur = -1;
  function hi(row) {
    rows.forEach((r) => r.classList.toggle('hi', r === row));
    cur = rows.indexOf(row);
  }
  const key = (e) => {
    const live = rows.filter((r) => !r._it.disabled);
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = live.indexOf(rows[cur]);
      hi(live[(i + (e.key === 'ArrowDown' ? 1 : -1) + live.length) % live.length]);
    } else if (e.key === 'Enter' && rows[cur]) rows[cur].click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const away = (e) => !el.contains(e.target) && closeMenu();
  document.addEventListener('keydown', key, true);
  setTimeout(() => document.addEventListener('pointerdown', away, true));
  addEventListener('blur', closeMenu);
  open = {
    el,
    off: () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', away, true);
      removeEventListener('blur', closeMenu);
    },
  };
}

/** A favicon that falls back to the globe (or a letter tile) when the site has none. */
export function favicon(src, size = 16, label = '') {
  const fallback = () => (label ? h('i', { class: 'fav-letter', style: { '--fs': size + 'px' } }, label[0].toUpperCase()) : h('i', { class: 'fav-globe', html: icon('globe', size) }));
  if (!src) return fallback();
  const img = h('img', { class: 'fav', src, width: size, height: size, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.onerror = () => img.replaceWith(fallback());
  return img;
}
