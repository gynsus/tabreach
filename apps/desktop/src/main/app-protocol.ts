import { isAbsolute, join, normalize, relative } from 'node:path';

/**
 * The packaged renderer is served from `app://tabreach/…` rather than `file://`.
 *
 * The `grantFileProtocolExtraPrivileges` fuse is off (docs/18), so a `file://` page cannot load
 * the module script Vite emits (`<script type="module" crossorigin>`): the window stayed blank.
 * A privileged custom scheme is what Electron recommends instead; it serves only the files of
 * the renderer build.
 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'tabreach';
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/**
 * Maps an `app://tabreach/<path>` request to a file inside `root`, or null when the URL is for
 * another host, is malformed, or would leave `root`.
 */
export function resolveAppFile(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  const rel = relative(root, file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return file;
}

/**
 * Whether `url` is a page of our own renderer: the dev server's origin in development, otherwise
 * `app://tabreach`. Compared by scheme and host, not `URL.origin`, which Node reports as "null"
 * for a custom scheme.
 */
export function isAppPageUrl(url: string, devServerOrigin: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (devServerOrigin) return parsed.origin === devServerOrigin;
  return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
}
