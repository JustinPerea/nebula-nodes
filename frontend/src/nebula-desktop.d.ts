/**
 * Immutable Electron preload bridge metadata.
 *
 * Exposed by `desktop/preload.cjs` via `contextBridge.exposeInMainWorld`.
 * Present only when the renderer is loaded inside the Electron shell;
 * absent in browser/Vite mode. All four fields are frozen strings — the
 * object is `Object.isFrozen` and cannot be mutated, reconfigured, or
 * extended from the renderer. No process, filesystem, credential, or
 * generic IPC surface is exposed.
 */
export interface NebulaDesktopBridge {
  readonly platform: string;
  readonly shell: string;
  readonly apiBaseUrl: string;
  readonly wsBaseUrl: string;
}

declare global {
  interface Window {
    nebulaDesktop?: Readonly<NebulaDesktopBridge>;
  }
}
