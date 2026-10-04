// Which links inside a rendered message are safe to follow.
//
// dsh-rc is one page, served at / or mounted behind a path (Tailscale Serve at
// /m). A model writes relative file paths in its messages ("see
// research/notes.md"), and in a standalone home-screen app following one
// replaces the window with a URL the server has no page for. The app page is the
// only real destination on this origin, so anything else same-origin is shown to
// the user instead of followed.
//
// Pure functions with no DOM, so the tests import this file directly.

/** The directory the app is served from, normalized with a trailing slash. */
export function appBasePath(base) {
  let pathname;
  try {
    pathname = new URL(base, 'http://localhost/').pathname;
  } catch {
    return '/';
  }
  if (pathname.endsWith('/index.html')) pathname = pathname.slice(0, -'index.html'.length);
  return pathname.endsWith('/') ? pathname : pathname + '/';
}

/**
 * Where a link points, relative to the page it was rendered on.
 *   page     - the app page itself (with or without a hash route): follow it
 *   external - another origin or a non-http scheme: follow it
 *   path     - same origin but not a page of this app: show it, do not navigate
 *   ignore   - nothing usable to navigate to
 */
export function classifyLink(href, base) {
  const raw = String(href == null ? '' : href).trim();
  if (!raw) return { action: 'ignore' };
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    return { action: 'ignore' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { action: 'external' };
  let here;
  try {
    here = new URL(base);
  } catch {
    return { action: 'external' };
  }
  if (url.origin !== here.origin) return { action: 'external' };
  const root = appBasePath(base);
  const bare = root === '/' ? '' : root.replace(/\/$/, '');
  const target = url.pathname.endsWith('/index.html') ? url.pathname.slice(0, -'index.html'.length) : url.pathname;
  if (target === root || target === bare) return { action: 'page' };
  return { action: 'path' };
}

// app.js is a classic script and cannot import this module, so hand it the
// functions. Absent in Node, where the tests import the file directly.
if (typeof window !== 'undefined') {
  window.dshLinks = { appBasePath, classifyLink };
}
