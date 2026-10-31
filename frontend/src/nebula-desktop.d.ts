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
 *   - `paperLinks` has one guarded artwork-opening method.
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
  /** Put a provider's Keychain entry back as it was before this launch's
   * last set or clear (the earlier key, or none). Never returns a key.
   * Absent in older shells. */
  readonly revert?: (provider: string) => Promise<CredentialClearResult>;
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

export interface PaperLinkBridge {
  /** Open the exact linked Paper artwork in its registered desktop app or browser. */
  readonly open: (url: string) => Promise<{ readonly ok: boolean; readonly error?: string }>;
}

export interface FolderPickResult {
  readonly ok: boolean;
  /** The folder the person picked, or null when they cancelled. */
  readonly path?: string | null;
  readonly error?: string;
}

/** Shows the OS folder chooser; only the picked path comes back. */
export interface FolderPickerBridge {
  readonly choose: (defaultPath?: string) => Promise<FolderPickResult>;
}

export interface PersonTokenResult {
  readonly ok: boolean;
  readonly token?: string | null;
  /** Why there is no token: a debug port is open, the renderer is the dev
   * server, or the asking frame isn't the app's own page. */
  readonly error?: 'DEBUG_PORT' | 'DEV_RENDERER' | 'UNTRUSTED_SENDER' | string;
}

export interface PersonBridge {
  readonly token: () => Promise<PersonTokenResult>;
}

export interface NebulaDesktopBridge {
  readonly platform: string;
  readonly shell: string;
  readonly apiBaseUrl: string;
  readonly wsBaseUrl: string;
  /**
   * This launch's person token, handed over IPC to the trusted main frame
   * only (frontend/src/lib/personSession.ts). Absent in older shells.
   */
  readonly person?: Readonly<PersonBridge>;
  /** Frozen credential namespace — set / has / clear (NO get). */
  readonly credentials: Readonly<CredentialBridge>;
  /** Frozen migration namespace — status / retry. */
  readonly migration: Readonly<MigrationBridge>;
  /** Frozen canonical Paper artwork-link namespace. Optional for older desktop shells. */
  readonly paperLinks?: Readonly<PaperLinkBridge>;
  /** Open Krea's verified OAuth consent URL in the external browser. */
  readonly kreaLinks?: Readonly<PaperLinkBridge>;
  /** Absent in desktop shells built before Settings had folder pickers. */
  readonly folders?: Readonly<FolderPickerBridge>;
  /**
   * Provider names with plaintext API keys detected in App Support
   * settings.json on launch. Empty when all keys are securely stored
   * in the Keychain. The renderer shows a warning when non-empty.
   * VAL-UX-005
   */
  readonly plaintextKeyWarning: readonly string[];
}

declare global {
  interface Window {
    nebulaDesktop?: Readonly<NebulaDesktopBridge>;
  }
}
