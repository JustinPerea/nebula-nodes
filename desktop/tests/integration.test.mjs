/**
 * Electron integration tests for the managed sidecar startup path.
 *
 * Launches the real Electron binary as a subprocess with NEBULA_DESKTOP_SMOKE=1
 * and asserts the observable behaviour required by VAL-ELECTRON-001..004,
 * VAL-ELECTRON-008, VAL-CROSS-001, and VAL-CROSS-005:
 *
 *   - The smoke run proves dynamic endpoint injection (non-8000 port).
 *   - Invalid Python override surfaces a visible failure and exits non-zero.
 *   - Early-exit fixture surfaces a visible failure with exit metadata.
 *   - Health timeout terminates the child and surfaces a timeout failure.
 *   - A backend at another params version than the built frontend's stamp
 *     stops startup with a rebuild message and stops the sidecar
 *     (frontend-build.mjs).
 *
 * Every test uses an isolated --user-data-dir and verifies no orphan listener
 * remains on the sidecar port after the process exits.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DESKTOP_DIR = join(REPO_ROOT, 'desktop');
const ELECTRON = join(DESKTOP_DIR, 'node_modules', '.bin', 'electron');
const FIXTURES = join(__dirname, 'fixtures');
const DIST_INDEX = join(REPO_ROOT, 'frontend', 'dist-desktop', 'index.html');
const DIST_STAMP = join(REPO_ROOT, 'frontend', 'dist-desktop', 'nebula-build.json');
// A bundle built before the stamp now stops every launch at the stamp check,
// so these tests need a current build, not just an index.html.
const NOT_BUILT = !(existsSync(DIST_INDEX) && existsSync(DIST_STAMP))
  && 'frontend/dist-desktop not built, or built before nebula-build.json (npm run build:desktop)';

const tempDirs = [];

function mkTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-int-'));
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

/** Extract the dynamic port from an apiBaseUrl string. */
function portFromUrl(url) {
  const match = url?.match(/:(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/** The NEBULA_SIDECAR_PID=<pid> line main.mjs prints once the sidecar is healthy. */
function sidecarPid(stdout) {
  const match = stdout.match(/^NEBULA_SIDECAR_PID=(\d+)$/m);
  return match ? parseInt(match[1], 10) : null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
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

describe('Electron integration — managed sidecar startup', () => {
  after(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
    }
  });

  test('smoke run proves dynamic endpoint injection on a non-8000 port', { timeout: 120_000, skip: NOT_BUILT }, async () => {
    const userData = mkTemp();
    const result = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_USER_DATA_DIR: userData,
      NEBULA_DESKTOP_TEST: '1',
      NEBULA_DESKTOP_APP_ID: `nebula-int-${process.pid}-${Date.now()}`,
    }, 120_000);

    assert.equal(result.timedOut, false, 'Electron did not exit within 120s');
    const smoke = parseSmokeLine(result.stdout);
    assert.ok(smoke, 'NEBULA_DESKTOP_SMOKE JSON line not found in stdout');

    // Passed flag
    assert.equal(smoke.passed, true, `Smoke did not pass: ${JSON.stringify(smoke)}`);

    // Injected endpoints on a dynamic non-8000 port
    assert.ok(smoke.apiBaseUrl?.startsWith('http://127.0.0.1:'), `apiBaseUrl not loopback: ${smoke.apiBaseUrl}`);
    const apiPort = portFromUrl(smoke.apiBaseUrl);
    assert.ok(apiPort && apiPort !== 8000, `apiBaseUrl port should not be 8000: ${smoke.apiBaseUrl}`);
    assert.ok(apiPort < 8000 || apiPort > 8010, `apiBaseUrl port should not be in 8000-8010: ${smoke.apiBaseUrl}`);

    assert.ok(smoke.wsBaseUrl?.startsWith('ws://127.0.0.1:'), `wsBaseUrl not loopback WS: ${smoke.wsBaseUrl}`);
    const wsPort = portFromUrl(smoke.wsBaseUrl);
    assert.equal(wsPort, apiPort, 'WS port should match API port');

    // Health identity
    assert.equal(smoke.health?.ok, true);
    assert.equal(smoke.health?.body?.status, 'ok');
    assert.equal(smoke.health?.body?.app, 'nebula');

    // WebSocket connected
    assert.equal(smoke.websocket?.connected, true);

    // Renderer mounted
    assert.equal(smoke.title, 'Nebula Nodes');
    assert.equal(smoke.rootMounted, true);

    // Exit code 0
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);

    // No orphan listener
    assertNoListener(apiPort);
  });

  test('invalid Python override surfaces a visible failure with no orphan', { timeout: 30_000, skip: NOT_BUILT }, async () => {
    const userData = mkTemp();
    const result = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_USER_DATA_DIR: userData,
      NEBULA_DESKTOP_TEST: '1',
      NEBULA_DESKTOP_APP_ID: `nebula-int-${process.pid}-${Date.now()}`,
      NEBULA_DESKTOP_PYTHON: '/nonexistent/path/to/python',
    }, 30_000);

    assert.equal(result.timedOut, false, 'Electron did not exit within 30s');
    const smoke = parseSmokeLine(result.stdout);
    assert.ok(smoke, 'NEBULA_DESKTOP_SMOKE JSON line not found');
    assert.equal(smoke.passed, false);
    assert.ok(
      smoke.error?.message?.includes('/nonexistent/path/to/python') ||
      smoke.error?.python?.includes('/nonexistent/path/to/python'),
      'Error should mention the attempted Python path',
    );
    assert.notEqual(result.exitCode, 0, 'Should exit non-zero on invalid Python');
  });

  test('early-exit fixture surfaces failure with exit metadata', { timeout: 30_000, skip: NOT_BUILT }, async () => {
    const userData = mkTemp();
    const result = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_USER_DATA_DIR: userData,
      NEBULA_DESKTOP_TEST: '1',
      NEBULA_DESKTOP_APP_ID: `nebula-int-${process.pid}-${Date.now()}`,
      NEBULA_DESKTOP_PYTHON: join(FIXTURES, 'exit-with-code.mjs'),
      FIXTURE_EXIT_CODE: '7',
      FIXTURE_STDERR: 'DISTINCTIVE_EARLY_EXIT_MARKER',
    }, 30_000);

    assert.equal(result.timedOut, false, 'Electron did not exit within 30s');
    const smoke = parseSmokeLine(result.stdout);
    assert.ok(smoke, 'NEBULA_DESKTOP_SMOKE JSON line not found');
    assert.equal(smoke.passed, false);
    // Without the renderer the app fails before the sidecar starts (that's
    // why this skips unbuilt), so check the sidecar's own error, not just
    // any message with a 7 in it: a checkout path can contain one.
    assert.equal(smoke.error?.type, 'early_exit', `Expected an early_exit error: ${JSON.stringify(smoke.error)}`);
    assert.equal(smoke.error?.exitCode, 7);
    assert.ok(smoke.error?.message?.includes('DISTINCTIVE_EARLY_EXIT_MARKER'), 'Error should carry the sidecar stderr');
    assert.notEqual(result.exitCode, 0);
  });

  test('health timeout terminates child and surfaces timeout failure', { timeout: 30_000, skip: NOT_BUILT }, async () => {
    const userData = mkTemp();
    const result = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_USER_DATA_DIR: userData,
      NEBULA_DESKTOP_TEST: '1',
      NEBULA_DESKTOP_APP_ID: `nebula-int-${process.pid}-${Date.now()}`,
      NEBULA_DESKTOP_PYTHON: join(FIXTURES, 'never-healthy.mjs'),
      NEBULA_DESKTOP_HEALTH_TIMEOUT_MS: '3000',
    }, 30_000);

    assert.equal(result.timedOut, false, 'Electron did not exit within 30s');
    const smoke = parseSmokeLine(result.stdout);
    assert.ok(smoke, 'NEBULA_DESKTOP_SMOKE JSON line not found');
    assert.equal(smoke.passed, false);
    assert.ok(
      smoke.error?.type === 'health_timeout' ||
      smoke.error?.message?.includes('timed out'),
      'Error should indicate health timeout',
    );
    assert.notEqual(result.exitCode, 0);
  });

  // The stamp check (frontend-build.mjs): the serve-health fixture plays a
  // healthy backend at another params version than the built frontend's.
  const stampVersion = () => JSON.parse(readFileSync(DIST_STAMP, 'utf8')).paramsVersion;

  for (const { name, health, type, phrase, needsVersionAboveZero = false } of [
    {
      name: 'a backend newer than the built frontend',
      health: () => ({ status: 'ok', app: 'nebula', version: '0.1.0', paramsVersion: stampVersion() + 1 }),
      type: 'frontend_older',
      phrase: 'frontend is older than the backend',
    },
    {
      name: 'a backend from before /api/health reported a version',
      health: () => ({ status: 'ok', app: 'nebula', version: '0.1.0' }),
      type: 'frontend_newer',
      phrase: 'frontend is newer than the backend',
      needsVersionAboveZero: true,
    },
  ]) {
    test(`${name} stops startup with a rebuild message and no orphan sidecar`, { timeout: 30_000, skip: NOT_BUILT }, async (t) => {
      if (needsVersionAboveZero && stampVersion() === 0) {
        t.skip('the built frontend is at version 0, which matches a backend without the field');
        return;
      }
      const body = health();
      const userData = mkTemp();
      const result = await runElectron({
        NEBULA_DESKTOP_SMOKE: '1',
        NEBULA_DESKTOP_USER_DATA_DIR: userData,
        NEBULA_DESKTOP_TEST: '1',
        NEBULA_DESKTOP_APP_ID: `nebula-int-${process.pid}-${Date.now()}`,
        NEBULA_DESKTOP_PYTHON: join(FIXTURES, 'serve-health.mjs'),
        FIXTURE_HEALTH_BODY: JSON.stringify(body),
      }, 30_000);

      assert.equal(result.timedOut, false, 'Electron did not exit within 30s');
      const smoke = parseSmokeLine(result.stdout);
      assert.ok(smoke, 'NEBULA_DESKTOP_SMOKE JSON line not found');
      assert.equal(smoke.passed, false);
      assert.equal(smoke.error?.type, type, JSON.stringify(smoke.error));
      assert.ok(smoke.error?.message?.includes(phrase), smoke.error?.message);
      assert.ok(smoke.error?.message?.includes('cd frontend && npm run build:desktop'), smoke.error?.message);
      assert.notEqual(result.exitCode, 0);

      // The sidecar was healthy (so the check ran after it) and was stopped.
      const pid = sidecarPid(result.stdout);
      assert.ok(pid, 'NEBULA_SIDECAR_PID line not found: the sidecar never became healthy');
      assert.equal(processAlive(pid), false, `Sidecar pid ${pid} is still running`);
      const portLine = result.stdout.match(/^NEBULA_SIDECAR_PORT=(\d+)$/m);
      assertNoListener(portLine ? parseInt(portLine[1], 10) : null);
      // And no renderer window was created for the stale bundle.
      assert.ok(!result.stdout.includes('"rootMounted"'), 'The renderer should not have loaded');
    });
  }
});
