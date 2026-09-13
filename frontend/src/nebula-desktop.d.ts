/**
 * Immutable Electron preload bridge.
 *
 * Exposed by `desktop/preload.cjs` via `contextBridge.exposeInMainWorld`.
 * Present only when the renderer is loaded inside the Electron shell;
 * absent in browser/Vite mode. The root object and every nested namespace
 * are frozen (`Object.isFrozen`) and cannot be mutated, reconfigured, or
 * extended from the renderer.
 *
 * Security surface:
 *   - No filesystem, process, or generic Node access.
 *   - No raw `ipcRenderer` exposure.
 *   - `credentials` has `set` / `has` / `clear` — deliberately NO `get`
 *     method (renderer never sees plaintext API keys).
 *   - `migration` has `status` / `retry`.
 */

/** Result of a credential `set` operation. */
export interface CredentialSetResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Result of a credential `has` operation. */
export interface CredentialHasResult {
  readonly ok: boolean;
  readonly has?: boolean;
  readonly error?: string;
}

/** Result of a credential `clear` operation. */
export interface CredentialClearResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Result of a migration `status` operation. */
export type MigrationStatus = 'pending' | 'in-progress' | 'complete' | 'failed';

export interface MigrationStatusResult {
  readonly ok: boolean;
  readonly status?: MigrationStatus;
  readonly error?: string;
}

/** Result of a migration `retry` operation. */
export interface MigrationRetryResult {
  readonly ok: boolean;
  readonly status?: MigrationStatus;
  readonly error?: string;
}

/**
 * Frozen credential namespace.
 *
 * The renderer can store, check, and clear provider keys in the macOS
 * Keychain, but can never read a plaintext value back.
 */
export interface CredentialBridge {
  /** Encrypt and persist a provider API key to the Keychain. */
  readonly set: (provider: string, key: string) => Promise<CredentialSetResult>;
  /** Check whether a provider key is configured (never returns the key). */
  readonly has: (provider: string) => Promise<CredentialHasResult>;
  /** Remove a provider key from the Keychain. */
  readonly clear: (provider: string) => Promise<CredentialClearResult>;
}

/**
 * Frozen migration namespace.
 *
 * The renderer can observe migration status and trigger a retry, but
 * cannot directly mutate credential or migration state.
 */
export interface MigrationBridge {
  /** Get the current migration status. */
  readonly status: () => Promise<MigrationStatusResult>;
  /** Trigger a migration retry after a failure. */
  readonly retry: () => Promise<MigrationRetryResult>;
}

export interface NebulaDesktopBridge {
  readonly platform: string;
  readonly shell: string;
  readonly apiBaseUrl: string;
  readonly wsBaseUrl: string;
  /** Frozen credential namespace — set / has / clear (NO get). */
  readonly credentials: Readonly<CredentialBridge>;
  /** Frozen migration namespace — status / retry. */
  readonly migration: Readonly<MigrationBridge>;
}

declare global {
  interface Window {
    nebulaDesktop?: Readonly<NebulaDesktopBridge>;
  }
}
