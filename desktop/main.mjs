import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  startSidecar, stopSidecar, SidecarError, DEFAULT_REPO_ROOT, SIDECAR_STRIPPED_ENV_KEYS,
} from './sidecar.mjs';
import { prepareAppDataEnv, resolveDesktopDataPaths } from './paths.mjs';
import { createPaperLinkSenderValidator, registerPaperLinkHandler } from './paper-links.mjs';
import { DEBUG_SWITCHES, debugSwitchesInUse, decidePersonToken, registerPersonTokenHandler } from './person-token.mjs';
import { registerFolderPickerHandler } from './folder-picker.mjs';
import { getConnectorEncryptionKey, registerKreaAuthLinkHandler } from './connector-vault.mjs';
import { installRendererNavigationGuard } from './navigation.mjs';
import { confineFileScheme } from './renderer-files.mjs';
import { resolveLaunchOverrides } from './launch-overrides.mjs';
import { decideWindowAction } from './window-recovery.mjs';
import { packagedLaunch, treatAsPackaged } from './packaged-launch.mjs';
import { FrontendBuildError, checkParamsVersions, readBuildParamsVersion } from './frontend-build.mjs';
import {
  CREDENTIALS_FILE_NAME,
  MIGRATION_STATE_FILE_NAME,
  createCredentialService,
  createSenderValidator,
  registerCredentialHandlers,
} from './credentials.mjs';
import {
  isMigrationNeeded,
  runMigration,
  detectPlaintextKeysInFile,
} from './migration.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Dev and test overrides (launch-overrides.mjs). A packaged build ignores
 * all of them, so its profile, keychain and renderer can't be redirected
 * from the environment.
 */
const packaged = packagedLaunch();
// The default name (package.json `name`, before any test app id) names the
// profile dir, the single-instance lock and the safeStorage keychain item.
console.log(`Nebula desktop: app name=${app.getName()} packaged=${app.isPackaged}${packaged?.validation ? ' (validation build)' : ''}`);
const overrides = resolveLaunchOverrides({
  env: process.env,
  isPackaged: treatAsPackaged(app.isPackaged, packaged),
});
if (packaged?.validation) {
  console.warn('Nebula.app validation build: dev/test overrides are honoured. Not for everyday use.');
}
if (overrides.ignored.length > 0) {
  console.warn(`Ignoring dev/test-only settings in a packaged build: ${overrides.ignored.join(', ')}`);
}

/**
 * Debug switches this launch was started with, before main.mjs adds its own.
 * Chromium honours `--remote-debugging-port` and friends from argv even in a
 * packaged build (`open -a Nebula --args --remote-debugging-port=9222`),
 * which launch-overrides.mjs never sees. Any of them means no person token;
 * a normal Nebula.app refuses to start at all (see the lifecycle below).
 */
const launchDebugSwitches = debugSwitchesInUse({
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
  argv: process.argv,
  execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS,
});
const refuseDebugLaunch = launchDebugSwitches.length > 0 && treatAsPackaged(app.isPackaged, packaged);
if (launchDebugSwitches.length > 0) {
  console.warn(`Debug switches on the command line: ${launchDebugSwitches.join(', ')}; no person token this launch`);
}
if (refuseDebugLaunch) {
  // Best effort: drop them before Chromium starts its DevTools server.
  for (const name of DEBUG_SWITCHES) app.commandLine.removeSwitch(name);
}

/** Loopback CDP port for agent-browser validation. */
const debugPort = overrides.debugPort;
if (debugPort) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

/**
 * Test-only isolated application identity for concurrent validators.
 *
 * When set, `app.setName()` is called before the single-instance lock so
 * each isolated identity gets its own lock. This allows multiple Electron
 * validators to run simultaneously without interfering with each other or
 * with normal user launches (which retain the default app name and lock).
 *
 * Must be paired with `NEBULA_DESKTOP_USER_DATA_DIR` for full isolation.
 */
const appId = overrides.appId;
if (appId) {
  app.setName(appId);
}

/** Test-only isolated user-data directory for concurrent validators. */
const userDataDir = overrides.userDataDir;
if (userDataDir) {
  app.setPath('userData', userDataDir);
}
if (overrides.mockKeychain) {
  // NEBULA_DESKTOP_TEST=1: a throwaway test profile must not read or write
  // the person's login keychain (safeStorage names its key "<app name> Safe
  // Storage", so every validator run with a fresh app id left an item
  // behind). The mock keychain's key is a public constant, so anything saved
  // in this profile is effectively unencrypted. Never use it for real keys.
  app.commandLine.appendSwitch('use-mock-keychain');
  console.warn('NEBULA_DESKTOP_TEST=1: mock keychain in use; keys saved in this profile are not protected');
}

/** App data root and migration sources; all inside userDataDir when isolated. */
const dataPaths = resolveDesktopDataPaths({
  userDataDir,
  home: homedir(),
  repoRoot: DEFAULT_REPO_ROOT,
});

const isDevelopment = Boolean(overrides.devServerUrl);
const isSmokeTest = overrides.smoke;
const rendererUrl = isDevelopment
  ? overrides.devServerUrl
  : new URL('../frontend/dist-desktop/index.html', import.meta.url).toString();
const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import('./sidecar.mjs').SidecarHandle | null} */
let sidecarHandle = null;
/** This launch's person token (person-token.mjs). None with a debug port open. */
const person = decidePersonToken({
  debugPort,
  debugSwitches: launchDebugSwitches,
  isDevelopment,
  devOptIn: overrides.devPersonOptIn,
});
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let loadingWindow = null;
let isCleaningUp = false;
let quitRequestedDuringStartup = false;
let sidecarStarting = false;
/** The error that stopped startup, kept so a Dock click or second launch can show it again. @type {Error | null} */
let startupError = null;
let sidecarDisconnected = false;
let plaintextProviders = [];

// ---------------------------------------------------------------------------
// Startup and failure surfaces
// ---------------------------------------------------------------------------

function htmlDataUrl(html) {
  return 'data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LOADING_HTML = htmlDataUrl(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nebula Nodes</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#060607;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;user-select:none;-webkit-app-region:drag}
.container{text-align:center}
.spinner{width:28px;height:28px;border:2px solid #222;border-top-color:#5b8def;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 18px}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:22px;font-weight:600;margin-bottom:10px;color:#fff}
p{font-size:14px;color:#777}
</style></head>
<body><div class="container">
<div class="spinner"></div>
<h1>Nebula Nodes</h1>
<p>Starting backend\u2026</p>
</div></body></html>`);

function failureSurfaceHtml(error) {
  const message = error instanceof SidecarError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
  return htmlDataUrl(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nebula Nodes \u2014 Startup Error</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0608;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;user-select:none;-webkit-app-region:drag}
.container{max-width:560px;padding:40px}
h1{font-size:18px;color:#ff6b6b;margin-bottom:16px;font-weight:600}
pre{font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;color:#ccc;background:#160a10;padding:16px;border-radius:8px;overflow:auto;max-height:50vh}
</style></head>
<body><div class="container">
<h1>${escapeHtml(error?.heading ?? 'Backend startup failed')}</h1>
<pre>${escapeHtml(message)}</pre>
</div></body></html>`);
}

/**
 * Mid-session disconnected surface — shown when the sidecar exits after
 * the renderer has loaded. The renderer is NOT replaced (the injected
 * endpoint metadata stays in place so reconnect attempts target the dead
 * origin, never rediscovering another backend). A full-screen overlay
 * is injected on top of the existing page.
 */
const DISCONNECTED_OVERLAY_JS = `
(function() {
  if (document.getElementById('nebula-disconnected-overlay')) return;
  var overlay = document.createElement('div');
  overlay.id = 'nebula-disconnected-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(13,6,8,0.96);display:flex;align-items:center;justify-content:center;font-family:-apple-system,system-ui,sans-serif;user-select:none;-webkit-app-region:drag';
  var box = document.createElement('div');
  box.style.cssText = 'text-align:center;max-width:480px;padding:40px';
  var h1 = document.createElement('h1');
  h1.textContent = 'Backend disconnected';
  h1.style.cssText = 'font-size:18px;color:#ff6b6b;margin-bottom:16px;font-weight:600';
  var p = document.createElement('p');
  p.textContent = 'The Nebula backend has stopped unexpectedly. Please restart the application to reconnect.';
  p.style.cssText = 'font-size:14px;color:#ccc;line-height:1.5';
  box.appendChild(h1);
  box.appendChild(p);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
})();
`;

/** Static disconnected page for window recreation after sidecar death. */
const DISCONNECTED_HTML = htmlDataUrl(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nebula Nodes \u2014 Disconnected</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0608;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;user-select:none;-webkit-app-region:drag}
.container{max-width:480px;padding:40px;text-align:center}
h1{font-size:18px;color:#ff6b6b;margin-bottom:16px;font-weight:600}
p{font-size:14px;color:#ccc;line-height:1.5}
</style></head>
<body><div class="container">
<h1>Backend disconnected</h1>
<p>The Nebula backend has stopped unexpectedly. Please restart the application to reconnect.</p>
</div></body></html>`);

// ---------------------------------------------------------------------------
// Migration status overlay — VAL-MIG-010, VAL-UX-001, VAL-UX-004
// ---------------------------------------------------------------------------

function migrationLoadingHtml(step) {
  const label = step ? `Migrating\u2026 ${step}` : 'Migrating\u2026';
  return htmlDataUrl(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nebula Nodes \u2014 Migration</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#060607;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;user-select:none;-webkit-app-region:drag}
.container{text-align:center}
.spinner{width:28px;height:28px;border:2px solid #222;border-top-color:#5b8def;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 18px}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:22px;font-weight:600;margin-bottom:10px;color:#fff}
p{font-size:14px;color:#777}
</style></head>
<body><div class="container">
<div class="spinner"></div>
<h1>Nebula Nodes</h1>
<p>${escapeHtml(label)}</p>
</div></body></html>`);
}

function migrationCompleteHtml() {
  return htmlDataUrl(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nebula Nodes \u2014 Migration Complete</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#060607;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;user-select:none;-webkit-app-region:drag;opacity:0;animation:fadeIn .3s forwards}
@keyframes fadeIn{to{opacity:1}}
.container{text-align:center}
.check{width:40px;height:40px;border-radius:50%;background:#1a3a2a;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:22px;color:#4ade80}
h1{font-size:22px;font-weight:600;margin-bottom:10px;color:#fff}
p{font-size:14px;color:#777}
</style></head>
<body><div class="container">
<div class="check">\u2713</div>
<h1>Migration Complete</h1>
<p>Starting Nebula Nodes\u2026</p>
</div></body></html>`);
}

function migrationFailedHtml(errorMessage) {
  return htmlDataUrl(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nebula Nodes \u2014 Migration Failed</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0608;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;user-select:none}
.container{max-width:560px;padding:40px;text-align:center}
h1{font-size:18px;color:#ff6b6b;margin-bottom:16px;font-weight:600}
pre{font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;color:#ccc;background:#160a10;padding:16px;border-radius:8px;overflow:auto;max-height:30vh;margin-bottom:24px;text-align:left}
button{background:#5b8def;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;-webkit-app-region:no-drag}
button:hover{background:#4a7fdf}
</style></head>
<body><div class="container">
<h1>Migration Failed</h1>
<pre>${escapeHtml(errorMessage)}</pre>
<button onclick="window.location='nebula-retry:'">Retry Migration</button>
</div></body></html>`);
}

/**
 * Load a URL in a BrowserWindow and wait for did-finish-load.
 *
 * Ensures the page has committed and painted before proceeding. This is
 * critical for the migration overlay: if runMigration starts before the
 * loading overlay finishes loading, the overlay window appears blank
 * during the in-progress phase (VAL-UX-001, VAL-MIG-010).
 *
 * @param {BrowserWindow} win
 * @param {string} url
 * @returns {Promise<void>}
 */
function loadURLAndWait(win, url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onLoad = () => {
      if (settled) return;
      settled = true;
      win.webContents.removeListener('did-fail-load', onFail);
      resolve();
    };
    const onFail = (_event, errorCode, errorDescription) => {
      if (settled) return;
      settled = true;
      win.webContents.removeListener('did-finish-load', onLoad);
      reject(new Error(`Window load failed (${errorCode}): ${errorDescription}`));
    };
    win.webContents.once('did-finish-load', onLoad);
    win.webContents.once('did-fail-load', onFail);
    win.loadURL(url);
  });
}

/**
 * Run migration with status overlay and retry-on-failure.
 *
 * Shows the loading overlay during migration, a brief complete overlay
 * on success, or a failed overlay with retry button on failure. The
 * retry button navigates to `nebula-retry:` which is intercepted by
 * the will-navigate handler to re-run the migration.
 *
 * The loading overlay URL is loaded and awaited (did-finish-load) before
 * runMigration starts, so the overlay paints during the in-progress phase
 * even when migration involves large file copies (VAL-UX-001, VAL-MIG-010).
 *
 * @param {BrowserWindow} win — the overlay window
 * @param {object} migrationOptions — options for runMigration
 * @param {object} credentialService — for migration status tracking
 * @returns {Promise<void>}
 * @throws on unrecoverable failure (user dismissed or exhausted retries)
 */
async function runMigrationWithOverlay(win, migrationOptions, credentialService) {
  for (;;) {
    credentialService.setMigrationStatus('in-progress');

    // Load the migration loading overlay and await did-finish-load BEFORE
    // starting runMigration. This ensures the overlay commits and paints
    // during the in-progress phase. Without this, the data: URL navigation
    // cannot complete while synchronous I/O blocks the event loop
    // (VAL-UX-001, VAL-MIG-010).
    await loadURLAndWait(win, migrationLoadingHtml());

    try {
      await runMigration(migrationOptions);
      // Show complete briefly before proceeding
      await loadURLAndWait(win, migrationCompleteHtml());
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('Migration failed:', errorMsg);
      credentialService.setMigrationStatus('failed', { error: errorMsg });

      // Show failure overlay with retry button
      await loadURLAndWait(win, migrationFailedHtml(errorMsg));

      // Wait for the user to click retry or close the window.
      // The retry button navigates to `nebula-retry:` which we
      // intercept via will-navigate.
      const shouldRetry = await new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
          if (settled) return;
          settled = true;
          win.webContents.removeListener('will-navigate', navHandler);
          win.removeListener('closed', closeHandler);
          resolve(val);
        };
        const navHandler = (event, url) => {
          if (url.startsWith('nebula-retry:')) {
            event.preventDefault();
            finish(true);
          }
        };
        const closeHandler = () => finish(false);
        win.webContents.on('will-navigate', navHandler);
        win.once('closed', closeHandler);
      });

      if (!shouldRetry) {
        throw err;
      }
      // Loop back to retry
    }
  }
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createLoadingWindow() {
  const win = new BrowserWindow({
    show: !isSmokeTest,
    width: 480,
    height: 320,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#060607',
    titleBarStyle: 'hiddenInset',
    title: 'Nebula Nodes',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(LOADING_HTML);
  return win;
}

/**
 * Create the main renderer window with immutable endpoint metadata injected
 * through additionalArguments to the sandboxed preload bridge.
 *
 * @param {import('./sidecar.mjs').SidecarHandle} handle
 * @param {string[]} [plaintextKeyWarning] — providers with plaintext keys detected in settings
 * @returns {BrowserWindow}
 */
function createMainWindow(handle, plaintextKeyWarning = []) {
  const win = new BrowserWindow({
    show: !isSmokeTest,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#060607',
    titleBarStyle: 'hiddenInset',
    title: 'Nebula Nodes',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
      additionalArguments: [
        `--nebula-api-base=${handle.apiBaseUrl}`,
        `--nebula-ws-base=${handle.wsBaseUrl}`,
        `--nebula-plaintext-warning=${JSON.stringify(plaintextKeyWarning)}`,
        `--nebula-renderer-url=${rendererUrl}`,
      ],
    },
  });

  installRendererNavigationGuard(win.webContents, rendererUrl, shell);

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.loadURL(rendererUrl);

  if (isDevelopment) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

/**
 * Show or replace the failure surface with the given error.
 * @param {Error} error
 */
function showFailure(error) {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.loadURL(failureSurfaceHtml(error));
    if (!isSmokeTest) loadingWindow.show();
  } else {
    loadingWindow = new BrowserWindow({
      show: !isSmokeTest,
      width: 600,
      height: 400,
      resizable: false,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: '#0d0608',
      titleBarStyle: 'hiddenInset',
      title: 'Nebula Nodes \u2014 Startup Error',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    loadingWindow.loadURL(failureSurfaceHtml(error));
  }
}

/** Disconnected page shown when the sidecar died mid-session (no auto-restart). */
function createDisconnectedWindow() {
  const win = new BrowserWindow({
    show: !isSmokeTest,
    width: 600,
    height: 400,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0d0608',
    titleBarStyle: 'hiddenInset',
    title: 'Nebula Nodes \u2014 Disconnected',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(DISCONNECTED_HTML);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

/**
 * Dock click (`activate`) or a second launch (`second-instance`): focus the
 * live window, or recreate it when every window was closed.
 *
 * @param {{ focusExisting: boolean }} options
 */
function showAppWindow({ focusExisting }) {
  const existing = [mainWindow, loadingWindow].find((win) => win && !win.isDestroyed()) ?? null;
  const action = decideWindowAction({
    hasLiveWindow: Boolean(existing),
    openWindowCount: BrowserWindow.getAllWindows().length,
    focusExisting,
    isCleaningUp,
    hasSidecar: Boolean(sidecarHandle),
    sidecarDisconnected,
    startupFailed: Boolean(startupError) && !sidecarStarting,
  });
  if (action === 'focus') {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  } else if (action === 'create-main') {
    mainWindow = createMainWindow(sidecarHandle, plaintextProviders);
  } else if (action === 'create-disconnected') {
    mainWindow = createDisconnectedWindow();
  } else if (action === 'create-failure') {
    showFailure(startupError);
  }
  // focus() also shows a window, so never on the hidden smoke-run windows.
  const created = action === 'create-failure' ? loadingWindow : mainWindow;
  if (action.startsWith('create-') && !isSmokeTest) created.focus();
  if (action !== 'none') console.log(`Window request (${focusExisting ? 'second launch' : 'activate'}): ${action}`);
}

/**
 * Show the mid-session disconnected overlay in the main renderer window.
 * The renderer page is NOT replaced — the injected endpoint metadata
 * remains so reconnect attempts target the dead origin, never rediscovering
 * another backend. No auto-restart occurs.
 */
function showDisconnectedState() {
  sidecarDisconnected = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(DISCONNECTED_OVERLAY_JS).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Smoke test — proves dynamic endpoint injection (VAL-CROSS-005)
// ---------------------------------------------------------------------------

/**
 * Run the smoke test: verify the renderer loaded with injected endpoints,
 * health responds on the dynamic port, and WebSocket handshakes.
 * Exits the app with code 0 on success, 1 on failure.
 *
 * @param {import('./sidecar.mjs').SidecarHandle} handle
 */
function runSmokeTest(handle) {
  const smokeTimeout = setTimeout(() => {
    console.error('NEBULA_DESKTOP_SMOKE timed out while loading the renderer');
    stopSidecar(handle).catch(() => {}).finally(() => {
      sidecarHandle = null;
      app.exit(1);
    });
  }, 120_000);

  mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
    clearTimeout(smokeTimeout);
    console.error(`NEBULA_DESKTOP_SMOKE renderer load failed: ${code} ${description}`);
    stopSidecar(handle).catch(() => {}).finally(() => {
      sidecarHandle = null;
      app.exit(1);
    });
  });

  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      const result = await mainWindow.webContents.executeJavaScript(`
        Promise.all([
          fetch(window.nebulaDesktop.apiBaseUrl + '/api/health', { cache: 'no-store' })
            .then(async (response) => ({ ok: response.ok, body: await response.json() }))
            .catch((err) => ({ ok: false, error: String(err) })),
          new Promise((resolve) => {
            const socket = new WebSocket(window.nebulaDesktop.wsBaseUrl + '/ws');
            const timeout = window.setTimeout(() => {
              socket.close();
              resolve({ connected: false, reason: 'timeout' });
            }, 5000);
            socket.onopen = () => {
              window.clearTimeout(timeout);
              socket.close();
              resolve({ connected: true });
            };
            socket.onerror = () => {
              window.clearTimeout(timeout);
              resolve({ connected: false, reason: 'error' });
            };
          }),
          // React mounts after the load event; wait for it, bounded, rather
          // than sampling #root once at did-finish-load.
          new Promise((resolve) => {
            const deadline = Date.now() + 15000;
            const check = () => {
              if (document.querySelector('#root')?.children.length || Date.now() > deadline) resolve();
              else window.setTimeout(check, 50);
            };
            check();
          }),
          // A person-gated Settings save, the way the Settings panel does it:
          // token over IPC, then PUT /api/settings with X-Nebula-Person. Only
          // in an isolated profile, so a smoke run never writes real settings.
          (async () => {
            if (!${JSON.stringify(dataPaths.isolated)}) return { skipped: 'not an isolated profile' };
            const api = window.nebulaDesktop.apiBaseUrl;
            const got = window.nebulaDesktop.person ? await window.nebulaDesktop.person.token() : null;
            if (!got || !got.ok) return { skipped: 'no person token (' + (got && got.error) + ')' };
            const before = await (await fetch(api + '/api/settings', { cache: 'no-store' })).json();
            const wanted = !before.zoomTelemetryEnabled;
            const put = await fetch(api + '/api/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'X-Nebula-Person': got.token },
              body: JSON.stringify({ zoomTelemetryEnabled: wanted }),
            });
            const unverified = await fetch(api + '/api/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ zoomTelemetryEnabled: !wanted }),
            });
            const after = await (await fetch(api + '/api/settings', { cache: 'no-store' })).json();
            return {
              ok: put.status === 200 && unverified.status === 403 && after.zoomTelemetryEnabled === wanted,
              putStatus: put.status,
              unverifiedStatus: unverified.status,
              saved: after.zoomTelemetryEnabled === wanted,
            };
          })().catch((err) => ({ ok: false, error: String(err) })),
          // The other person paths from the packaged file: page (the desktop
          // pass, docs/MCP-SETUP.md "Who counts as the person"): the spend
          // read, the /ws hello, and the Krea connector's status and
          // person-only routes. None of these reaches Krea: with no saved
          // connection, check stops before any request and disconnect only
          // clears the empty local vault. Isolated profiles only.
          (async () => {
            if (!${JSON.stringify(dataPaths.isolated)}) return { skipped: 'not an isolated profile' };
            const api = window.nebulaDesktop.apiBaseUrl;
            const got = window.nebulaDesktop.person ? await window.nebulaDesktop.person.token() : null;
            if (!got || !got.ok) return { skipped: 'no person token (' + (got && got.error) + ')' };
            const call = async (path, init, withToken) => {
              const headers = withToken ? { 'X-Nebula-Person': got.token } : {};
              try {
                const response = await fetch(api + path, { cache: 'no-store', ...init, headers });
                let body = null;
                try { body = await response.json(); } catch { /* not JSON */ }
                return { status: response.status, body };
              } catch (err) {
                return { status: 0, error: String(err) };
              }
            };
            const hello = (token) => new Promise((resolve) => {
              const socket = new WebSocket(window.nebulaDesktop.wsBaseUrl + '/ws');
              const done = (value) => { window.clearTimeout(timer); socket.close(); resolve(value); };
              const timer = window.setTimeout(() => done('timeout'), 5000);
              socket.onmessage = (event) => {
                let frame = null;
                try { frame = JSON.parse(event.data); } catch { return; }
                if (frame.type === 'graphSync') socket.send(JSON.stringify({ type: 'hello', personToken: token }));
                if (frame.type === 'proposalSync' || frame.type === 'personRequired') done(frame.type);
              };
              socket.onerror = () => done('error');
            });
            const spend = await call('/api/agent/spend', {}, true);
            const spendNoToken = await call('/api/agent/spend', {}, false);
            const kreaStatus = await call('/api/krea/connection', {}, true);
            const kreaCheck = await call('/api/krea/connection/check', { method: 'POST' }, true);
            const kreaCheckNoToken = await call('/api/krea/connection/check', { method: 'POST' }, false);
            const kreaDisconnect = await call('/api/krea/connection', { method: 'DELETE' }, true);
            const kreaDisconnectNoToken = await call('/api/krea/connection', { method: 'DELETE' }, false);
            const helloAsPerson = await hello(got.token);
            const helloWrongToken = await hello('x'.repeat(43));
            const result = {
              pageOrigin: window.location.origin,
              spend: { status: spend.status, limited: spend.body && spend.body.limited },
              spendNoToken: { status: spendNoToken.status, limited: spendNoToken.body && spendNoToken.body.limited },
              kreaStatus: { status: kreaStatus.status, connection: kreaStatus.body && kreaStatus.body.status },
              kreaCheck: { status: kreaCheck.status, connection: kreaCheck.body && kreaCheck.body.status },
              kreaCheckNoToken: { status: kreaCheckNoToken.status, code: kreaCheckNoToken.body && kreaCheckNoToken.body.code },
              kreaDisconnect: { status: kreaDisconnect.status, connection: kreaDisconnect.body && kreaDisconnect.body.status },
              kreaDisconnectNoToken: { status: kreaDisconnectNoToken.status, code: kreaDisconnectNoToken.body && kreaDisconnectNoToken.body.code },
              helloAsPerson,
              helloWrongToken,
            };
            result.ok = spend.status === 200 && spend.body?.limited === false
              && spendNoToken.status === 200 && spendNoToken.body?.limited !== false
              && kreaStatus.status === 200 && typeof kreaStatus.body?.status === 'string' && kreaStatus.body.status !== 'error'
              && kreaCheck.status === 200
              && kreaCheckNoToken.status === 403 && kreaCheckNoToken.body?.code === 'person_required'
              && kreaDisconnect.status === 200 && kreaDisconnect.body?.status === 'disconnected'
              && kreaDisconnectNoToken.status === 403
              && helloAsPerson === 'proposalSync' && helloWrongToken === 'personRequired';
            return result;
          })().catch((err) => ({ ok: false, error: String(err) })),
        ]).then(([health, websocket, _mounted, settingsSave, personPaths]) => {
          const c = window.nebulaDesktop && window.nebulaDesktop.credentials;
          const m = window.nebulaDesktop && window.nebulaDesktop.migration;
          return {
            title: document.title,
            rootMounted: Boolean(document.querySelector('#root')?.children.length),
            preload: {
              platform: window.nebulaDesktop && window.nebulaDesktop.platform,
              shell: window.nebulaDesktop && window.nebulaDesktop.shell,
              apiBaseUrl: window.nebulaDesktop && window.nebulaDesktop.apiBaseUrl,
              wsBaseUrl: window.nebulaDesktop && window.nebulaDesktop.wsBaseUrl,
            },
            health,
            websocket,
            settingsSave,
            personPaths,
            bridge: {
              hasCredentials: Boolean(c),
              hasMigration: Boolean(m),
              setFn: typeof (c && c.set),
              hasFn: typeof (c && c.has),
              clearFn: typeof (c && c.clear),
              getFn: typeof (c && c.get),
              statusFn: typeof (m && m.status),
              retryFn: typeof (m && m.retry),
              rootFrozen: Object.isFrozen(window.nebulaDesktop),
              credsFrozen: c ? Object.isFrozen(c) : false,
              migrationFrozen: m ? Object.isFrozen(m) : false,
              hasPlaintextWarning: Array.isArray(window.nebulaDesktop && window.nebulaDesktop.plaintextKeyWarning),
              plaintextWarningFrozen: window.nebulaDesktop
                ? Object.isFrozen(window.nebulaDesktop.plaintextKeyWarning)
                : false,
              hasRequire: typeof window.require,
              hasIpcRenderer: typeof window.ipcRenderer,
            },
          };
        })
      `);

      const apiBaseUrl = result.preload?.apiBaseUrl ?? '';
      const wsBaseUrl = result.preload?.wsBaseUrl ?? '';

      const passed = (
        result.title === 'Nebula Nodes'
        && result.rootMounted
        && result.preload?.shell === 'electron'
        && apiBaseUrl.startsWith('http://127.0.0.1:')
        && !apiBaseUrl.includes(':8000')
        && wsBaseUrl.startsWith('ws://127.0.0.1:')
        && !wsBaseUrl.includes(':8000')
        && result.health?.ok === true
        && result.health?.body?.status === 'ok'
        && result.health?.body?.app === 'nebula'
        && result.websocket?.connected === true
        // Skipped (not isolated, or no person token with a debug port open) is fine; a failed save is not.
        && (result.settingsSave?.skipped !== undefined || result.settingsSave?.ok === true)
        && (result.personPaths?.skipped !== undefined || result.personPaths?.ok === true)
        // Credential bridge surface (VAL-KEY-011, VAL-KEY-012, VAL-KEY-013)
        && result.bridge?.hasCredentials === true
        && result.bridge?.setFn === 'function'
        && result.bridge?.hasFn === 'function'
        && result.bridge?.clearFn === 'function'
        && result.bridge?.getFn === 'undefined'
        && result.bridge?.hasMigration === true
        && result.bridge?.statusFn === 'function'
        && result.bridge?.retryFn === 'function'
        && result.bridge?.rootFrozen === true
        && result.bridge?.credsFrozen === true
        && result.bridge?.migrationFrozen === true
        && result.bridge?.hasPlaintextWarning === true
        && result.bridge?.plaintextWarningFrozen === true
        && result.bridge?.hasRequire === 'undefined'
        && result.bridge?.hasIpcRenderer === 'undefined'
      );

      console.log(`NEBULA_DESKTOP_SMOKE ${JSON.stringify({
        passed,
        title: result.title,
        rootMounted: result.rootMounted,
        apiBaseUrl,
        wsBaseUrl,
        shell: result.preload?.shell,
        platform: result.preload?.platform,
        health: result.health,
        websocket: result.websocket,
        settingsSave: result.settingsSave,
        personPaths: result.personPaths,
        bridge: result.bridge,
      })}`);

      clearTimeout(smokeTimeout);
      isCleaningUp = true; // this stop is ours, not a mid-session crash
      await stopSidecar(handle).catch(() => {});
      sidecarHandle = null;
      app.exit(passed ? 0 : 1);
    } catch (error) {
      clearTimeout(smokeTimeout);
      console.error('NEBULA_DESKTOP_SMOKE', error);
      await stopSidecar(handle).catch(() => {});
      sidecarHandle = null;
      app.exit(1);
    }
  });
}

// ---------------------------------------------------------------------------
// Sidecar cleanup
// ---------------------------------------------------------------------------

async function cleanupSidecar() {
  if (!sidecarHandle) return;
  const handle = sidecarHandle;
  sidecarHandle = null;
  try {
    await stopSidecar(handle);
    console.log(`Sidecar stopped: pid=${handle.pid} port=${handle.port}`);
  } catch (err) {
    console.error('Sidecar stop error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const acquiredLock = refuseDebugLaunch ? false : app.requestSingleInstanceLock();
if (refuseDebugLaunch) {
  // A normal Nebula.app never runs with a debugger attachable from outside:
  // no window, no backend, no token. Validation builds and `npm run start`
  // carry on without a person token instead (person-token.mjs).
  app.whenReady().then(async () => {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Nebula',
      message: 'Nebula won\'t start with debugging switches.',
      detail:
        `It was opened with ${launchDebugSwitches.map((name) => `--${name}`).join(', ')}, ` +
        'which would let other programs on this Mac control it. Open Nebula normally ' +
        '(from the Dock or Finder) instead.',
      buttons: ['Quit'],
    });
    app.exit(1);
  });
} else if (!acquiredLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Show the existing window, or recreate it when every window was
    // closed (window-recovery.mjs). No second sidecar is started.
    showAppWindow({ focusExisting: true });
  });

  app.whenReady().then(async () => {
    // file:// reads only inside the renderer bundle (renderer-files.mjs),
    // installed before any window can load anything.
    if (!isDevelopment) {
      confineFileScheme(protocol, net, dirname(fileURLToPath(rendererUrl)));
    }

    // `npm run start` runs the stock Electron binary, whose Dock icon is
    // Electron's. Nebula.app gets its icon from the bundle instead.
    if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
      const dockIcon = join(__dirname, 'build', 'icon.png');
      if (existsSync(dockIcon)) app.dock.setIcon(dockIcon);
    }

    // Show a nonblank startup surface before sidecar health is confirmed.
    loadingWindow = createLoadingWindow();
    sidecarStarting = true;

    try {
      // A missing renderer build would load as a blank window after a full
      // sidecar cold start. Say what to run instead, before anything touches
      // the app data root (directory creation, one-time migration) or spawns.
      if (!isDevelopment && !existsSync(fileURLToPath(rendererUrl))) {
        throw new Error(
          `The desktop renderer is not built: ${fileURLToPath(rendererUrl)}\n` +
          'Run `cd frontend && npm run build:desktop`, then start the app again.',
        );
      }
      // The build's params version (frontend-build.mjs). A build without a
      // stamp predates it; same answer, same point: before anything spawns.
      // Compared with the backend's once the sidecar is healthy, below.
      const frontendParamsVersion = isDevelopment
        ? null
        : readBuildParamsVersion(dirname(fileURLToPath(rendererUrl)));

      // Compute App Support paths and create the directory tree before
      // spawning the sidecar. The env vars are merged into the child
      // process environment so the backend resolves state, output,
      // characters, moodboards, presets, and settings to
      // ~/Library/Application Support/Nebula Nodes/ (or <userDataDir>/Nebula Nodes/ when isolated).
      // In browser/dev mode (no Electron), none of these are set —
      // the backend uses its default paths.
      const { root: appDataRoot, envVars: pathEnvVars } = prepareAppDataEnv({ root: dataPaths.appDataRoot });

      // Register credential IPC handlers before the renderer loads.
      //
      // The credential service uses safeStorage's async API to encrypt
      // API keys and stores encrypted blobs (v1:<base64>) in
      // credentials.json under App Support. The renderer can set, check,
      // and clear keys but can never read plaintext values (no get
      // channel). Every handler validates the sender and provider name
      // against the 18-key allowlist.
      const credentialsPath = join(appDataRoot, CREDENTIALS_FILE_NAME);
      const migrationStatePath = join(appDataRoot, MIGRATION_STATE_FILE_NAME);
      const credentialService = createCredentialService({
        credentialsPath,
        migrationStatePath,
        safeStorage,
      });
      const validateSender = createSenderValidator(
        isDevelopment ? ['http://localhost:5173'] : ['file://'],
      );
      registerCredentialHandlers(ipcMain, credentialService, validateSender);
      registerPaperLinkHandler(ipcMain, shell, createPaperLinkSenderValidator(rendererUrl, () => mainWindow?.webContents));
      registerKreaAuthLinkHandler(ipcMain, shell, createPaperLinkSenderValidator(rendererUrl, () => mainWindow?.webContents));
      registerFolderPickerHandler(ipcMain, dialog, createPaperLinkSenderValidator(rendererUrl, () => mainWindow?.webContents), () => mainWindow);
      registerPersonTokenHandler(ipcMain, person, createPaperLinkSenderValidator(rendererUrl, () => mainWindow?.webContents));

      // --- One-time migration (VAL-MIG-007..010, VAL-UX-001..006) ---
      //
      // On first desktop launch (no migration-state.json or status != complete),
      // read legacy settings.json from the repo root, encrypt each non-empty
      // API key to safeStorage, write new settings.json with apiKeys: {}, copy
      // ~/.nebula/* and <repo>/output/ to App Support, and write a completion
      // marker. Source files are NEVER deleted. The migration is idempotent.
      //
      // A migration status overlay is shown during migration (loading,
      // complete, failed). On failure, a retry button lets the user resume
      // from incomplete work without deleting already-copied data.
      if (isMigrationNeeded(migrationStatePath)) {
        const migrationOptions = {
          appDataRoot,
          legacySettingsPath: dataPaths.legacy.settingsPath,
          legacyNebulaDir: dataPaths.legacy.nebulaDir,
          legacyOutputDir: dataPaths.legacy.outputDir,
          safeStorage,
        };
        await runMigrationWithOverlay(
          loadingWindow,
          migrationOptions,
          credentialService,
        );
      }

      // --- Decrypt credentials for sidecar injection (VAL-INJECT-001) ---
      //
      // Decrypt all stored API keys from credentials.json via safeStorage.
      // They go to the sidecar over stdin with the Krea vault key, after the
      // person token (sidecar.mjs launchSecretsLine,
      // backend/services/launch_secrets.py), never in its environment: any
      // same-user process can read a process's initial env with `ps -E`.
      // The backend keeps them in memory only, never persisted.
      const injectedKeys = await credentialService.decryptAll();
      const sidecarEnv = { ...process.env, ...pathEnvVars };
      sidecarEnv.NEBULA_DESKTOP_MODE = '1';
      // The interpreter override is dev/test-only (launch-overrides.mjs): a
      // packaged build always runs the checkout's backend/.venv/bin/python.
      delete sidecarEnv.NEBULA_DESKTOP_PYTHON;
      if (overrides.python) sidecarEnv.NEBULA_DESKTOP_PYTHON = overrides.python;
      // sidecar.mjs reads its health budget from this env; same rule.
      delete sidecarEnv.NEBULA_DESKTOP_HEALTH_TIMEOUT_MS;
      if (overrides.healthTimeoutMs) sidecarEnv.NEBULA_DESKTOP_HEALTH_TIMEOUT_MS = overrides.healthTimeoutMs;
      // Secrets never ride in the env, including provider keys and tokens
      // inherited from a launching terminal (startSidecar strips these too).
      for (const name of SIDECAR_STRIPPED_ENV_KEYS) delete sidecarEnv[name];
      let connectorEncryptionKey = null;
      try {
        connectorEncryptionKey = await getConnectorEncryptionKey(
          join(appDataRoot, 'connector-vault-key.enc'), safeStorage,
        );
      } catch {
        // Existing API-key workflows remain available; OAuth fails closed.
        console.warn('Krea account connection unavailable: OS credential storage is locked');
      }

      // --- Plaintext key detection (VAL-UX-005) ---
      //
      // On every desktop launch, check if App Support settings.json has any
      // non-empty apiKeys entries. If so, the renderer will show a warning
      // (secrets detected in settings file after migration). This catches
      // cases where the user manually edited the file to add plaintext keys.
      const plaintextWarning = await detectPlaintextKeysInFile(
        join(appDataRoot, 'settings.json'),
      );
      plaintextProviders = plaintextWarning.hasPlaintext
        ? plaintextWarning.providers
        : [];

      sidecarHandle = await startSidecar({
        env: sidecarEnv,
        personToken: person.token,
        launchSecrets: { injectedKeys, connectorEncryptionKey },
      });
      const handle = sidecarHandle;
      console.log(
        `Sidecar started: pid=${handle.pid} port=${handle.port} ` +
        `apiBaseUrl=${handle.apiBaseUrl} wsBaseUrl=${handle.wsBaseUrl}`,
      );
      console.log(`NEBULA_SIDECAR_PID=${handle.pid}`);
      console.log(`NEBULA_SIDECAR_PORT=${handle.port}`);

      // A bundle built for another params version can't save or run against
      // this backend (frontend-build.mjs). Stop the sidecar and say which side
      // is older, before any window loads the renderer. sidecarStarting stays
      // true while it stops, so a quit in the meantime waits for it.
      if (frontendParamsVersion !== null) {
        const mismatch = checkParamsVersions(frontendParamsVersion, handle.health);
        if (mismatch) {
          await cleanupSidecar();
          throw mismatch;
        }
      }
      sidecarStarting = false;
      startupError = null;

      // If the user quit during startup, clean up and exit without mounting
      // the normal renderer.
      if (quitRequestedDuringStartup) {
        await cleanupSidecar();
        app.quit();
        return;
      }

      // Close the loading surface and mount the normal renderer with
      // immutable endpoint metadata available to preload.
      if (loadingWindow && !loadingWindow.isDestroyed()) {
        loadingWindow.close();
        loadingWindow = null;
      }

      mainWindow = createMainWindow(handle, plaintextProviders);

      // Watch for mid-session sidecar exit. Show a disconnected state
      // without auto-restarting or rediscovering another backend.
      // (VAL-CROSS-003, VAL-LIFE-013)
      if (handle.child) {
        handle.child.on('exit', () => {
          if (sidecarHandle === handle && !isCleaningUp) {
            console.log(`Sidecar exited mid-session: pid=${handle.pid} port=${handle.port}`);
            sidecarHandle = null;
            showDisconnectedState();
          }
        });
      }

      if (isSmokeTest) {
        runSmokeTest(handle);
      }
    } catch (err) {
      sidecarStarting = false;
      console.error('Sidecar startup failed:', err.message);

      if (quitRequestedDuringStartup) {
        app.quit();
        return;
      }

      // Surface the failure visibly — no normal renderer is loaded.
      startupError = err instanceof Error ? err : new Error(String(err));
      showFailure(startupError);

      if (isSmokeTest) {
        const errorDetails = err instanceof SidecarError || err instanceof FrontendBuildError
          ? {
              type: err.type,
              message: err.message,
              python: err.python,
              exitCode: err.exitCode,
              signal: err.signal,
            }
          : { message: String(err) };
        console.log(`NEBULA_DESKTOP_SMOKE ${JSON.stringify({ passed: false, error: errorDetails })}`);
        app.exit(1);
      }
    }
  });

  app.on('activate', () => {
    // macOS: recreate the window when the Dock icon is clicked and no
    // windows are open. The same sidecar is reused; no new child is spawned.
    showAppWindow({ focusExisting: false });
  });

  app.on('window-all-closed', () => {
    // macOS: keep the app (and sidecar) resident when all windows close.
    if (process.platform !== 'darwin') app.quit();
  });

  // Quitting always stops the sidecar first (SIGTERM, then SIGKILL after a
  // grace period; sidecar.mjs). Cmd-Q, the app menu and a SIGTERM/SIGINT/
  // SIGHUP to Electron all come through here. If Electron dies without
  // running this (crash, SIGKILL), the backend's parent watchdog
  // (backend/services/parent_watch.py) sees its pipe close and exits.
  let quitAllowed = false;
  let stopInFlight = false;
  app.on('before-quit', (event) => {
    if (quitAllowed) return;

    // A second Cmd-Q while the sidecar is stopping must not let Electron
    // exit before the stop finishes (cleanupSidecar clears sidecarHandle
    // before it awaits the stop).
    if (stopInFlight) {
      event.preventDefault();
      return;
    }

    if (sidecarHandle) {
      event.preventDefault();
      stopInFlight = true;
      isCleaningUp = true;
      cleanupSidecar().finally(() => {
        quitAllowed = true;
        app.quit();
      });
    } else if (sidecarStarting) {
      // Quit during cold startup — prevent immediate exit so the startup
      // promise can clean up the child and quit when it resolves/rejects.
      // Without this, the child process is orphaned.
      event.preventDefault();
      quitRequestedDuringStartup = true;
    }
  });

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      console.log(`Received ${signal}; quitting`);
      app.quit();
    });
  }
}
