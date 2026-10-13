/**
 * What the app does when it is asked to show itself.
 *
 * Two events ask: `activate` (a Dock click on macOS) and `second-instance`
 * (someone opens Nebula again while it already runs: a second Nebula.app,
 * `npm run start` while Nebula.app holds the shared `nebula-desktop` lock,
 * or a double-click in Finder). On macOS the app stays running with no
 * windows after the last one closes, so both must be able to recreate the
 * window; before this, `second-instance` only focused an existing window,
 * and a second launch with every window closed showed nothing at all while
 * the new instance quit.
 *
 * Kept free of Electron so it can be unit tested; main.mjs does the window
 * work for whichever action this returns.
 *
 * @param {{
 *   hasLiveWindow: boolean,        // mainWindow or loadingWindow exists and isn't destroyed
 *   openWindowCount: number,       // BrowserWindow.getAllWindows().length
 *   focusExisting: boolean,        // second-instance: yes; activate: macOS already raises them
 *   isCleaningUp: boolean,         // quitting: never open a window
 *   hasSidecar: boolean,           // a running sidecar handle
 *   sidecarDisconnected: boolean,  // the sidecar died mid-session
 *   startupFailed?: boolean,       // the sidecar never became healthy; the failure window was shown
 * }} state
 * @returns {'focus' | 'create-main' | 'create-disconnected' | 'create-failure' | 'none'}
 */
export function decideWindowAction({
  hasLiveWindow,
  openWindowCount,
  focusExisting,
  isCleaningUp,
  hasSidecar,
  sidecarDisconnected,
  startupFailed = false,
}) {
  if (isCleaningUp) return 'none';
  if (hasLiveWindow) return focusExisting ? 'focus' : 'none';
  if (openWindowCount > 0) return 'none';
  // The same sidecar is reused; no new child is ever spawned here.
  if (hasSidecar) return 'create-main';
  // No auto-restart: show the disconnected page instead of a dead canvas.
  if (sidecarDisconnected) return 'create-disconnected';
  // Startup failed and its error window was closed. The startup path never
  // runs again, so without this the app would sit in the Dock with no window
  // and ignore every Dock click and second launch.
  if (startupFailed) return 'create-failure';
  // Still starting up: the startup path opens the window when it is ready.
  return 'none';
}
