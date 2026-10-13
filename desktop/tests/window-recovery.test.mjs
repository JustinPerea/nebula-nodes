import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideWindowAction } from '../window-recovery.mjs';

const idle = {
  hasLiveWindow: false,
  openWindowCount: 0,
  focusExisting: true,
  isCleaningUp: false,
  hasSidecar: true,
  sidecarDisconnected: false,
};

describe('decideWindowAction', () => {
  test('a second launch with every window closed recreates the main window', () => {
    assert.equal(decideWindowAction(idle), 'create-main');
  });

  test('a second launch focuses the window that is already open', () => {
    assert.equal(decideWindowAction({ ...idle, hasLiveWindow: true, openWindowCount: 1 }), 'focus');
  });

  test('a Dock click leaves an open window to macOS and recreates a closed one', () => {
    assert.equal(decideWindowAction({ ...idle, focusExisting: false, hasLiveWindow: true, openWindowCount: 1 }), 'none');
    assert.equal(decideWindowAction({ ...idle, focusExisting: false }), 'create-main');
  });

  test('after the sidecar died, the disconnected page comes back instead of a dead canvas', () => {
    assert.equal(decideWindowAction({ ...idle, hasSidecar: false, sidecarDisconnected: true }), 'create-disconnected');
  });

  test('nothing opens while quitting', () => {
    assert.equal(decideWindowAction({ ...idle, isCleaningUp: true }), 'none');
    assert.equal(decideWindowAction({ ...idle, isCleaningUp: true, hasLiveWindow: true }), 'none');
  });

  test('during startup the startup path opens the window', () => {
    assert.equal(decideWindowAction({ ...idle, hasSidecar: false }), 'none');
  });

  test('after a failed startup whose error window was closed, the error comes back', () => {
    assert.equal(decideWindowAction({ ...idle, hasSidecar: false, startupFailed: true }), 'create-failure');
    assert.equal(decideWindowAction({ ...idle, hasSidecar: false, startupFailed: true, focusExisting: false }), 'create-failure');
  });

  test('a failed startup whose error window is still open just focuses it', () => {
    assert.equal(
      decideWindowAction({ ...idle, hasSidecar: false, startupFailed: true, hasLiveWindow: true, openWindowCount: 1 }),
      'focus',
    );
  });

  test('a failed startup never opens a window while quitting', () => {
    assert.equal(decideWindowAction({ ...idle, hasSidecar: false, startupFailed: true, isCleaningUp: true }), 'none');
  });

  test('another window (a dialog) being open is left alone', () => {
    assert.equal(decideWindowAction({ ...idle, openWindowCount: 1 }), 'none');
  });
});

describe('main.mjs wiring', () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');

  function handlerBody(event) {
    const start = source.indexOf(`app.on('${event}', () => {`);
    assert.ok(start > 0, `no ${event} handler`);
    return source.slice(start, source.indexOf('\n  });', start));
  }

  test('second-instance recreates the window through the shared path', () => {
    assert.match(handlerBody('second-instance'), /showAppWindow\(\{ focusExisting: true \}\)/);
  });

  test('a failed startup is remembered and re-shown through showFailure', () => {
    assert.match(source, /startupError = err instanceof Error/);
    assert.match(source, /startupFailed: Boolean\(startupError\) && !sidecarStarting/);
    assert.match(source, /action === 'create-failure'\) \{\n\s+showFailure\(startupError\)/);
  });

  test('activate uses the same path without stealing focus from open windows', () => {
    assert.match(handlerBody('activate'), /showAppWindow\(\{ focusExisting: false \}\)/);
  });

  test('the shared path asks decideWindowAction and never starts a sidecar', () => {
    const start = source.indexOf('function showAppWindow(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.match(body, /decideWindowAction\(/);
    assert.equal(/startSidecar\(/.test(body), false);
  });
});
