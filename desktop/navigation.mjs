/** Keep the privileged renderer on its configured document, allowing hash routes. */
export function isTrustedRendererUrl(value, rendererUrl) {
  try {
    const actual = new URL(value);
    const expected = new URL(rendererUrl);
    if (!['file:', 'http:', 'https:'].includes(expected.protocol)
      || actual.username || actual.password || expected.username || expected.password) return false;
    actual.hash = '';
    expected.hash = '';
    return actual.href === expected.href;
  } catch {
    return false;
  }
}

/** External browser links cannot invoke a custom protocol or embed credentials. */
export function externalBrowserUrl(value) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Install before loadURL; links leave through the OS browser, never a privileged child. */
export function installRendererNavigationGuard(contents, rendererUrl, shell) {
  const guard = (event, legacyUrl, _isInPlace, legacyIsMainFrame) => {
    // Electron 44 exposes navigation details on the event. The positional
    // arguments remain supported for older versions and existing test harnesses.
    if (event.isMainFrame === false || legacyIsMainFrame === false) return;
    const url = typeof event.url === 'string' ? event.url : legacyUrl;
    if (!isTrustedRendererUrl(url, rendererUrl)) event.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.setWindowOpenHandler(({ url }) => {
    const target = externalBrowserUrl(url);
    if (target && !isTrustedRendererUrl(target, rendererUrl)) {
      // A failed external launch must not fall back to a BrowserWindow.
      Promise.resolve().then(() => shell.openExternal(target)).catch(() => {});
    }
    return { action: 'deny' };
  });
}
