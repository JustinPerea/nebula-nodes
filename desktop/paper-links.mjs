/** Narrow OS-launch boundary for the editable artwork linked by a Paper node. */
export const PAPER_LINK_CHANNEL = 'paper:open-artwork';

/** Accept only the canonical artwork routes derived from three stable IDs. */
export function isPaperArtworkUrl(value) {
  if (typeof value !== 'string') return false;
  if (!/^(?:paper:\/\/file\/|https:\/\/app\.paper\.design\/file\/)[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/u.test(value)) return false;
  try {
    // Compare the original string: parsing alone normalizes traversal and controls.
    return new URL(value).href === value;
  } catch {
    return false;
  }
}

/** Limit IPC to the app's configured renderer and its current main frame. */
export function createPaperLinkSenderValidator(rendererUrl, getRendererContents) {
  const expected = new URL(rendererUrl);
  return (event) => {
    try {
      const contents = getRendererContents();
      if (!contents || event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return false;
      const actual = new URL(event.senderFrame.url);
      if (actual.username || actual.password) return false;
      if (expected.protocol === 'file:') {
        return actual.protocol === 'file:' && actual.host === expected.host && actual.pathname === expected.pathname;
      }
      return (expected.protocol === 'http:' || expected.protocol === 'https:') && actual.origin === expected.origin;
    } catch {
      return false;
    }
  };
}

/** The preload exposes only this operation, never generic shell or IPC access. */
export function registerPaperLinkHandler(ipcMain, shell, validateSender) {
  ipcMain.handle(PAPER_LINK_CHANNEL, async (event, url) => {
    if (!validateSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    if (!isPaperArtworkUrl(url)) return { ok: false, error: 'INVALID_PAPER_ARTWORK_URL' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
