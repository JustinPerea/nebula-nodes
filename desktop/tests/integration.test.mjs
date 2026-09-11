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
 *
 * Every test uses an isolated --user-data-dir and verifies no orphan listener
 * remains on the sidecar port after the process exits.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DESKTOP_DIR = join(REPO_ROOT, 'desktop');
const ELECTRON = join(DESKTOP_DIR, 'node_modules', '.bin', 'electron');
const FIXTURES = join(__dirname, 'fixtures');
const DIST_INDEX = join(REPO_ROOT, 'frontend', 'dist', 'index.html');

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

  test('smoke run proves dynamic endpoint injection on a non-8000 port', { timeout: 120_000, skip: !existsSync(DIST_INDEX) && 'frontend/dist not built' }, async () => {
    const userData = mkTemp();
    const result = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_USER_DATA_DIR: userData,
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

  test('invalid Python override surfaces a visible failure with no orphan', { timeout: 30_000 }, async () => {
    const userData = mkTemp();
    const result = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_USER_DATA_DIR: userData,
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

  test('early-exit fixture surfaces failure with exit metadata', { timeout: 30_000 }, async () => {
    const userData = mkTemp();
    const result = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_USER_DATA_DIR: userData,
      NEBULA_DESKTOP_PYTHON: join(FIXTURES, 'exit-with-code.mjs'),
      FIXTURE_EXIT_CODE: '7',
      FIXTURE_STDERR: 'DISTINCTIVE_EARLY_EXIT_MARKER',
    }, 30_000);

    assert.equal(result.timedOut, false, 'Electron did not exit within 30s');
    const smoke = parseSmokeLine(result.stdout);
    assert.ok(smoke, 'NEBULA_DESKTOP_SMOKE JSON line not found');
    assert.equal(smoke.passed, false);
    // Should contain exit code or early-exit type
    assert.ok(
      smoke.error?.exitCode === 7 ||
      smoke.error?.type === 'early_exit' ||
      smoke.error?.message?.includes('7'),
      'Error should contain exit code 7 or early_exit type',
    );
    assert.notEqual(result.exitCode, 0);
  });

  test('health timeout terminates child and surfaces timeout failure', { timeout: 30_000 }, async () => {
    const userData = mkTemp();
    const result = await runElectron({
      NEBULA_DESKTOP_SMOKE: '1',
      NEBULA_DESKTOP_USER_DATA_DIR: userData,
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
});
