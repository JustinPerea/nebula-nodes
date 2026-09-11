import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';

const debugPort = process.env.NEBULA_DESKTOP_DEBUG_PORT;
if (debugPort) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const isSmokeTest = process.env.NEBULA_DESKTOP_SMOKE === '1';
const rendererUrl = isDevelopment
  ? process.env.VITE_DEV_SERVER_URL
  : new URL('../frontend/dist/index.html', import.meta.url).toString();
const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    show: !isSmokeTest,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#060607',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  });

  if (isSmokeTest) {
    const smokeTimeout = setTimeout(() => {
      console.error('NEBULA_DESKTOP_SMOKE timed out while loading the renderer');
      app.exit(1);
    }, 20_000);

    mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(smokeTimeout);
      console.error(`NEBULA_DESKTOP_SMOKE renderer load failed: ${code} ${description}`);
      app.exit(1);
    });

    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`
          Promise.all([
            fetch('http://127.0.0.1:8000/api/health', { cache: 'no-store' })
              .then(async (response) => ({ ok: response.ok, body: await response.json() })),
            new Promise((resolve) => {
              const socket = new WebSocket('ws://127.0.0.1:8000/ws');
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
            preload: window.nebulaDesktop ?? null,
            health,
            websocket,
          }))
        `);
        const passed = (
          result.title === 'Nebula Nodes'
          && result.rootMounted
          && result.preload?.shell === 'electron'
          && result.health?.ok
          && result.health?.body?.status === 'ok'
          && result.websocket?.connected
        );
        console.log(`NEBULA_DESKTOP_SMOKE ${JSON.stringify({ passed, ...result })}`);
        clearTimeout(smokeTimeout);
        app.exit(passed ? 0 : 1);
      } catch (error) {
        clearTimeout(smokeTimeout);
        console.error('NEBULA_DESKTOP_SMOKE', error);
        app.exit(1);
      }
    });
  }

  mainWindow.loadURL(rendererUrl);

  if (isDevelopment) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

const acquiredLock = app.requestSingleInstanceLock();
if (!acquiredLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
