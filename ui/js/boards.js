/**
 * Image boards that Board Roamer shows better: the address of a post, a search or a pool on a site it supports.
 * (Mirrors what Board Roamer accepts for a handed-over link; it does the real work of picking the page apart.)
 */
export function wants(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, ''), path = u.pathname.replace(/\/+$/, ''), q = u.searchParams;
  if (host === 'e621.net' || host === 'e926.net') return /^\/posts\/\d+$/.test(path) || /^\/post\/show\/\d+/.test(path) || /^\/pools\/\d+$/.test(path) || path === '/posts' || path === '/post';
  if (host === 'donmai.us' || host.endsWith('.donmai.us')) return /^\/posts\/\d+$/.test(path) || path === '/posts';
  if (host === 'gelbooru.com' || host === 'safebooru.org') return path === '/index.php' && q.get('page') === 'post' && (q.get('s') === 'list' || (q.get('s') === 'view' && /^\d+$/.test(q.get('id') || '')));
  if (host === 'derpibooru.org') return /^\/images\/\d+$/.test(path) || /^\/\d+$/.test(path) || path === '/search' || path === '/search/index';
  return false;
}

export const boardName = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/^danbooru\./, '');
  } catch {
    return 'this site';
  }
};
