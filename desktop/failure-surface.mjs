/**
 * The startup failure page, and the helpers main.mjs's other inline pages use.
 *
 * The failure page usually replaces the 480x320 loading window, so main.mjs
 * grows that window to FAILURE_WINDOW_SIZE first. At 480x320 the message box
 * (then capped at half the window's height) cut off the last lines, and the
 * last line is the fix: the frontend-build.mjs messages end with the rebuild
 * command. The box can also be scrolled and its text selected, so a long
 * message (sidecar stderr) can be read and the command copied; the rest of
 * the page still drags the window.
 *
 * Electron-free, so tests run under Node.
 */

/** The failure window's size, new or grown from the loading window. */
export const FAILURE_WINDOW_SIZE = Object.freeze({ width: 600, height: 400 });

export function htmlDataUrl(html) {
  return 'data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64');
}

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The failure page for an error that stopped startup, as a data: URL.
 * `error.heading` (FrontendBuildError) replaces the default heading.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function failureSurfaceHtml(error) {
  const message = error instanceof Error ? error.message : String(error);
  return htmlDataUrl(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nebula Nodes — Startup Error</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0608;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;user-select:none;-webkit-app-region:drag}
.container{max-width:560px;padding:40px}
h1{font-size:18px;color:#ff6b6b;margin-bottom:16px;font-weight:600}
pre{font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;color:#ccc;background:#160a10;padding:16px;border-radius:8px;overflow:auto;max-height:calc(100vh - 140px);user-select:text;-webkit-app-region:no-drag}
</style></head>
<body><div class="container">
<h1>${escapeHtml(error?.heading ?? 'Backend startup failed')}</h1>
<pre>${escapeHtml(message)}</pre>
</div></body></html>`);
}
