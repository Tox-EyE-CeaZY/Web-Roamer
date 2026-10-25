// The wire to the native side (src/main.rs). Messages out are JSON {t, ...}; messages in arrive through window.__rr.
// Opened in an ordinary browser (for working on the interface), pages are faked with iframes so the chrome still runs.

export const isNative = typeof window.ipc?.postMessage === 'function';
const handlers = {};
export const on = (t, fn) => (handlers[t] ||= []).push(fn);
const emit = (m) => (handlers[m.t] || []).forEach((fn) => fn(m));
window.__rr = emit;

export function send(t, data = {}) {
  if (isNative) window.ipc.postMessage(JSON.stringify({ t, ...data }));
  else fake(t, data);
}

// ------------------------------------------------------------ iframe stand-in (no native side)
const frames = new Map();
let shown = [], overlay = false;
function host() {
  return document.body;
}
function fakeVis() {
  for (const [id, f] of frames) {
    const r = shown.find((v) => v.id === id);
    f.style.display = !overlay && r ? 'block' : 'none';
    if (r) Object.assign(f.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  }
}
function fake(t, d) {
  switch (t) {
    case 'ready':
      setTimeout(() => emit({ t: 'init', plat: 'web', version: 'dev', downloads: '~/Downloads' }));
      break;
    case 'nav': {
      let f = frames.get(d.id);
      if (!f) {
        f = document.createElement('iframe');
        f.className = 'fake-page';
        f.onload = () => {
          let title = '';
          try {
            title = f.contentDocument?.title;
          } catch { /* cross-origin */ }
          emit({ t: 'tab', id: d.id, loading: false, url: f.dataset.url });
          if (title) emit({ t: 'tab', id: d.id, title });
        };
        frames.set(d.id, f);
        host().append(f);
      }
      f.dataset.url = d.url;
      f.src = d.url;
      emit({ t: 'tab', id: d.id, loading: true, url: d.url });
      fakeVis();
      break;
    }
    case 'drop':
      frames.get(d.id)?.remove();
      frames.delete(d.id);
      break;
    case 'layout':
      shown = d.views || [];
      fakeVis();
      break;
    case 'overlay':
      overlay = !!d.on;
      fakeVis();
      break;
    case 'reload':
      frames.get(d.id)?.setAttribute('src', frames.get(d.id).src);
      break;
    case 'win':
      if (d.c === 'fs') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
      break;
    default:
  }
}
