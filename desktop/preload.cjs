const electron = require('electron');
const contextBridge = electron.contextBridge;
const ipcRenderer = electron.ipcRenderer;

// The main process injects immutable endpoint metadata through
// additionalArguments (one-way, read-only). The preload also exposes a
// narrow, frozen credential namespace so the renderer can store, check,
// and clear API keys in the macOS Keychain — but never read them back.
//
// Security surface:
//   - No filesystem, process, or generic Node access.
//   - No raw ipcRenderer exposure.
//   - credentials has set / has / clear / revert — deliberately NO get method.
//   - migration has status / retry.
//   - paperLinks has one guarded artwork-opening method.
//   - folders has one method: show the OS folder chooser, return the pick.
//   - person has one method: ask main for this launch's person token. Main
//     answers only its own main frame, and never while a debug port is open.
//   - The root and every namespace are frozen.
function readEndpointArg(argv, prefix) {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return '';
}

const apiBaseUrl = readEndpointArg(process.argv, '--nebula-api-base=');
const wsBaseUrl = readEndpointArg(process.argv, '--nebula-ws-base=');
const rendererUrl = readEndpointArg(process.argv, '--nebula-renderer-url=');

// Sandboxed preloads cannot require local helper modules. Keep this comparison
// aligned with navigation.mjs, and fail closed outside the trusted main frame.
function isTrustedRenderer() {
  if (process.isMainFrame !== true || typeof location === 'undefined') return false;
  try {
    const actual = new URL(location.href);
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

// Providers with plaintext API keys detected in App Support settings.json
// on launch. Empty when all keys are securely stored in the Keychain.
// VAL-UX-005: the renderer shows a warning when this is non-empty.
const plaintextWarningRaw = readEndpointArg(process.argv, '--nebula-plaintext-warning=');
let plaintextKeyWarning;
try {
  plaintextKeyWarning = plaintextWarningRaw ? JSON.parse(plaintextWarningRaw) : [];
  if (!Array.isArray(plaintextKeyWarning)) plaintextKeyWarning = [];
} catch {
  plaintextKeyWarning = [];
}

/**
 * Frozen credential namespace.
 *
 * The renderer can set, check, and clear provider keys, but can never
 * read a plaintext value back. There is no `get` method and no
 * `credentials:get` IPC channel.
 */
const credentials = Object.freeze({
  set: (provider, key) => ipcRenderer.invoke('credentials:set', { provider, key }),
  has: (provider) => ipcRenderer.invoke('credentials:has', provider),
  clear: (provider) => ipcRenderer.invoke('credentials:clear', provider),
  // Undo this launch's last set or clear of one provider (main keeps the
  // earlier encrypted entry; nothing comes back to the renderer).
  revert: (provider) => ipcRenderer.invoke('credentials:revert', provider),
});

/**
 * Frozen migration namespace.
 *
 * The renderer can check migration status and trigger a retry, but
 * cannot directly mutate credential or migration state.
 */
const migration = Object.freeze({
  status: () => ipcRenderer.invoke('credentials:migration-status'),
  retry: () => ipcRenderer.invoke('credentials:retry-migration'),
});

// Only canonical Paper desktop/HTTPS artwork links are accepted by main.
const paperLinks = Object.freeze({
  open: (url) => ipcRenderer.invoke('paper:open-artwork', url),
});
const kreaLinks = Object.freeze({
  open: (url) => ipcRenderer.invoke('krea:open-authorization', url),
});
// Settings' output/export folders. Main shows the chooser; only the picked path comes back.
const folders = Object.freeze({
  choose: (defaultPath) => ipcRenderer.invoke('dialog:choose-folder', defaultPath),
});

// The person token never rides in argv (other processes can read it there).
const person = Object.freeze({
  token: () => ipcRenderer.invoke('person:token'),
});

const metadata = Object.freeze({
  platform: process.platform,
  shell: 'electron',
  apiBaseUrl,
  wsBaseUrl,
  ...(isTrustedRenderer() ? { person } : {}),
  credentials,
  migration,
  paperLinks,
  kreaLinks,
  folders,
  plaintextKeyWarning: Object.freeze([...plaintextKeyWarning]),
});

if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
  contextBridge.exposeInMainWorld('nebulaDesktop', metadata);
}
