/**
 * Electron-free, dependency-injected FastAPI sidecar lifecycle module.
 *
 * Owns Python runtime resolution, loopback ephemeral-port allocation,
 * uvicorn spawn arguments, bounded diagnostic capture, health polling,
 * failure reporting, port-collision retry, and SIGTERM/SIGKILL shutdown.
 *
 * Does NOT import Electron. Accepts injectable process/network/timer
 * dependencies so Node's built-in test runner can verify lifecycle behavior
 * deterministically without launching real Python (except for the cold-start
 * integration test).
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Published constants
// ---------------------------------------------------------------------------

/** Production health readiness budget in milliseconds. */
export const HEALTH_TIMEOUT_MS = 60_000;

/** Grace period (ms) after SIGTERM before escalating to SIGKILL. */
export const GRACE_PERIOD_MS = 5_000;

/** Maximum time (ms) to wait for exit after SIGKILL. */
export const KILL_BUDGET_MS = 2_000;

/** Maximum port-allocation retry attempts on collision. */
export const MAX_PORT_RETRIES = 3;

/** Maximum retained diagnostic bytes (tail only). */
export const DIAGNOSTIC_TAIL_BYTES = 8_192;

/** Maximum retained diagnostic lines (tail only). */
export const MAX_DIAGNOSTIC_LINES = 50;

/** Interval between health polls (ms). */
const POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// SidecarError
// ---------------------------------------------------------------------------

export class SidecarError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SidecarError';
    this.type = details.type ?? 'unknown';
    this.python = details.python;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.diagnostics = details.diagnostics;
    this.port = details.port;
    this.attempts = details.attempts;
  }
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /api_key\s*=\s*[^\s&]+/gi,
];

/**
 * Redact credential-shaped substrings from diagnostic text.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeText(text) {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Truncate diagnostic text to a bounded tail (by bytes then lines).
 * @param {string} text
 * @param {number} [maxBytes]
 * @param {number} [maxLines]
 * @returns {string}
 */
export function boundDiagnostics(
  text,
  maxBytes = DIAGNOSTIC_TAIL_BYTES,
  maxLines = MAX_DIAGNOSTIC_LINES,
) {
  let result = text;
  const buf = Buffer.from(result, 'utf8');
  if (buf.length > maxBytes) {
    result = buf.subarray(buf.length - maxBytes).toString('utf8');
    const nl = result.indexOf('\n');
    if (nl >= 0) result = result.slice(nl + 1);
  }
  const lines = result.split('\n');
  if (lines.length > maxLines) {
    result = lines.slice(-maxLines).join('\n');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bounded diagnostic buffer (rolling tail)
// ---------------------------------------------------------------------------

class DiagnosticBuffer {
  constructor(maxBytes = DIAGNOSTIC_TAIL_BYTES, maxLines = MAX_DIAGNOSTIC_LINES) {
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
    /** @type {Buffer[]} */
    this.chunks = [];
    this.totalLength = 0;
  }

  append(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.chunks.push(buf);
    this.totalLength += buf.length;
    while (this.totalLength > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      this.totalLength -= removed.length;
    }
  }

  getText() {
    let text = Buffer.concat(this.chunks).toString('utf8');
    const lines = text.split('\n');
    if (lines.length > this.maxLines) {
      text = lines.slice(-this.maxLines).join('\n');
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// Python runtime resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Python executable path.
 *
 * NEBULA_DESKTOP_PYTHON override is checked first (must exist and be
 * executable). Falls back to the repo-local
 * `backend/.venv/bin/python` — never via shell activation or PATH.
 *
 * @param {Record<string,string>} env
 * @param {string} repoRoot
 * @param {{statSync?: typeof statSync}} [deps]
 * @returns {string} absolute Python path
 * @throws {SidecarError} when override is missing or non-executable
 */
export function resolvePython(env, repoRoot, deps = {}) {
  const statFn = deps.statSync ?? statSync;
  const override = env?.NEBULA_DESKTOP_PYTHON;
  const fallback = join(repoRoot, 'backend', '.venv', 'bin', 'python');

  if (override) {
    try {
      const stat = statFn(override);
      if (!stat.isFile()) {
        throw new Error('path is not a regular file');
      }
      if (!(stat.mode & 0o111)) {
        throw new Error('path is not executable');
      }
    } catch (err) {
      if (err instanceof SidecarError) throw err;
      throw new SidecarError(
        `NEBULA_DESKTOP_PYTHON is invalid: ${resolve(override)}\n` +
          `${err.message}.\n` +
          `Remediation: correct the NEBULA_DESKTOP_PYTHON override or ` +
          `restore the verified runtime at ${fallback} ` +
          `(cd backend && python3 -m venv .venv && ` +
          `.venv/bin/pip install -r requirements.txt).`,
        { type: 'invalid_python', python: resolve(override) },
      );
    }
    return resolve(override);
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

/**
 * Allocate an OS-assigned ephemeral port on 127.0.0.1.
 *
 * Binds to port 0, reads the assigned port, closes the server, and returns
 * the port number.
 *
 * @param {{createServer?: typeof createServer}} [deps]
 * @returns {Promise<number>}
 */
export async function allocatePort(deps = {}) {
  const createServerFn = deps.createServer ?? createServer;
  const server = createServerFn();
  return new Promise((resolveP, rejectP) => {
    server.on('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr.port;
      server.close(() => resolveP(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Health validation
// ---------------------------------------------------------------------------

function isNebulaHealth(body) {
  return (
    body != null &&
    typeof body === 'object' &&
    body.status === 'ok' &&
    body.app === 'nebula' &&
    typeof body.version === 'string' &&
    body.version.length > 0
  );
}

function isPortCollision(text) {
  return /address already in use|EADDRINUSE/i.test(text);
}

// ---------------------------------------------------------------------------
// Start sidecar
// ---------------------------------------------------------------------------

/**
 * Start the managed FastAPI sidecar.
 *
 * Resolves Python, allocates an OS-assigned loopback port, spawns exactly one
 * `<python> -m uvicorn main:app --host 127.0.0.1 --port <port>` child from
 * `backend/`, polls `/api/health` until the Nebula identity is confirmed or
 * the budget expires, and returns a handle.
 *
 * @param {object} [options]
 * @param {object} [options.deps] — injectable dependencies for testing
 * @param {Record<string,string>} [options.env] — environment for the child
 * @param {string} [options.repoRoot] — repository root path
 * @param {number} [options.healthTimeoutMs] — override health timeout
 * @returns {Promise<SidecarHandle>}
 * @throws {SidecarError}
 */
export async function startSidecar(options = {}) {
  const deps = options.deps ?? {};
  const {
    spawn: spawnFn = spawn,
    createServer: createServerFn = createServer,
    fetch: fetchFn,
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    statSync: statSyncFn = statSync,
  } = deps;

  const resolvedFetch = fetchFn ?? globalThis.fetch?.bind(globalThis);
  if (!resolvedFetch) {
    throw new SidecarError('No fetch implementation available', {
      type: 'no_fetch',
    });
  }

  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const backendDir = join(repoRoot, 'backend');
  const healthTimeoutMs =
    options.healthTimeoutMs ??
    (parseInt(env.NEBULA_DESKTOP_HEALTH_TIMEOUT_MS, 10) || HEALTH_TIMEOUT_MS);

  // 1. Resolve Python (throws before any spawn if invalid)
  const pythonPath = resolvePython(env, repoRoot, { statSync: statSyncFn });

  // 2. Allocate port and spawn with bounded retry
  let lastError;
  let totalAttempts = 0;

  for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
    totalAttempts = attempt + 1;
    const port = await allocatePort({ createServer: createServerFn });

    if (port >= 8000 && port <= 8010) {
      lastError = new SidecarError(
        `Allocated port ${port} falls in the reserved 8000-8010 range`,
        { type: 'port_reserved', port },
      );
      continue;
    }

    const argv = [
      pythonPath,
      '-m',
      'uvicorn',
      'main:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ];

    try {
      const result = await spawnAndAwaitHealth({
        spawnFn,
        fetchFn: resolvedFetch,
        setTimeoutFn,
        clearTimeoutFn,
        argv,
        cwd: backendDir,
        port,
        healthTimeoutMs,
        env,
        python: pythonPath,
      });
      result.attempts = totalAttempts;
      return result;
    } catch (err) {
      // Clean up any surviving child from this attempt
      killIfNeeded(err.child);

      const collision =
        err.type === 'port_collision' ||
        isPortCollision(err.diagnostics ?? '');

      if (collision) {
        // Always set lastError and continue; the loop exits naturally
        // when attempt exceeds MAX_PORT_RETRIES, then port_exhausted fires.
        lastError = err;
        continue;
      }
      err.attempts = totalAttempts;
      throw err;
    }
  }

  throw new SidecarError(
    `Sidecar startup failed: port allocation exhausted after ` +
      `${totalAttempts} attempts (max ${MAX_PORT_RETRIES} retries). ` +
      `Last error: ${lastError?.message ?? 'unknown'}`,
    { type: 'port_exhausted', attempts: totalAttempts },
  );
}

/**
 * @typedef {object} SidecarHandle
 * @property {number} pid
 * @property {number} port
 * @property {string} apiBaseUrl
 * @property {string} wsBaseUrl
 * @property {string} python
 * @property {string} cwd
 * @property {string[]} argv
 * @property {import('node:child_process').ChildProcess} child
 * @property {string} diagnostics
 * @property {number} attempts
 * @property {(deps?: object) => Promise<StopResult>} stop
 */

/**
 * @typedef {object} StopResult
 * @property {boolean} terminated
 * @property {string} [signal]
 * @property {number} port
 * @property {string[]} signals
 * @property {boolean} [alreadyExited]
 */

function killIfNeeded(child) {
  if (
    child &&
    child.exitCode === null &&
    child.signalCode === null &&
    typeof child.kill === 'function'
  ) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

async function spawnAndAwaitHealth(opts) {
  const {
    spawnFn,
    fetchFn,
    setTimeoutFn,
    clearTimeoutFn,
    argv,
    cwd,
    port,
    healthTimeoutMs,
    env,
    python,
  } = opts;

  const child = spawnFn(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const diagBuf = new DiagnosticBuffer();

  if (child.stdout) {
    child.stdout.on('data', (chunk) => diagBuf.append(chunk));
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => diagBuf.append(chunk));
  }

  return new Promise((resolveP, rejectP) => {
    let settled = false;
    let timeoutTimer = null;
    let pollTimer = null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeoutFn(timeoutTimer);
      if (pollTimer) clearTimeoutFn(pollTimer);
      timeoutTimer = null;
      pollTimer = null;
    };

    // Health timeout
    timeoutTimer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      cleanup();

      // Terminate the child: SIGTERM then SIGKILL after grace
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      const killTimer = setTimeoutFn(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, GRACE_PERIOD_MS);

      const diagnostics = sanitizeText(diagBuf.getText());
      rejectP(
        new SidecarError(
          `Sidecar health check timed out after ${healthTimeoutMs}ms ` +
            `on port ${port}. The backend did not report Nebula health ` +
            `within the budget.\nDiagnostics:\n${diagnostics}`,
          { type: 'health_timeout', port, diagnostics, child, python },
        ),
      );
    }, healthTimeoutMs);

    // Early exit
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      const diagnostics = sanitizeText(diagBuf.getText());

      if (isPortCollision(diagnostics)) {
        rejectP(
          new SidecarError(
            `Port ${port} was already in use`,
            {
              type: 'port_collision',
              port,
              exitCode: code,
              signal,
              diagnostics,
              child,
              python,
            },
          ),
        );
      } else {
        rejectP(
          new SidecarError(
            `Sidecar exited before becoming healthy ` +
              `(exit code: ${code}, signal: ${signal ?? 'none'}).\n` +
              `Attempted: ${argv.join(' ')}\n` +
              `Diagnostics:\n${diagnostics}`,
            {
              type: 'early_exit',
              port,
              exitCode: code,
              signal,
              diagnostics,
              child,
              python,
            },
          ),
        );
      }
    });

    // Spawn error
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      const diagnostics = sanitizeText(diagBuf.getText());
      rejectP(
        new SidecarError(
          `Failed to spawn sidecar: ${err.message}\n` +
            `Attempted: ${argv.join(' ')}\n` +
            `Diagnostics:\n${diagnostics}`,
          { type: 'spawn_error', port, diagnostics, child, python },
        ),
      );
    });

    // Health polling
    const pollHealth = async () => {
      if (settled) return;
      try {
        const response = await fetchFn(
          `http://127.0.0.1:${port}/api/health`,
          { cache: 'no-store' },
        );
        if (settled) return;

        if (response.ok) {
          let body;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (settled) return;

          if (isNebulaHealth(body)) {
            settled = true;
            cleanup();
            const diagnostics = sanitizeText(diagBuf.getText());
            resolveP({
              pid: child.pid,
              port,
              apiBaseUrl: `http://127.0.0.1:${port}`,
              wsBaseUrl: `ws://127.0.0.1:${port}`,
              python,
              cwd,
              argv,
              child,
              diagnostics,
              attempts: 0,
              stop: (stopDeps) => stopSidecar({ child, port }, stopDeps),
            });
            return;
          }
        }
      } catch {
        // Connection not ready yet — keep polling
      }

      if (!settled) {
        pollTimer = setTimeoutFn(pollHealth, POLL_INTERVAL_MS);
      }
    };

    pollTimer = setTimeoutFn(pollHealth, POLL_INTERVAL_MS);
  });
}

// ---------------------------------------------------------------------------
// Stop sidecar
// ---------------------------------------------------------------------------

/**
 * Stop the managed sidecar via SIGTERM, escalating to SIGKILL after a
 * bounded grace period.
 *
 * @param {SidecarHandle | {child: import('node:child_process').ChildProcess, port?: number}} handle
 * @param {object} [deps]
 * @returns {Promise<StopResult>}
 */
export async function stopSidecar(handle, deps = {}) {
  const {
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    gracePeriodMs = GRACE_PERIOD_MS,
    killBudgetMs = KILL_BUDGET_MS,
  } = deps;

  const child = handle.child ?? handle;
  const port = handle.port;
  const signals = [];

  // Already exited?
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { terminated: false, alreadyExited: true, port, signals };
  }

  // Send SIGTERM
  try {
    child.kill('SIGTERM');
    signals.push('SIGTERM');
  } catch {
    return { terminated: false, alreadyExited: true, port, signals };
  }

  // Wait for exit during grace period
  const exitedGraceful = await waitForExit(
    child,
    gracePeriodMs,
    setTimeoutFn,
    clearTimeoutFn,
  );

  if (exitedGraceful) {
    return { terminated: true, signal: 'SIGTERM', port, signals };
  }

  // Escalate to SIGKILL
  try {
    child.kill('SIGKILL');
    signals.push('SIGKILL');
  } catch {
    return { terminated: false, alreadyExited: true, port, signals };
  }

  // Wait for exit during kill budget
  const exitedKilled = await waitForExit(
    child,
    killBudgetMs,
    setTimeoutFn,
    clearTimeoutFn,
  );

  return {
    terminated: exitedKilled,
    signal: 'SIGKILL',
    port,
    signals,
  };
}

function waitForExit(child, timeoutMs, setTimeoutFn, clearTimeoutFn) {
  return new Promise((resolveP) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveP(true);
      return;
    }

    let timer = null;
    const onExit = () => {
      if (timer) clearTimeoutFn(timer);
      child.removeListener('exit', onExit);
      resolveP(true);
    };

    timer = setTimeoutFn(() => {
      child.removeListener('exit', onExit);
      resolveP(false);
    }, timeoutMs);

    child.on('exit', onExit);
  });
}
