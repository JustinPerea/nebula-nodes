const { contextBridge } = require('electron');

// The main process injects immutable endpoint metadata through
// additionalArguments (one-way, read-only). This keeps the surface narrow:
// no filesystem, process, credential, arbitrary IPC, or generic Node access
// is exposed to the renderer. Only four frozen string fields leave the
// sandboxed preload context.
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

const metadata = Object.freeze({
  platform: process.platform,
  shell: 'electron',
  apiBaseUrl,
  wsBaseUrl,
});

contextBridge.exposeInMainWorld('nebulaDesktop', metadata);
