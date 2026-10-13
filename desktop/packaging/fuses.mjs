/**
 * Electron fuses for Nebula.app (flipped by scripts/package.mjs after
 * packaging, before the ad-hoc codesign).
 *
 * Fuses are bits compiled into the Electron Framework binary, so nothing in
 * the environment or on the command line can turn them back on. Stock
 * Electron ships with RunAsNode, NODE_OPTIONS, the --inspect arguments and
 * extra file:// privileges on; any of them would let a local process run
 * code as Nebula.app (and so reach its "nebula-desktop Safe Storage"
 * keychain item once "Always Allow" was granted). The file:// privilege fuse
 * has to stay on; see GrantFileProtocolExtraPrivileges below.
 *
 * Fuses harden the binary, not the code it loads: Nebula.app imports
 * desktop/main.mjs and friends from the writable checkout at every launch,
 * so whoever can change the checkout can still run code with the keychain
 * item (desktop/README.md, "What the keychain prompt does and doesn't
 * protect").
 *
 * Every fuse is listed (strictlyRequireAllFuses), so an Electron upgrade that
 * adds one fails the package step until someone decides its value.
 *
 * `npm run start` runs the stock electron binary from node_modules and keeps
 * the stock fuses; only the packaged app is hardened.
 */
import { FuseV1Options, FuseVersion } from '@electron/fuses';

export const NEBULA_FUSES = Object.freeze({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  // package.mjs re-signs the whole bundle ad hoc right after.
  resetAdHocDarwinSignature: false,
  // ELECTRON_RUN_AS_NODE=1 would turn the app binary into plain Node.
  [FuseV1Options.RunAsNode]: false,
  // Cookies on disk encrypted with the Safe Storage key. Nebula sets none
  // today; this only matters if that changes.
  [FuseV1Options.EnableCookieEncryption]: true,
  // NODE_OPTIONS could --require arbitrary code into the main process.
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  // --inspect / --inspect-brk / --inspect-port open the Node inspector.
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // The app is a plain folder (asar: false) that runs the checkout's
  // desktop/main.mjs, so there is no asar to validate or require. Turning
  // these on would not by itself protect the keys: main.mjs hands them to the
  // checkout's backend and venv, which an asar can't cover (desktop/README.md,
  // "What the keychain prompt does and doesn't protect").
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: false,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // Stays on: the renderer is a file:// page, and without these privileges
  // Chromium gives it the opaque origin "null" and blocks its own module
  // scripts and stylesheets (checked live 2026-10-13). What the privilege
  // would allow, reading other file:// URLs, is blocked instead by
  // renderer-files.mjs, which serves file:// only from the renderer folder.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  // Electron's default; WebAssembly bounds checks via signal handlers.
  [FuseV1Options.WasmTrapHandlers]: true,
});

/** The fuse values `config` asks for, keyed by option index, as booleans. */
export function wantedFuseBits(config = NEBULA_FUSES) {
  const wanted = {};
  for (const [key, value] of Object.entries(config)) {
    if (/^\d+$/.test(key)) wanted[Number(key)] = value === true;
  }
  return wanted;
}
