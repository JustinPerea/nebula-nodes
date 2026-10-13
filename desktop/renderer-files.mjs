/**
 * Keep the renderer's file:// reads inside its own bundle.
 *
 * The packaged renderer is frontend/dist-desktop/index.html, a file:// page.
 * Electron gives file:// pages extra privileges (the
 * GrantFileProtocolExtraPrivileges fuse): fetch/XHR of any other file:// URL,
 * so a renderer bug (an XSS in a model output, say) could read the repo-root
 * settings.json or anything else the person can read. Turning the fuse off
 * breaks the renderer instead: Chromium then treats the page's origin as
 * "null" and blocks its own `<script type="module">` and stylesheets
 * (checked live, 2026-10-13). Moving to a custom scheme would change the
 * renderer's origin, which drops its localStorage and changes what the
 * backend's desktop CORS and the IPC sender checks accept.
 *
 * So main.mjs intercepts the `file:` scheme for the app's session and serves
 * only files whose real path is inside the renderer folder. Everything else
 * gets a 404, whoever asked (fetch, <img>, <iframe>, CSS url()).
 */
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The real path of `url` when it names a file inside `rootDir`, else null.
 *
 * Symlinks are resolved on both sides, so a link inside the folder can't
 * point out of it. Missing files are null too (the caller answers 404).
 *
 * @param {string} url — the requested file:// URL
 * @param {string} rootDir — the renderer folder
 * @param {(path: string) => string} [realpath]
 * @returns {string | null}
 */
export function rendererFilePath(url, rootDir, realpath = realpathSync.native) {
  let path;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || (parsed.host && parsed.host !== 'localhost')) return null;
    parsed.search = '';
    parsed.hash = '';
    path = fileURLToPath(parsed);
  } catch {
    return null;
  }
  let root;
  let real;
  try {
    root = realpath(rootDir);
    real = realpath(path);
  } catch {
    return null;
  }
  return real.startsWith(root + sep) ? real : null;
}

/**
 * Serve file:// requests from `rootDir` only (call once, after `ready`).
 *
 * @param {{ handle: Function }} protocol — session.defaultSession.protocol
 * @param {{ fetch: Function }} net — electron's net
 * @param {string} rootDir
 * @param {(line: string) => void} [warn]
 */
export function confineFileScheme(protocol, net, rootDir, warn = console.warn) {
  protocol.handle('file', (request) => {
    const real = rendererFilePath(request.url, rootDir);
    if (!real) {
      warn(`Blocked a renderer read outside its bundle: ${request.url}`);
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    // The built-in file handler, so MIME types match what loadURL would give.
    return net.fetch(pathToFileURL(real).href, { bypassCustomProtocolHandlers: true });
  });
}
