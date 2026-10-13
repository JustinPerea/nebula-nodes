/**
 * Electron integration tests for sidecar resilience and cleanup flows.
 *
 * Covers:
 *   VAL-ELECTRON-006: Single-instance lock — second launch focuses existing
 *     window and starts no second sidecar.
 *   VAL-ELECTRON-009: Quit during cold startup cleans up without loading
 *     the workspace.
 *   VAL-CROSS-002: Two isolated instances — distinct identities, sidecars,
 *     ports, and app data.
 *
 * Every test uses isolated --user-data-dir and verifies no orphan listener
 * remains.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DESKTOP_DIR = join(REPO_ROOT, 'desktop');
const ELECTRON = join(DESKTOP_DIR, 'node_modules', '.bin', 'electron');
const FIXTURES = join(__dirname, 'fixtures');
const DIST_INDEX = join(REPO_ROOT, 'frontend', 'dist-desktop', 'index.html');

const tempDirs = [];

/** Every profile this file creates starts with this path prefix. */
const TEMP_PREFIX = join(tmpdir(), 'nebula-res-');

function mkTemp() {
  const dir = mkdtempSync(TEMP_PREFIX);
  tempDirs.push(dir);
  return dir;
}

/**
 * Launch Electron as a subprocess and capture all output.
 * @param {Record<string,string>} env
 * @param {number} timeoutMs
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, child: import('child_process').ChildProcess}>}
 */
function runElectron(env, timeoutMs) {
  return new Promise((resolveP) => {
    const child = spawn(ELECTRON, ['.'], {
      cwd: DESKTOP_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveP({ exitCode: code, signal, stdout, stderr, timedOut, child });
    });
  });
}

/** Extract the NEBULA_DESKTOP_SMOKE JSON line from stdout. */
function parseSmokeLine(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('NEBULA_DESKTOP_SMOKE'));
  if (!line) return null;
  const jsonStart = line.indexOf('{');
  if (jsonStart < 0) return null;
  return JSON.parse(line.slice(jsonStart));
}

/** Extract a NEBULA_SIDECAR_PID=NNN line from stdout. */
function parseSidecarPid(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('NEBULA_SIDECAR_PID='));
  if (!line) return null;
  return parseInt(line.split('=')[1].trim(), 10);
}

/** Extract a NEBULA_SIDECAR_PORT=NNN line from stdout. */
function parseSidecarPort(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('NEBULA_SIDECAR_PORT='));
  if (!line) return null;
  return parseInt(line.split('=')[1].trim(), 10);
}

/** Extract the dynamic port from an apiBaseUrl string. */
function portFromUrl(url) {
  const match = url?.match(/:(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/** Verify no listener remains on a given port. */
function assertNoListener(port) {
  if (!port) return;
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`, {
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(out.trim(), '', `Port ${port} still has a listener after exit`);
  } catch {
    // lsof not available — skip
  }
}

/** Check if a PID is still alive. */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PIDs of processes whose command line matches `pattern` (pgrep -f). */
function pgrepPids(pattern) {
  const out = execSync(`pgrep -f ${JSON.stringify(pattern)} 2>/dev/null || true`, {
    encoding: 'utf8',
    timeout: 3000,
  });
  return new Set(out.trim().split('\n').filter(Boolean).map((pid) => parseInt(pid, 10)));
}

/**
 * Every uvicorn backend on this machine. The person's own dev server
 * (`uvicorn main:app --port 8000`) and other worktrees match too, so tests
 * compare against a snapshot taken before they launch anything instead of
 * expecting a machine-wide count of zero.
 */
function uvicornPids() {
  return pgrepPids('uvicorn main:app');
}

/**
 * Whether `pid` is a backend one of this file's launches started. Every
 * launch here uses a profile from mkTemp(), and the sidecar's environment
 * points NEBULA_STATE_DIR (and the other app-data paths) inside it, so the
 * temp-dir prefix in the process environment is a marker no outside
 * backend carries. If the environment can't be read the PID counts as ours,
 * which keeps the check strict.
 */
function isOurSidecar(pid) {
  let out;
  try {
    out = execSync(`ps -E -ww -o command= -p ${pid} 2>/dev/null || true`, {
      encoding: 'utf8',
      timeout: 3000,
    });
  } catch {
    return true;
  }
  if (!out.trim()) return false; // exited between pgrep and ps
  if (!out.includes('NEBULA_')) return true; // environment not visible
  return out.includes(`${TEMP_PREFIX}`);
}

/**
 * uvicorn PIDs that exist now, did not exist in `before`, and belong to this
 * file's launches. A dev server restarted on :8000 mid-run, or another
 * worktree's backend, is new but not ours.
 */
function newUvicornPids(before) {
  return [...uvicornPids()].filter((pid) => !before.has(pid) && isOurSidecar(pid));
}

/** Process name used for each launch: a fresh, test-only Electron identity. */
function testAppId(label) {
  return `nebula-res-${process.pid}-${Date.now()}-${label}`;
}

/** Kill a process by PID if alive. */
function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

describe('Electron resilience — single-instance, isolation, and quit-during-startup', () => {
  after(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
    }
  });

  // -------------------------------------------------------------------------
  // VAL-ELECTRON-006: Single-instance lock — second launch focuses existing
  // window and starts no second sidecar.
  // -------------------------------------------------------------------------
  test('second launch with same identity exits without starting a second sidecar', { timeout: 180_000, skip: !existsSync(DIST_INDEX) && 'frontend/dist-desktop not built (npm run build:desktop)' }, async () => {
    const userData = mkTemp();
    const appId = testAppId('single');
    const debugPortBase = 47000 + Math.floor(Math.random() * 1000);
    const uvicornBefore = uvicornPids();

    // Launch first instance (non-smoke, will stay running).
    const firstChild = spawn(ELECTRON, ['.'], {
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        NEBULA_DESKTOP_USER_DATA_DIR: userData,
        NEBULA_DESKTOP_TEST: '1',
        NEBULA_DESKTOP_APP_ID: appId,
        NEBULA_DESKTOP_DEBUG_PORT: String(debugPortBase),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let firstStdout = '';
    firstChild.stdout.on('data', (chunk) => { firstStdout += chunk; });

    // Wait for the first instance to start the sidecar (up to 90s for cold start).
    let firstPid = null;
    let firstPort = null;

    try {
      const startDeadline = Date.now() + 90_000;
      while (Date.now() < startDeadline) {
        await new Promise((r) => setTimeout(r, 500));
        firstPid = parseSidecarPid(firstStdout);
        firstPort = parseSidecarPort(firstStdout);
        if (firstPid && firstPort) break;
      }

      assert.ok(firstPid, 'First instance should have started a sidecar');
      assert.ok(firstPort, 'First instance should have logged a sidecar port');

      // The first instance's sidecar is the only backend this test started.
      const childrenBefore = newUvicornPids(uvicornBefore);
      assert.deepEqual(childrenBefore, [firstPid], `Expected only the first sidecar, got ${childrenBefore}`);

      // Launch second instance with the same identity.
      const secondResult = await runElectron({
        NEBULA_DESKTOP_USER_DATA_DIR: userData,
        NEBULA_DESKTOP_TEST: '1',
        NEBULA_DESKTOP_APP_ID: appId,
      }, 15_000);

      // The second instance should exit (deferred to the first) — it should
      // not start a sidecar. On macOS it may exit with code 0 or signal.
      assert.ok(
        secondResult.exitCode !== null || secondResult.signal !== null,
        'Second instance should have exited',
      );

      // Verify no second sidecar was started.
      assert.equal(parseSidecarPid(secondResult.stdout), null, 'Second instance should not log a sidecar');
      const childrenAfter = newUvicornPids(uvicornBefore);
      assert.deepEqual(
        childrenAfter,
        childrenBefore,
        `Second launch should not start another sidecar (before: ${childrenBefore}, after: ${childrenAfter})`,
      );
    } finally {
      // Cleanup: kill the first instance and sidecar even if an assertion fails.
      killPid(firstChild.pid);
      killPid(firstPid);

      // Wait for first instance to exit.
      await new Promise((r) => setTimeout(r, 3000));
      try { firstChild.kill('SIGKILL'); } catch { /* already gone */ }
    }

    // Verify no orphan listener or sidecar.
    assertNoListener(firstPort);
    assert.equal(isPidAlive(firstPid), false, `First sidecar ${firstPid} should be gone`);
    assert.deepEqual(newUvicornPids(uvicornBefore), [], 'No sidecar started by this test should remain');
  });

  // -------------------------------------------------------------------------
  // VAL-CROSS-002: Two isolated instances — distinct identities, sidecars,
  // ports, and app data.
  // -------------------------------------------------------------------------
  test('two isolated instances run independent sidecars on distinct ports', { timeout: 240_000, skip: !existsSync(DIST_INDEX) && 'frontend/dist-desktop not built (npm run build:desktop)' }, async () => {
    const userDataA = mkTemp();
    const userDataB = mkTemp();
    const appIdA = testAppId('iso-a');
    const appIdB = testAppId('iso-b');
    const uvicornBefore = uvicornPids();

    // Run first isolated instance.
    const resultA = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_APP_ID: appIdA,
      NEBULA_DESKTOP_USER_DATA_DIR: userDataA,
      NEBULA_DESKTOP_TEST: '1',
    }, 120_000);

    assert.equal(resultA.timedOut, false, 'Instance A did not exit within 120s');
    const smokeA = parseSmokeLine(resultA.stdout);
    assert.ok(smokeA, 'Instance A: NEBULA_DESKTOP_SMOKE JSON not found');
    assert.equal(smokeA.passed, true, `Instance A smoke failed: ${JSON.stringify(smokeA)}`);
    const portA = portFromUrl(smokeA.apiBaseUrl);
    assert.ok(portA && portA !== 8000, `Instance A port should be dynamic: ${smokeA.apiBaseUrl}`);

    // Run second isolated instance.
    const resultB = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_APP_ID: appIdB,
      NEBULA_DESKTOP_USER_DATA_DIR: userDataB,
      NEBULA_DESKTOP_TEST: '1',
    }, 120_000);

    assert.equal(resultB.timedOut, false, 'Instance B did not exit within 120s');
    const smokeB = parseSmokeLine(resultB.stdout);
    assert.ok(smokeB, 'Instance B: NEBULA_DESKTOP_SMOKE JSON not found');
    assert.equal(smokeB.passed, true, `Instance B smoke failed: ${JSON.stringify(smokeB)}`);
    const portB = portFromUrl(smokeB.apiBaseUrl);
    assert.ok(portB && portB !== 8000, `Instance B port should be dynamic: ${smokeB.apiBaseUrl}`);

    // Ports must be distinct.
    assert.notEqual(portA, portB, 'Isolated instances must use distinct ports');

    // Neither port should have a listener after both instances exited.
    assertNoListener(portA);
    assertNoListener(portB);

    // Both sidecars are gone and no backend started by this test remains.
    const pidA = parseSidecarPid(resultA.stdout);
    const pidB = parseSidecarPid(resultB.stdout);
    assert.ok(pidA && pidB && pidA !== pidB, `Each instance should log its own sidecar (${pidA}, ${pidB})`);
    assert.equal(isPidAlive(pidA), false, `Sidecar A ${pidA} should be gone`);
    assert.equal(isPidAlive(pidB), false, `Sidecar B ${pidB} should be gone`);
    const remaining = newUvicornPids(uvicornBefore);
    assert.deepEqual(remaining, [], `No uvicorn children should remain, got ${remaining}`);

    // Each instance kept its app data inside its own profile.
    assert.ok(existsSync(join(userDataA, 'Nebula Nodes', 'state')), 'Instance A app data should be in its profile');
    assert.ok(existsSync(join(userDataB, 'Nebula Nodes', 'state')), 'Instance B app data should be in its profile');
  });

  // -------------------------------------------------------------------------
  // VAL-ELECTRON-009: Quit during cold startup cleans up without loading
  // the workspace.
  // -------------------------------------------------------------------------
  test('quit during cold startup leaves no child process or listener', { timeout: 45_000, skip: !existsSync(DIST_INDEX) && 'frontend/dist-desktop not built (npm run build:desktop)' }, async () => {
    const userData = mkTemp();
    const uvicornBefore = uvicornPids();
    const fixture = join(FIXTURES, 'never-healthy.mjs');

    // Launch with never-healthy fixture so startup doesn't complete.
    // Use a short health timeout so the startup promise rejects quickly
    // after we send SIGTERM, allowing the before-quit handler to proceed.
    const child = spawn(ELECTRON, ['.'], {
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        NEBULA_DESKTOP_SMOKE: '1',
        NEBULA_DESKTOP_USER_DATA_DIR: userData,
        NEBULA_DESKTOP_TEST: '1',
        NEBULA_DESKTOP_APP_ID: testAppId('quit'),
        NEBULA_DESKTOP_PYTHON: fixture,
        NEBULA_DESKTOP_HEALTH_TIMEOUT_MS: '5000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    // Wait for the sidecar child to be spawned (before health). A fresh
    // profile first shows the one-time migration overlay, so poll instead of
    // guessing a delay. Match this repo's fixture path only, so other
    // checkouts running the same suite can't satisfy or fail this check.
    let childCount = 0;
    const spawnDeadline = Date.now() + 10_000;
    while (Date.now() < spawnDeadline) {
      childCount = pgrepPids(fixture).size;
      if (childCount >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(childCount >= 1, `Sidecar child should be running before quit, got ${childCount}`);

    // Send SIGTERM to the Electron process (simulates Cmd+Q / before-quit).
    try { child.kill('SIGTERM'); } catch { /* already gone */ }

    // Wait for the process to exit. The before-quit handler prevents
    // immediate exit (event.preventDefault), sets quitRequestedDuringStartup,
    // and the startup promise rejects after the health timeout (5s), then
    // calls app.quit() which lets the process exit.
    const exitResult = await new Promise((resolveP) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolveP({ timedOut: true });
      }, 15_000);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolveP({ exitCode: code, signal, timedOut: false });
      });
    });

    assert.equal(exitResult.timedOut, false, 'Electron should have exited after SIGTERM during startup');

    // Give cleanup a moment.
    await new Promise((r) => setTimeout(r, 2000));

    // No fixture child should remain.
    const remaining = pgrepPids(fixture).size;
    assert.equal(remaining, 0, `No never-healthy child should remain, got ${remaining}`);

    // No uvicorn children should remain.
    const uvicornRemaining = newUvicornPids(uvicornBefore);
    assert.deepEqual(uvicornRemaining, [], `No uvicorn children should remain, got ${uvicornRemaining}`);

    // The workspace should never have been loaded — no NEBULA_DESKTOP_SMOKE
    // passed line should appear.
    const smokeLine = stdout.split('\n').find((l) => l.startsWith('NEBULA_DESKTOP_SMOKE'));
    assert.ok(!smokeLine || !smokeLine.includes('"passed":true'),
      'Normal workspace should not have been loaded during quit-during-startup');
  });
});
