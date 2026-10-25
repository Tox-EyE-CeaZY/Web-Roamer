import * as S from './store.js';

/**
 * Search engines beyond the default one. Each has a short keyword: type "e6 wolf" in the address bar to search e621,
 * or scroll over the address bar to flip through them. The ones listed here are always there; sites with a search of
 * their own are added as you visit them (see `found`), and Settings can add or remove any.
 */
export const BUILTIN = [
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', key: 'dd', remote: true },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', key: 'g', remote: true },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', key: 'bi', remote: true },
  { id: 'brave', name: 'Brave', url: 'https://search.brave.com/search?q=%s', key: 'br', remote: true },
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s', key: 'sp' },
  { id: 'ecosia', name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', key: 'ec' },
  { id: 'wikipedia', name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=%s', key: 'w' },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s', key: 'yt' },
  { id: 'github', name: 'GitHub', url: 'https://github.com/search?q=%s', key: 'gh' },
  { id: 'reddit', name: 'Reddit', url: 'https://www.reddit.com/search/?q=%s', key: 'r' },
  { id: 'stackoverflow', name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q=%s', key: 'so' },
  { id: 'maps', name: 'Maps', url: 'https://www.google.com/maps/search/%s', key: 'map' },
  { id: 'e621', name: 'e621', url: 'https://e621.net/posts?tags=%s', key: 'e6', board: true },
  { id: 'e926', name: 'e926', url: 'https://e926.net/posts?tags=%s', key: 'e9', board: true },
  { id: 'danbooru', name: 'Danbooru', url: 'https://danbooru.donmai.us/posts?tags=%s', key: 'db', board: true },
  { id: 'gelbooru', name: 'Gelbooru', url: 'https://gelbooru.com/index.php?page=post&s=list&tags=%s', key: 'gb', board: true },
  { id: 'safebooru', name: 'Safebooru', url: 'https://safebooru.org/index.php?page=post&s=list&tags=%s', key: 'sb', board: true },
  { id: 'derpibooru', name: 'Derpibooru', url: 'https://derpibooru.org/search?q=%s', key: 'dp', board: true },
];

const user = () => (S.memo.engines ||= []);
const save = () => S.saveMemo();

/** The default engine first, then everything else you can search with. */
export function all() {
  const def = S.engine();
  const custom = S.settings.engine === 'custom';
  const defId = custom ? 'custom' : S.settings.engine;
  const list = [{ id: defId, name: def.name, url: def.url, key: BUILTIN.find((b) => b.id === defId)?.key || '', remote: !!BUILTIN.find((b) => b.id === defId)?.remote, def: true }];
  const taken = new Set(list.map((e) => e.id));
  const mine = user();
  for (const b of BUILTIN) if (!taken.has(b.id) && !mine.some((m) => m.id === b.id)) list.push(b), taken.add(b.id);
  for (const m of mine) if (!taken.has(m.id)) list.push(m), taken.add(m.id);
  return list;
}

export const byId = (id) => all().find((e) => e.id === id);
export const byKey = (k) => {
  k = (k || '').toLowerCase();
  if (!k) return null;
  const mine = user().find((e) => (e.key || '').toLowerCase() === k);
  return mine || BUILTIN.find((e) => e.key === k) || null;
};

/** "e6 wolf" → {engine, query}; null when the first word is no keyword (or there is nothing to search for). */
export function keyword(text) {
  const m = /^(\S{1,12})\s+(\S[\s\S]*)$/.exec(text.trim());
  if (!m || /[./:]/.test(m[1])) return null;
  const engine = byKey(m[1]);
  return engine ? { engine, query: m[2].trim() } : null;
}

export const searchUrl = (engine, q) => engine.url.replace('%s', encodeURIComponent(q).replace(/%20/g, engine.board ? '+' : '%20'));

// ------------------------------------------------------------ the ones sites tell us about
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** A short unused keyword for a name: "Board Roamer" → "br", "e621" → "e6", "Wikipedia" → "wi". */
export function abbreviate(name) {
  const used = new Set([...BUILTIN, ...user()].map((e) => (e.key || '').toLowerCase()));
  const clean = name.toLowerCase().replace(/\.(com|net|org|io|co|tv|app|dev|xyz)\b/g, '').replace(/[^a-z0-9 ]+/g, ' ').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const tries = [];
  if (words.length > 1) tries.push(words.map((w) => w[0]).join('').slice(0, 4));
  const flat = words.join('');
  for (let n = 2; n <= Math.min(5, flat.length); n++) tries.push(flat.slice(0, n));
  for (const t of tries) if (t.length >= 2 && !used.has(t)) return t;
  for (let i = 2; i < 100; i++) if (!used.has(flat.slice(0, 2) + i)) return flat.slice(0, 2) + i;
  return flat.slice(0, 3);
}

/**
 * A page told us how its site searches: {name, url (with %s), page}. Adds it as an engine with a keyword of its own
 * unless it is already known (or was removed before). Returns the new engine, or null.
 */
export function found({ name, url, page }) {
  const host = hostOf(page);
  if (!host || typeof url !== 'string' || (url.match(/%s/g) || []).length !== 1 || !/^https?:\/\//.test(url)) return null;
  if (hostOf(url) !== host && !hostOf(url).endsWith('.' + host) && !host.endsWith('.' + hostOf(url))) return null;
  if ((S.memo.noEngine || []).includes(host)) return null;
  if ([...BUILTIN, ...user(), ...(S.settings.engine === 'custom' ? [{ url: S.settings.customEngine }] : [])].some((e) => hostOf(e.url) === host)) return null;
  const nm = String(name || host).trim().slice(0, 40) || host;
  const e = { id: 'f:' + host, name: nm, url, key: abbreviate(nm), found: true, host };
  user().push(e);
  if (user().length > 60) user().shift();
  save();
  return e;
}

export function add({ name, url, key }) {
  const id = 'u:' + Date.now().toString(36);
  user().push({ id, name, url, key: key || abbreviate(name) });
  save();
}
export function update(id, patch) {
  const e = user().find((x) => x.id === id);
  if (e) Object.assign(e, patch);
  save();
}
export function remove(id) {
  const e = user().find((x) => x.id === id);
  if (!e) return;
  S.memo.engines = user().filter((x) => x !== e);
  if (e.host) S.memo.noEngine = [...(S.memo.noEngine || []), e.host].slice(-100);
  save();
}
export const mine = () => user();
