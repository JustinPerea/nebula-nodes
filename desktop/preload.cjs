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
//   - All three objects (nebulaDesktop, credentials, migration) are frozen.
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

const metadata = Object.freeze({
  platform: process.platform,
  shell: 'electron',
  apiBaseUrl,
  wsBaseUrl,
  credentials,
  migration,
});

if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
  contextBridge.exposeInMainWorld('nebulaDesktop', metadata);
}
