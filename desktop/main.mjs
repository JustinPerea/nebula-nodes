import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { startSidecar, stopSidecar, SidecarError } from './sidecar.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Loopback CDP port for agent-browser validation. */
const debugPort = process.env.NEBULA_DESKTOP_DEBUG_PORT;
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
const appId = process.env.NEBULA_DESKTOP_APP_ID;
if (appId) {
  app.setName(appId);
}

/** Test-only isolated user-data directory for concurrent validators. */
const userDataDir = process.env.NEBULA_DESKTOP_USER_DATA_DIR;
if (userDataDir) {
  app.setPath('userData', userDataDir);
}

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const isSmokeTest = process.env.NEBULA_DESKTOP_SMOKE === '1';
const rendererUrl = isDevelopment
  ? process.env.VITE_DEV_SERVER_URL
  : new URL('../frontend/dist/index.html', import.meta.url).toString();
const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import('./sidecar.mjs').SidecarHandle | null} */
let sidecarHandle = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let loadingWindow = null;
let isCleaningUp = false;
let quitRequestedDuringStartup = false;
let sidecarStarting = false;
let sidecarDisconnected = false;

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
<h1>Backend startup failed</h1>
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
 * @returns {BrowserWindow}
 */
function createMainWindow(handle) {
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
      ],
    },
  });

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
        ]).then(([health, websocket]) => ({
          title: document.title,
          rootMounted: Boolean(document.querySelector('#root')?.children.length),
          preload: window.nebulaDesktop,
          health,
          websocket,
        }))
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
      })}`);

      clearTimeout(smokeTimeout);
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

const acquiredLock = app.requestSingleInstanceLock();
if (!acquiredLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus the existing window — no second sidecar is started.
    // During startup the main window may not exist yet; focus the
    // loading window in that case.
    const win = mainWindow || loadingWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // Show a nonblank startup surface before sidecar health is confirmed.
    loadingWindow = createLoadingWindow();
    sidecarStarting = true;

    try {
      sidecarHandle = await startSidecar();
      sidecarStarting = false;
      const handle = sidecarHandle;
      console.log(
        `Sidecar started: pid=${handle.pid} port=${handle.port} ` +
        `apiBaseUrl=${handle.apiBaseUrl} wsBaseUrl=${handle.wsBaseUrl}`,
      );
      console.log(`NEBULA_SIDECAR_PID=${handle.pid}`);
      console.log(`NEBULA_SIDECAR_PORT=${handle.port}`);

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

      mainWindow = createMainWindow(handle);

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
      showFailure(err);

      if (isSmokeTest) {
        const errorDetails = err instanceof SidecarError
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
    // macOS: recreate the window when the dock is activated and no windows
    // are open. The same sidecar is reused — no new child is spawned.
    if (BrowserWindow.getAllWindows().length === 0 && !isCleaningUp) {
      if (sidecarHandle) {
        mainWindow = createMainWindow(sidecarHandle);
      } else if (sidecarDisconnected) {
        // Sidecar died mid-session — show the disconnected page rather
        // than creating a window with a dead endpoint or spawning a new
        // sidecar. No auto-restart.
        mainWindow = new BrowserWindow({
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
        const win = mainWindow;
        win.loadURL(DISCONNECTED_HTML);
        win.on('closed', () => {
          if (mainWindow === win) mainWindow = null;
        });
      }
    }
  });

  app.on('window-all-closed', () => {
    // macOS: keep the app (and sidecar) resident when all windows close.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    // Re-entrant call after cleanup — let the quit proceed.
    if (isCleaningUp) return;

    if (sidecarHandle) {
      event.preventDefault();
      isCleaningUp = true;
      await cleanupSidecar();
      app.quit();
    } else if (sidecarStarting) {
      // Quit during cold startup — prevent immediate exit so the startup
      // promise can clean up the child and quit when it resolves/rejects.
      // Without this, the child process is orphaned.
      event.preventDefault();
      quitRequestedDuringStartup = true;
    }
  });
}
