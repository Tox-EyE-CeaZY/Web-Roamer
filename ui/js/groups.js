import { host } from './util.js';

/**
 * Smart tab groups: what a tab is about (the search that led to it, its site, the kind of site) and which tabs belong
 * together. Pure functions over the tab list; app.js owns the tabs and decides what to do with a suggestion.
 */

export const COLORS = { lime: 128, cyan: 200, blue: 255, violet: 300, pink: 350, red: 25, orange: 55, yellow: 95 };
export const colorNames = Object.keys(COLORS);

/** A colour that the open groups don't use yet (stable for a name, so "Rust" stays orange). */
export function pickColor(name, groups) {
  const used = new Set(groups.map((g) => g.color));
  let x = 0;
  for (const c of name || '') x = (x * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = 0; i < colorNames.length; i++) {
    const c = colorNames[(x + i) % colorNames.length];
    if (!used.has(c)) return c;
  }
  return colorNames[x % colorNames.length];
}

// ------------------------------------------------------------ what a page is about
/** Search result pages: host pattern → the query parameter. */
const SEARCHES = [
  [/(^|\.)google\.[a-z.]+$/, 'q', '/search'], [/(^|\.)bing\.com$/, 'q', '/search'], [/(^|\.)duckduckgo\.com$/, 'q'],
  [/(^|\.)search\.brave\.com$/, 'q'], [/(^|\.)startpage\.com$/, 'query'], [/(^|\.)startpage\.com$/, 'q'], [/(^|\.)ecosia\.org$/, 'q'],
  [/(^|\.)search\.yahoo\.com$/, 'p'], [/(^|\.)kagi\.com$/, 'q'], [/(^|\.)youtube\.com$/, 'search_query'], [/(^|\.)amazon\.[a-z.]+$/, 'k'],
  [/(^|\.)ebay\.[a-z.]+$/, '_nkw'], [/(^|\.)reddit\.com$/, 'q'], [/(^|\.)github\.com$/, 'q', '/search'], [/(^|\.)wikipedia\.org$/, 'search'],
  [/(^|\.)stackoverflow\.com$/, 'q'], [/(^|\.)etsy\.com$/, 'q'], [/(^|\.)twitch\.tv$/, 'term'], [/(^|\.)x\.com$/, 'q'],
];

/** The words someone searched for, when the address is a search results page. */
export function searchQuery(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const hn = u.hostname.replace(/^www\./, '');
  for (const [re, param, path] of SEARCHES) {
    if (!re.test(hn) || (path && !u.pathname.startsWith(path))) continue;
    const q = u.searchParams.get(param);
    if (q && q.trim()) return q.trim().slice(0, 120);
  }
  return '';
}
export const isSearchPage = (url) => !!searchQuery(url);

/** Rough kinds of sites, so three shops or three video sites can be grouped without a search in common. */
const KINDS = {
  Shopping: ['amazon', 'ebay', 'etsy', 'walmart', 'target', 'bestbuy', 'aliexpress', 'newegg', 'ikea', 'costco', 'shopify', 'temu', 'wish'],
  Video: ['youtube', 'youtu', 'twitch', 'vimeo', 'netflix', 'hulu', 'disneyplus', 'primevideo', 'dailymotion', 'crunchyroll', 'kick'],
  Music: ['spotify', 'soundcloud', 'bandcamp', 'music.apple', 'deezer', 'tidal', 'last'],
  Social: ['reddit', 'twitter', 'x', 'facebook', 'instagram', 'tiktok', 'threads', 'bsky', 'mastodon', 'tumblr', 'linkedin', 'pinterest', 'discord'],
  Dev: ['github', 'gitlab', 'stackoverflow', 'stackexchange', 'developer.mozilla', 'docs.rs', 'crates', 'npmjs', 'pypi', 'rust-lang', 'python', 'devdocs', 'codepen', 'jsfiddle', 'vercel', 'netlify', 'w3schools'],
  News: ['bbc', 'cnn', 'nytimes', 'theguardian', 'reuters', 'apnews', 'washingtonpost', 'bloomberg', 'npr', 'theverge', 'arstechnica', 'wired', 'techcrunch', 'news.ycombinator'],
  Work: ['mail.google', 'docs.google', 'drive.google', 'calendar.google', 'outlook', 'office', 'notion', 'slack', 'trello', 'asana', 'figma', 'miro', 'atlassian', 'zoom', 'teams.microsoft'],
  Reading: ['wikipedia', 'medium', 'substack', 'goodreads', 'archive', 'wikihow', 'fandom', 'quora'],
  Games: ['steampowered', 'store.steampowered', 'itch', 'epicgames', 'gog', 'ign', 'gamespot', 'polygon', 'nexusmods', 'roblox', 'chess'],
  Travel: ['booking', 'airbnb', 'expedia', 'tripadvisor', 'kayak', 'skyscanner', 'maps.google', 'hotels'],
  Learning: ['coursera', 'udemy', 'khanacademy', 'edx', 'duolingo', 'brilliant', 'freecodecamp', 'codecademy'],
};
export function kindOf(url) {
  const hn = host(url);
  if (!hn || /^(localhost|\d)/.test(hn)) return '';
  for (const [kind, names] of Object.entries(KINDS)) {
    for (const n of names) if (hn === n + '.com' || hn.startsWith(n + '.') || hn.includes('.' + n + '.') || hn === n) return kind;
  }
  return '';
}

/** "news.ycombinator.com" → "Ycombinator", "github.com" → "GitHub". */
const NICE = { github: 'GitHub', youtube: 'YouTube', gitlab: 'GitLab', stackoverflow: 'Stack Overflow', reddit: 'Reddit', wikipedia: 'Wikipedia', docs: 'Docs' };
export function siteName(url) {
  const parts = host(url).split('.');
  const core = parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2] || parts[0] || '';
  return NICE[core] || core.charAt(0).toUpperCase() + core.slice(1);
}

const STOP = new Set('a an the of to in on for and or with how what why is are do does can best vs near me my your from at by about'.split(' '));
export const words = (q) => (q || '').toLowerCase().split(/[^\p{L}\p{N}+#.]+/u).filter((w) => w.length > 1 && !STOP.has(w));
/** How much two searches are about the same thing, 0..1. */
export function overlap(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w) || [...B].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x)))) n++;
  return n / Math.min(A.size, B.size);
}

/** A group name out of a search: "best mechanical keyboards 2026" → "Mechanical keyboards". */
export function topicName(q) {
  const w = words(q).filter((x) => !/^\d{4}$/.test(x)).slice(0, 3);
  const s = (w.length ? w.join(' ') : q).slice(0, 22);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------ suggestions
/**
 * The best grouping to offer for the open tabs: {key, name, ids, into?, why}. `into` means "add these to that group".
 * Looks for, in order: tabs that match a group's searches, tabs that came out of the same search, three or more tabs
 * of one site, three or more tabs of one kind of site.
 */
export function suggest(tabs, groups, dismissed = new Set()) {
  const free = tabs.filter((t) => !t.group && !t.pinned && /^https?:/i.test(t.url || ''));
  const out = [];
  // 1. a free tab about the same thing as an existing group
  for (const g of groups) {
    const topics = [g.name, ...(g.topics || [])];
    const ids = free.filter((t) => t.topic && topics.some((x) => overlap(t.topic, x) >= 0.6)).map((t) => t.id);
    if (ids.length) out.push({ key: `into:${g.id}:${ids.join(',')}`, name: g.name, into: g.id, ids, why: 'Same subject as the group' });
  }
  // 2. tabs that came out of searches about the same thing
  const byTopic = [];
  for (const t of free) {
    if (!t.topic) continue;
    const c = byTopic.find((c) => overlap(c.q, t.topic) >= 0.6);
    if (c) c.ids.push(t.id);
    else byTopic.push({ q: t.topic, ids: [t.id] });
  }
  for (const c of byTopic) if (c.ids.length >= 3) out.push({ key: 'q:' + words(c.q).sort().join(' '), name: topicName(c.q), topic: c.q, ids: c.ids, why: `From your search “${c.q}”` });
  // 3. one site
  const bySite = new Map();
  for (const t of free) {
    if (isSearchPage(t.url)) continue;
    const k = host(t.url);
    bySite.set(k, [...(bySite.get(k) || []), t.id]);
  }
  for (const [k, ids] of bySite) if (ids.length >= 3) out.push({ key: 's:' + k, name: siteName('https://' + k), ids, why: `${ids.length} tabs on ${k}` });
  // 4. one kind of site
  const byKind = new Map();
  for (const t of free) {
    const k = kindOf(t.url);
    if (k) byKind.set(k, [...(byKind.get(k) || []), t.id]);
  }
  for (const [k, ids] of byKind) if (ids.length >= 3) out.push({ key: 'k:' + k + ':' + ids.length, name: k, ids, why: `${ids.length} ${k.toLowerCase()} tabs` });
  return out.filter((s) => !dismissed.has(s.key))[0] || null;
}

/** Everything worth grouping at once ("Organize tabs"). */
export function suggestAll(tabs, groups) {
  const plan = [];
  const taken = new Set();
  const view = tabs.map((t) => ({ ...t }));
  for (let i = 0; i < 12; i++) {
    const s = suggest(view.filter((t) => !taken.has(t.id)), groups, new Set(plan.map((p) => p.key)));
    if (!s) break;
    plan.push(s);
    s.ids.forEach((id) => taken.add(id));
  }
  return plan;
}

/** Which group a search belongs to, when one of the groups is clearly about it. */
export function groupForSearch(q, groups) {
  let best = null, score = 0;
  for (const g of groups) {
    for (const x of [g.name, ...(g.topics || [])]) {
      const s = overlap(q, x);
      if (s > score) (score = s), (best = g);
    }
  }
  return score >= 0.6 ? best : null;
}
