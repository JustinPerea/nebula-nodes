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
//   - credentials has set / has / clear — deliberately NO get method.
//   - migration has status / retry.
//   - paperLinks has one guarded artwork-opening method.
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
const connectorSession = readEndpointArg(process.argv, '--nebula-connector-session=');
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

const metadata = Object.freeze({
  platform: process.platform,
  shell: 'electron',
  apiBaseUrl,
  wsBaseUrl,
  ...(isTrustedRenderer() ? { connectorSession } : {}),
  credentials,
  migration,
  paperLinks,
  kreaLinks,
  plaintextKeyWarning: Object.freeze([...plaintextKeyWarning]),
});

if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
  contextBridge.exposeInMainWorld('nebulaDesktop', metadata);
}
