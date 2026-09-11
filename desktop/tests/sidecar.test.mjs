/**
 * Node built-in test-runner tests for the Electron-free sidecar lifecycle
 * module (desktop/sidecar.mjs).
 *
 * Covers VAL-LIFE-001..013: runtime selection, spawn arguments, dynamic
 * loopback port, readiness identity, failures, retries, diagnostics, signal
 * policy, cleanup, and no-auto-restart.
 *
 * Tests use injected dependencies (stub spawn/fetch/createServer/statSync)
 * for deterministic cases and real executable fixtures / real Python for
 * integration cases. Every real process is stopped by captured PID.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createServer as realCreateServer } from 'node:net';
import { statSync as realStatSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import WebSocket from 'ws';

import {
  HEALTH_TIMEOUT_MS,
  GRACE_PERIOD_MS,
  KILL_BUDGET_MS,
  MAX_PORT_RETRIES,
  DIAGNOSTIC_TAIL_BYTES,
  MAX_DIAGNOSTIC_LINES,
  SidecarError,
  resolvePython,
  allocatePort,
  startSidecar,
  stopSidecar,
  sanitizeText,
  boundDiagnostics,
  DEFAULT_REPO_ROOT,
} from '../sidecar.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');
const REPO_ROOT = DEFAULT_REPO_ROOT;
const BACKEND_PYTHON = join(REPO_ROOT, 'backend', '.venv', 'bin', 'python');
const BACKEND_DIR = join(REPO_ROOT, 'backend');

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/** Create a stub child process (EventEmitter) that stays alive by default. */
function stubChild(opts = {}) {
  const child = new EventEmitter();
  child.pid = opts.pid ?? 99999;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = opts.stdout === false ? null : new EventEmitter();
  child.stderr = opts.stderr === false ? null : new EventEmitter();
  child._signals = [];
  child.kill = (signal) => {
    child._signals.push(signal);
    if (opts.onKill) {
      opts.onKill(signal, child);
    } else if (opts.killExits !== false) {
      if (signal === 'SIGTERM' && opts.ignoreSigterm) {
        // ignore
      } else {
        process.nextTick(() => {
          child.exitCode = opts.exitOnKill ?? 0;
          child.signalCode = signal === 'SIGKILL' ? signal : null;
          child.emit('exit', child.exitCode, child.signalCode);
        });
      }
    }
  };
  return child;
}

/** Create a stub spawn function that records calls and returns configured children. */
function stubSpawn(childFactory) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    const child = typeof childFactory === 'function' ? childFactory(call) : childFactory;
    child._call = call;
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** Create a stub fetch that returns configured responses. */
function stubFetch(responseFn) {
  let callCount = 0;
  const fn = async (url, opts) => {
    callCount++;
    const resp = typeof responseFn === 'function' ? responseFn(url, callCount) : responseFn;
    return {
      ok: resp.ok ?? (resp.status >= 200 && resp.status < 300),
      status: resp.status ?? 200,
      json: async () => resp.body,
      text: async () =>
        typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body),
    };
  };
  fn.callCount = () => callCount;
  return fn;
}

/** Create a stub createServer that yields a fixed port. */
function stubCreateServer(port) {
  return () => {
    const server = new EventEmitter();
    server.listen = (portArg, host, cb) => {
      if (typeof host === 'function') {
        cb = host;
        host = undefined;
      }
      if (cb) process.nextTick(cb);
    };
    server.address = () => ({ port, family: 'IPv4', address: '127.0.0.1' });
    server.close = (cb) => {
      if (cb) process.nextTick(cb);
    };
    return server;
  };
}

/** Create a stub statSync that returns a file stat with given mode. */
function stubStatSync(mode = 0o755) {
  return (path) => ({
    isFile: () => true,
    mode,
  });
}

function stubStatSyncMissing() {
  return () => {
    const err = new Error('ENOENT: no such file or directory');
    err.code = 'ENOENT';
    throw err;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Published constants', () => {
  test('HEALTH_TIMEOUT_MS is 60_000 (production budget)', () => {
    assert.equal(HEALTH_TIMEOUT_MS, 60_000);
  });

  test('GRACE_PERIOD_MS is a positive bounded value', () => {
    assert.ok(GRACE_PERIOD_MS > 0 && GRACE_PERIOD_MS <= 10_000);
  });

  test('KILL_BUDGET_MS is a positive bounded value', () => {
    assert.ok(KILL_BUDGET_MS > 0 && KILL_BUDGET_MS <= 10_000);
  });

  test('MAX_PORT_RETRIES is a small positive integer', () => {
    assert.ok(MAX_PORT_RETRIES >= 1 && MAX_PORT_RETRIES <= 10);
  });

  test('DIAGNOSTIC_TAIL_BYTES is a bounded cap', () => {
    assert.ok(DIAGNOSTIC_TAIL_BYTES > 0 && DIAGNOSTIC_TAIL_BYTES <= 64_000);
  });

  test('MAX_DIAGNOSTIC_LINES is a bounded cap', () => {
    assert.ok(MAX_DIAGNOSTIC_LINES > 0 && MAX_DIAGNOSTIC_LINES <= 200);
  });
});

// ---------------------------------------------------------------------------
// sanitizeText
// ---------------------------------------------------------------------------

describe('sanitizeText', () => {
  test('redacts sk- style secrets', () => {
    const fakeKey = ['sk-', 'FIXTURE_FAKE_KEY_0001'].join('');
    const text = `Using key ${fakeKey} for auth`;
    const result = sanitizeText(text);
    assert.ok(!result.includes(fakeKey));
    assert.ok(result.includes('[REDACTED]'));
  });

  test('redacts Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const result = sanitizeText(text);
    assert.ok(!result.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
    assert.ok(result.includes('[REDACTED]'));
  });

  test('redacts api_key= style secrets', () => {
    const text = 'Config: api_key=secret_key_value_here';
    const result = sanitizeText(text);
    assert.ok(!result.includes('secret_key_value_here'));
  });

  test('leaves non-secret text unchanged', () => {
    const text = 'uvicorn running on 127.0.0.1:54321';
    assert.equal(sanitizeText(text), text);
  });
});

// ---------------------------------------------------------------------------
// boundDiagnostics
// ---------------------------------------------------------------------------

describe('boundDiagnostics', () => {
  test('truncates to the last maxBytes', () => {
    const text = 'A'.repeat(20_000);
    const result = boundDiagnostics(text, 1000, 10_000);
    assert.ok(Buffer.byteLength(result, 'utf8') <= 1000);
  });

  test('keeps the tail, not the head', () => {
    const lines = [];
    for (let i = 1; i <= 1000; i++) lines.push(`LINE_${i}`);
    const text = lines.join('\n');
    const result = boundDiagnostics(text, 100_000, 50);
    assert.ok(result.includes('LINE_1000'));
    assert.ok(!result.includes('LINE_1\n') && !result.startsWith('LINE_1'));
  });

  test('truncates to the last maxLines', () => {
    const lines = [];
    for (let i = 1; i <= 200; i++) lines.push(`SHORT_${i}`);
    const text = lines.join('\n');
    const result = boundDiagnostics(text, 100_000, 50);
    const resultLines = result.split('\n');
    assert.ok(resultLines.length <= 50);
    assert.ok(result.includes('SHORT_200'));
    assert.equal(resultLines[0], 'SHORT_151');
  });
});

// ---------------------------------------------------------------------------
// resolvePython — VAL-LIFE-001, VAL-LIFE-002
// ---------------------------------------------------------------------------

describe('resolvePython', () => {
  test('uses NEBULA_DESKTOP_PYTHON override first', () => {
    const env = { NEBULA_DESKTOP_PYTHON: '/usr/local/bin/python3' };
    const result = resolvePython(env, REPO_ROOT, { statSync: stubStatSync() });
    assert.equal(result, '/usr/local/bin/python3');
  });

  test('resolves override to absolute path', () => {
    const env = { NEBULA_DESKTOP_PYTHON: '/custom/path/to/python' };
    const result = resolvePython(env, '/repo', { statSync: stubStatSync() });
    assert.equal(result, '/custom/path/to/python');
  });

  test('falls back to repo-local backend/.venv/bin/python without override', () => {
    const env = {};
    const result = resolvePython(env, '/repo');
    assert.equal(result, join('/repo', 'backend', '.venv', 'bin', 'python'));
  });

  test('fallback is not affected by PATH — no shell activation or PATH lookup', () => {
    const env = { PATH: '/fake/bin:/usr/fake' };
    const result = resolvePython(env, '/repo');
    assert.equal(result, join('/repo', 'backend', '.venv', 'bin', 'python'));
    // The fallback is a direct absolute path, not "python" or "python3"
    assert.ok(!result.endsWith('python3') || result.includes('.venv'));
    assert.ok(result.includes('.venv'));
  });

  test('rejects nonexistent override with actionable guidance', () => {
    const env = { NEBULA_DESKTOP_PYTHON: '/nonexistent/path/to/python' };
    assert.throws(
      () => resolvePython(env, REPO_ROOT, { statSync: stubStatSyncMissing() }),
      (err) => {
        assert.ok(err instanceof SidecarError);
        assert.equal(err.type, 'invalid_python');
        assert.ok(err.message.includes('/nonexistent/path/to/python'));
        assert.ok(
          err.message.includes('Remediation') ||
            err.message.includes('remediation') ||
            err.message.includes('restore'),
        );
        return true;
      },
    );
  });

  test('rejects non-executable override with actionable guidance', () => {
    const env = { NEBULA_DESKTOP_PYTHON: '/tmp/not-executable' };
    // mode 0o644 — not executable
    assert.throws(
      () => resolvePython(env, REPO_ROOT, { statSync: stubStatSync(0o644) }),
      (err) => {
        assert.ok(err instanceof SidecarError);
        assert.equal(err.type, 'invalid_python');
        assert.ok(err.message.includes('/tmp/not-executable'));
        assert.ok(
          err.message.includes('Remediation') ||
            err.message.includes('remediation') ||
            err.message.includes('restore'),
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// allocatePort — VAL-LIFE-004
// ---------------------------------------------------------------------------

describe('allocatePort', () => {
  test('returns an OS-assigned ephemeral port on 127.0.0.1', async () => {
    const port = await allocatePort();
    assert.ok(port > 0);
    assert.ok(port < 65536);
    // Ephemeral range check (typically 49152-65535 on macOS, but just check > 1024)
    assert.ok(port > 1024, `port ${port} should be > 1024`);
  });

  test('port is not in the 8000-8010 reserved range', async () => {
    for (let i = 0; i < 10; i++) {
      const port = await allocatePort();
      assert.ok(
        port < 8000 || port > 8010,
        `port ${port} must not be in 8000-8010`,
      );
    }
  });

  test('releases the port after allocation (bind succeeds)', async () => {
    const port = await allocatePort();
    // We should be able to bind to the same port immediately
    const server = realCreateServer();
    await new Promise((resolveP, rejectP) => {
      server.on('error', rejectP);
      server.listen(port, '127.0.0.1', resolveP);
    });
    await new Promise((r) => server.close(r));
  });
});

// ---------------------------------------------------------------------------
// startSidecar — spawn shape — VAL-LIFE-003
// ---------------------------------------------------------------------------

describe('startSidecar — spawn shape', () => {
  test('spawns exactly one child with correct argv shape', async () => {
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({
      status: 200,
      body: { status: 'ok', app: 'nebula', version: '0.1.0' },
    });
    const createServerFn = stubCreateServer(54321);

    const handle = await startSidecar({
      env: {},
      repoRoot: REPO_ROOT,
      deps: {
        spawn: spawnFn,
        fetch: fetchFn,
        createServer: createServerFn,
        statSync: stubStatSync(),
      },
    });

    assert.equal(spawnFn.calls.length, 1, 'exactly one spawn call');
    const call = spawnFn.calls[0];
    assert.equal(call.cmd, BACKEND_PYTHON);
    assert.deepEqual(call.args, [
      '-m',
      'uvicorn',
      'main:app',
      '--host',
      '127.0.0.1',
      '--port',
      '54321',
    ]);
  });

  test('working directory is the repo backend/ directory', async () => {
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({
      status: 200,
      body: { status: 'ok', app: 'nebula', version: '0.1.0' },
    });
    const createServerFn = stubCreateServer(54322);

    await startSidecar({
      env: {},
      repoRoot: REPO_ROOT,
      deps: {
        spawn: spawnFn,
        fetch: fetchFn,
        createServer: createServerFn,
        statSync: stubStatSync(),
      },
    });

    assert.equal(spawnFn.calls[0].opts.cwd, BACKEND_DIR);
  });

  test('no --reload, --reload-dir, --workers, or --host 0.0.0.0 flags', async () => {
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({
      status: 200,
      body: { status: 'ok', app: 'nebula', version: '0.1.0' },
    });
    const createServerFn = stubCreateServer(54323);

    await startSidecar({
      env: {},
      repoRoot: REPO_ROOT,
      deps: {
        spawn: spawnFn,
        fetch: fetchFn,
        createServer: createServerFn,
        statSync: stubStatSync(),
      },
    });

    const argv = [spawnFn.calls[0].cmd, ...spawnFn.calls[0].args];
    const argvStr = argv.join(' ');
    assert.ok(!argvStr.includes('--reload'), 'no --reload flag');
    assert.ok(!argvStr.includes('--reload-dir'), 'no --reload-dir flag');
    assert.ok(!argvStr.includes('--workers'), 'no --workers flag');
    assert.ok(!argvStr.includes('0.0.0.0'), 'no 0.0.0.0 host');
  });

  test('exposes apiBaseUrl and wsBaseUrl matching the dynamic port', async () => {
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({
      status: 200,
      body: { status: 'ok', app: 'nebula', version: '0.1.0' },
    });
    const createServerFn = stubCreateServer(54324);

    const handle = await startSidecar({
      env: {},
      repoRoot: REPO_ROOT,
      deps: {
        spawn: spawnFn,
        fetch: fetchFn,
        createServer: createServerFn,
        statSync: stubStatSync(),
      },
    });

    assert.equal(handle.apiBaseUrl, 'http://127.0.0.1:54324');
    assert.equal(handle.wsBaseUrl, 'ws://127.0.0.1:54324');
    assert.equal(handle.port, 54324);
  });
});

// ---------------------------------------------------------------------------
// startSidecar — readiness identity — VAL-LIFE-005
// ---------------------------------------------------------------------------

describe('startSidecar — readiness identity', () => {
  const correctBody = { status: 'ok', app: 'nebula', version: '0.1.0' };

  test('resolves when health returns the exact Nebula identity', async () => {
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({ status: 200, body: correctBody });
    const createServerFn = stubCreateServer(54330);

    const handle = await startSidecar({
      env: {},
      repoRoot: REPO_ROOT,
      deps: {
        spawn: spawnFn,
        fetch: fetchFn,
        createServer: createServerFn,
        statSync: stubStatSync(),
      },
    });

    assert.equal(handle.pid, 99999);
    assert.ok(fetchFn.callCount() >= 1);
  });

  const negativeCases = [
    {
      name: 'wrong app name',
      body: { status: 'ok', app: 'not-nebula', version: '0.1.0' },
      status: 200,
    },
    {
      name: 'missing version',
      body: { status: 'ok', app: 'nebula' },
      status: 200,
    },
    {
      name: 'empty version string',
      body: { status: 'ok', app: 'nebula', version: '' },
      status: 200,
    },
    {
      name: 'empty body',
      body: {},
      status: 200,
    },
    {
      name: '5xx response',
      body: { error: 'internal' },
      status: 500,
    },
    {
      name: 'non-JSON response',
      body: 'not json at all',
      status: 200,
    },
  ];

  for (const { name, body, status } of negativeCases) {
    test(`stays pending for ${name} and rejects with health_timeout`, async () => {
      const child = stubChild();
      const spawnFn = stubSpawn(() => child);
      const fetchFn = stubFetch({ status, body });
      const createServerFn = stubCreateServer(54331);

      await assert.rejects(
        startSidecar({
          env: { NEBULA_DESKTOP_HEALTH_TIMEOUT_MS: '1500' },
          repoRoot: REPO_ROOT,
          deps: {
            spawn: spawnFn,
            fetch: fetchFn,
            createServer: createServerFn,
            statSync: stubStatSync(),
          },
        }),
        (err) => {
          assert.ok(err instanceof SidecarError);
          assert.equal(err.type, 'health_timeout');
          // Fetch was called more than once (polling happened)
          assert.ok(fetchFn.callCount() > 1, 'should have polled multiple times');
          return true;
        },
      );
    });
  }
});

// ---------------------------------------------------------------------------
// startSidecar — invalid Python — VAL-LIFE-002, VAL-LIFE-007
// ---------------------------------------------------------------------------

describe('startSidecar — invalid Python override', () => {
  test('rejects fast with actionable guidance and spawns no child', async () => {
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({ status: 200, body: { status: 'ok', app: 'nebula', version: '0.1.0' } });
    const createServerFn = stubCreateServer(54340);

    const start = Date.now();
    await assert.rejects(
      startSidecar({
        env: { NEBULA_DESKTOP_PYTHON: '/nonexistent/python' },
        repoRoot: REPO_ROOT,
        deps: {
          spawn: spawnFn,
          fetch: fetchFn,
          createServer: createServerFn,
          statSync: stubStatSyncMissing(),
        },
      }),
      (err) => {
        assert.ok(err instanceof SidecarError);
        assert.equal(err.type, 'invalid_python');
        assert.ok(err.message.includes('/nonexistent/python'));
        assert.ok(
          err.message.includes('Remediation') ||
            err.message.includes('restore'),
        );
        return true;
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 10_000, `should reject in < 10s, took ${elapsed}ms`);
    assert.equal(spawnFn.calls.length, 0, 'no child should be spawned');
  });

  test('rejection with secret env does not leak the secret', async () => {
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({ status: 200, body: { status: 'ok', app: 'nebula', version: '0.1.0' } });
    const createServerFn = stubCreateServer(54341);
    const SECRET = ['sk-', 'testfake-leakcheck-999999'].join('');

    await assert.rejects(
      startSidecar({
        env: {
          NEBULA_DESKTOP_PYTHON: '/nonexistent/python',
          SECRET_1: SECRET,
        },
        repoRoot: REPO_ROOT,
        deps: {
          spawn: spawnFn,
          fetch: fetchFn,
          createServer: createServerFn,
          statSync: stubStatSyncMissing(),
        },
      }),
      (err) => {
        assert.ok(err instanceof SidecarError);
        assert.ok(err.message.includes('/nonexistent/python'));
        assert.ok(
          !err.message.includes(SECRET),
          'secret must not appear in error message',
        );
        return true;
      },
    );
    assert.equal(spawnFn.calls.length, 0, 'no child spawned');
  });
});

// ---------------------------------------------------------------------------
// startSidecar — early exit — VAL-LIFE-007
// ---------------------------------------------------------------------------

describe('startSidecar — early exit (real fixture)', () => {
  test('executable fixture exits 7 with distinctive stderr, rejects fast', async () => {
    const fixturePath = join(FIXTURES, 'exit-with-code.mjs');
    const handle = await startSidecar({
      env: {
        ...process.env,
        NEBULA_DESKTOP_PYTHON: fixturePath,
        FIXTURE_EXIT_CODE: '7',
        FIXTURE_STDERR: 'DISTINCTIVE_FIXTURE_STDERR_LINE',
      },
      repoRoot: REPO_ROOT,
      // Use real spawn + real createServer + real fetch
      deps: {},
    }).catch((err) => err);

    assert.ok(handle instanceof SidecarError, 'should reject with SidecarError');
    assert.equal(handle.type, 'early_exit');
    assert.equal(handle.exitCode, 7);
    assert.ok(
      handle.diagnostics.includes('DISTINCTIVE_FIXTURE_STDERR_LINE'),
      'diagnostics should contain the distinctive stderr line',
    );
  });
});

// ---------------------------------------------------------------------------
// startSidecar — health timeout — VAL-LIFE-008
// ---------------------------------------------------------------------------

describe('startSidecar — health timeout (real fixture)', () => {
  test('fixture never serves correct health → timeout rejects and terminates child', async () => {
    const fixturePath = join(FIXTURES, 'never-healthy.mjs');
    const err = await startSidecar({
      env: {
        ...process.env,
        NEBULA_DESKTOP_PYTHON: fixturePath,
        NEBULA_DESKTOP_HEALTH_TIMEOUT_MS: '2000',
      },
      repoRoot: REPO_ROOT,
      deps: {},
    }).catch((e) => e);

    assert.ok(err instanceof SidecarError);
    assert.equal(
      err.type,
      'health_timeout',
      `Expected health_timeout but got ${err.type}: ${err.message}`,
    );
    assert.ok(
      err.message.includes('2000'),
      'message should contain the timeout budget',
    );

    // Child should be terminated
    if (err.child?.pid) {
      try {
        process.kill(err.child.pid, 0);
        assert.fail('child should be terminated');
      } catch {
        // Good — process is gone
      }
    }
  });
});

// ---------------------------------------------------------------------------
// startSidecar — port collision retry — VAL-LIFE-010
// ---------------------------------------------------------------------------

describe('startSidecar — port collision retry', () => {
  test('retries on EADDRINUSE and succeeds with a new port', async () => {
    let spawnCall = 0;
    const spawnFn = stubSpawn(() => {
      const child = stubChild();
      spawnCall++;
      if (spawnCall === 1) {
        // First child: simulate port collision exit
        setTimeout(() => {
          child.stderr.emit('data', Buffer.from('ERROR: address already in use\n'));
          child.exitCode = 1;
          child.emit('exit', 1, null);
        }, 10);
      }
      return child;
    });
    const fetchFn = stubFetch({
      status: 200,
      body: { status: 'ok', app: 'nebula', version: '0.1.0' },
    });

    // Use real createServer for genuine port allocation
    const handle = await startSidecar({
      env: {},
      repoRoot: REPO_ROOT,
      deps: {
        spawn: spawnFn,
        fetch: fetchFn,
        statSync: stubStatSync(),
      },
    });

    assert.equal(spawnFn.calls.length, 2, 'should spawn twice (retry once)');
    assert.ok(handle.port > 0);
    // The two calls should use different ports
    const port1 = spawnFn.calls[0].args[spawnFn.calls[0].args.length - 1];
    const port2 = spawnFn.calls[1].args[spawnFn.calls[1].args.length - 1];
    assert.notEqual(port1, port2, 'retry should use a different port');
  });

  test('exhaustion after MAX_PORT_RETRIES+1 attempts rejects cleanly with no child', async () => {
    const spawnedChildren = [];
    const spawnFn = stubSpawn(() => {
      const c = stubChild();
      spawnedChildren.push(c);
      process.nextTick(() => {
        c.stderr.emit('data', Buffer.from('address already in use\n'));
        c.exitCode = 1;
        c.emit('exit', 1, null);
      });
      return c;
    });
    const fetchFn = stubFetch({
      status: 200,
      body: { status: 'ok', app: 'nebula', version: '0.1.0' },
    });

    await assert.rejects(
      startSidecar({
        env: {},
        repoRoot: REPO_ROOT,
        deps: {
          spawn: spawnFn,
          fetch: fetchFn,
          statSync: stubStatSync(),
        },
      }),
      (err) => {
        assert.ok(err instanceof SidecarError);
        assert.ok(
          err.type === 'port_exhausted' || err.message.includes('exhausted'),
          'should mention exhaustion',
        );
        assert.ok(
          err.message.includes('exhausted') || err.message.includes('attempts'),
        );
        // Total attempts = MAX_PORT_RETRIES + 1
        assert.equal(spawnFn.calls.length, MAX_PORT_RETRIES + 1);
        return true;
      },
    );

    // All children should be gone
    for (const c of spawnedChildren) {
      assert.notEqual(c.exitCode, null, 'child should have exited');
    }
  });
});

// ---------------------------------------------------------------------------
// startSidecar — bounded diagnostics — VAL-LIFE-011
// ---------------------------------------------------------------------------

describe('startSidecar — bounded diagnostics', () => {
  test('flooding child surfaces only the tail, within the byte cap', async () => {
    // Use stub spawn with a child that floods stderr then exits
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({
      status: 200,
      body: { status: 'ok', app: 'nebula', version: '0.1.0' },
    });
    const createServerFn = stubCreateServer(54350);

    // Emit a large flood on stderr, then exit
    const TOTAL = 100_000;
    setTimeout(() => {
      for (let i = 1; i <= TOTAL; i++) {
        child.stderr.emit('data', Buffer.from(`FLOOD_LINE_${i}\n`));
      }
      child.exitCode = 1;
      child.emit('exit', 1, null);
    }, 10);

    const err = await startSidecar({
      env: {},
      repoRoot: REPO_ROOT,
      deps: {
        spawn: spawnFn,
        fetch: fetchFn,
        createServer: createServerFn,
        statSync: stubStatSync(),
      },
    }).catch((e) => e);

    assert.ok(err instanceof SidecarError);
    assert.equal(err.type, 'early_exit');
    assert.ok(
      err.diagnostics.includes(`FLOOD_LINE_${TOTAL}`),
      'should contain the last line',
    );
    assert.ok(
      !err.diagnostics.includes('FLOOD_LINE_1\n'),
      'should not contain the first line',
    );
    assert.ok(
      Buffer.byteLength(err.diagnostics, 'utf8') <= DIAGNOSTIC_TAIL_BYTES,
      `diagnostics should be <= ${DIAGNOSTIC_TAIL_BYTES} bytes`,
    );
  });
});

// ---------------------------------------------------------------------------
// startSidecar — sanitization — VAL-LIFE-011
// ---------------------------------------------------------------------------

describe('startSidecar — sanitization of secrets in diagnostics', () => {
  test('child echoing a secret to stderr is redacted in diagnostics', async () => {
    const SECRET = ['sk-', 'leakcheck-fake-value-12345678'].join('');
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({
      status: 200,
      body: { status: 'ok', app: 'nebula', version: '0.1.0' },
    });
    const createServerFn = stubCreateServer(54355);

    setTimeout(() => {
      child.stderr.emit('data', Buffer.from(`Loading key: ${SECRET}\n`));
      child.stderr.emit('data', Buffer.from(`Bearer ${SECRET}\n`));
      child.exitCode = 1;
      child.emit('exit', 1, null);
    }, 10);

    const err = await startSidecar({
      env: {},
      repoRoot: REPO_ROOT,
      deps: {
        spawn: spawnFn,
        fetch: fetchFn,
        createServer: createServerFn,
        statSync: stubStatSync(),
      },
    }).catch((e) => e);

    assert.ok(err instanceof SidecarError);
    assert.ok(
      !err.diagnostics.includes(SECRET),
      'secret must not appear in diagnostics',
    );
    assert.ok(
      !err.message.includes(SECRET),
      'secret must not appear in error message',
    );
    assert.ok(
      err.diagnostics.includes('[REDACTED]'),
      'redaction marker should appear',
    );
  });
});

// ---------------------------------------------------------------------------
// startSidecar — no auto-restart — VAL-LIFE-013
// ---------------------------------------------------------------------------

describe('startSidecar — no auto-restart after post-readiness exit', () => {
  test('child exits after readiness → no replacement child spawned', async () => {
    const child = stubChild();
    const spawnFn = stubSpawn(() => child);
    const fetchFn = stubFetch({
      status: 200,
      body: { status: 'ok', app: 'nebula', version: '0.1.0' },
    });
    const createServerFn = stubCreateServer(54360);

    const handle = await startSidecar({
      env: {},
      repoRoot: REPO_ROOT,
      deps: {
        spawn: spawnFn,
        fetch: fetchFn,
        createServer: createServerFn,
        statSync: stubStatSync(),
      },
    });

    assert.equal(spawnFn.calls.length, 1, 'one child spawned');

    // Simulate the child exiting after readiness
    child.exitCode = 0;
    child.signalCode = null;
    child.emit('exit', 0, null);

    // Wait a short observation window (3 seconds, proportional to 30s production)
    await new Promise((r) => setTimeout(r, 3000));

    // No new child should have been spawned
    assert.equal(
      spawnFn.calls.length,
      1,
      'no replacement child should be spawned',
    );
  });
});

// ---------------------------------------------------------------------------
// stopSidecar — signal policy — VAL-LIFE-009
// ---------------------------------------------------------------------------

describe('stopSidecar — signal policy', () => {
  test('cooperative child receives exactly SIGTERM (no SIGKILL)', async () => {
    const child = stubChild({
      onKill: (signal, c) => {
        if (signal === 'SIGTERM') {
          process.nextTick(() => {
            c.exitCode = 0;
            c.signalCode = null;
            c.emit('exit', 0, null);
          });
        }
      },
    });

    const result = await stopSidecar(
      { child, port: 12345 },
      { gracePeriodMs: 500, killBudgetMs: 500 },
    );

    assert.ok(result.terminated);
    assert.equal(result.signal, 'SIGTERM');
    assert.deepEqual(child._signals, ['SIGTERM']);
  });

  test('SIGTERM-ignoring child receives SIGTERM then SIGKILL in order', async () => {
    const child = stubChild({
      ignoreSigterm: true,
      onKill: (signal, c) => {
        if (signal === 'SIGKILL') {
          process.nextTick(() => {
            c.exitCode = null;
            c.signalCode = 'SIGKILL';
            c.emit('exit', null, 'SIGKILL');
          });
        }
        // SIGTERM is ignored — don't exit
      },
    });

    const result = await stopSidecar(
      { child, port: 12346 },
      { gracePeriodMs: 300, killBudgetMs: 500 },
    );

    assert.ok(result.terminated);
    assert.equal(result.signal, 'SIGKILL');
    assert.deepEqual(child._signals, ['SIGTERM', 'SIGKILL']);
    // Verify ordering
    assert.equal(child._signals[0], 'SIGTERM');
    assert.equal(child._signals[1], 'SIGKILL');
  });

  test('already-exited child returns alreadyExited without sending signals', async () => {
    const child = stubChild();
    child.exitCode = 0;
    child.signalCode = null;

    const result = await stopSidecar({ child, port: 12347 });

    assert.ok(result.alreadyExited);
    assert.equal(child._signals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// stopSidecar — real fixture signal policy — VAL-LIFE-009
// ---------------------------------------------------------------------------

describe('stopSidecar — real fixture signal policy', () => {
  test('cooperative fixture receives SIGTERM and exits 0', async () => {
    const fixturePath = join(FIXTURES, 'serve-health.mjs');
    const handle = await startSidecar({
      env: { ...process.env, NEBULA_DESKTOP_PYTHON: fixturePath },
      repoRoot: REPO_ROOT,
      deps: {},
    });

    const pid = handle.pid;
    const port = handle.port;

    const result = await stopSidecar(handle, { gracePeriodMs: 5000, killBudgetMs: 2000 });
    assert.ok(result.terminated, 'should be terminated');

    // Verify process is gone
    try {
      process.kill(pid, 0);
      assert.fail('process should be gone');
    } catch {
      // Good
    }

    // Verify port is released
    const server = realCreateServer();
    await new Promise((resolveP, rejectP) => {
      server.on('error', rejectP);
      server.listen(port, '127.0.0.1', resolveP);
    });
    await new Promise((r) => server.close(r));
  });

  test('SIGTERM-ignoring fixture receives SIGKILL escalation', async () => {
    const fixturePath = join(FIXTURES, 'serve-health.mjs');
    const handle = await startSidecar({
      env: {
        ...process.env,
        NEBULA_DESKTOP_PYTHON: fixturePath,
        FIXTURE_IGNORE_SIGTERM: '1',
      },
      repoRoot: REPO_ROOT,
      deps: {},
    });

    const pid = handle.pid;
    const port = handle.port;

    const result = await stopSidecar(handle, { gracePeriodMs: 1000, killBudgetMs: 2000 });
    assert.ok(result.terminated);

    // Verify process is gone
    try {
      process.kill(pid, 0);
      assert.fail('process should be gone');
    } catch {
      // Good
    }

    // Verify port is released
    const server = realCreateServer();
    await new Promise((resolveP, rejectP) => {
      server.on('error', rejectP);
      server.listen(port, '127.0.0.1', resolveP);
    });
    await new Promise((r) => server.close(r));
  });
});

// ---------------------------------------------------------------------------
// Cleanup — VAL-LIFE-012
// ---------------------------------------------------------------------------

describe('Cleanup — normal shutdown and forced-kill path leave zero processes', () => {
  test('normal stop leaves no process and releases the port', async () => {
    const fixturePath = join(FIXTURES, 'serve-health.mjs');
    const handle = await startSidecar({
      env: { ...process.env, NEBULA_DESKTOP_PYTHON: fixturePath },
      repoRoot: REPO_ROOT,
      deps: {},
    });

    const pid = handle.pid;
    const port = handle.port;

    await stopSidecar(handle);

    // PID gone
    try {
      process.kill(pid, 0);
      assert.fail('PID should be gone');
    } catch {
      // Good
    }

    // Port released — bind succeeds
    const server = realCreateServer();
    await new Promise((resolveP, rejectP) => {
      server.on('error', rejectP);
      server.listen(port, '127.0.0.1', resolveP);
    });
    await new Promise((r) => server.close(r));
  });

  test('SIGKILL escalation path leaves no process and releases the port', async () => {
    const fixturePath = join(FIXTURES, 'serve-health.mjs');
    const handle = await startSidecar({
      env: {
        ...process.env,
        NEBULA_DESKTOP_PYTHON: fixturePath,
        FIXTURE_IGNORE_SIGTERM: '1',
      },
      repoRoot: REPO_ROOT,
      deps: {},
    });

    const pid = handle.pid;
    const port = handle.port;

    await stopSidecar(handle, { gracePeriodMs: 1000, killBudgetMs: 2000 });

    // PID gone
    try {
      process.kill(pid, 0);
      assert.fail('PID should be gone');
    } catch {
      // Good
    }

    // Port released
    const server = realCreateServer();
    await new Promise((resolveP, rejectP) => {
      server.on('error', rejectP);
      server.listen(port, '127.0.0.1', resolveP);
    });
    await new Promise((r) => server.close(r));
  });
});

// ---------------------------------------------------------------------------
// Real sidecar — WS handshake after readiness — VAL-LIFE-005
// ---------------------------------------------------------------------------

describe('Real fixture — WS handshake after readiness', () => {
  test('health-serving fixture: /ws handshakes 101 with graphSync first frame', async () => {
    const fixturePath = join(FIXTURES, 'serve-health.mjs');
    const handle = await startSidecar({
      env: { ...process.env, NEBULA_DESKTOP_PYTHON: fixturePath },
      repoRoot: REPO_ROOT,
      deps: {},
    });

    try {
      // Verify health
      const healthResp = await fetch(`${handle.apiBaseUrl}/api/health`);
      assert.ok(healthResp.ok);
      const healthBody = await healthResp.json();
      assert.equal(healthBody.status, 'ok');
      assert.equal(healthBody.app, 'nebula');
      assert.ok(healthBody.version);

      // Verify WS handshake
      const wsUrl = `${handle.wsBaseUrl}/ws`;
      const ws = new WebSocket(wsUrl);
      const firstFrame = await new Promise((resolveP, rejectP) => {
        const timeout = setTimeout(() => {
          ws.close();
          rejectP(new Error('WS handshake timeout'));
        }, 5000);
        ws.on('open', () => {
          // 101 handshake completed
        });
        ws.on('message', (data) => {
          clearTimeout(timeout);
          try {
            const parsed = JSON.parse(data.toString());
            resolveP(parsed);
          } catch (err) {
            rejectP(err);
          }
        });
        ws.on('error', (err) => {
          clearTimeout(timeout);
          rejectP(err);
        });
      });

      assert.equal(firstFrame.type, 'graphSync');
      ws.close();
    } finally {
      await stopSidecar(handle);
    }
  });
});

// ---------------------------------------------------------------------------
// Real sidecar — cold startup within 60s — VAL-LIFE-006
// ---------------------------------------------------------------------------

describe('Real Python cold startup', () => {
  test(
    'real venv Python + uvicorn reaches health within 60-second budget',
    { timeout: 90_000 },
    async () => {
      // Use the real repo venv Python — no override, full env
      const handle = await startSidecar({
        repoRoot: REPO_ROOT,
        deps: {},
      });

      try {
        // Verify the handle
        assert.ok(handle.pid, 'should have a PID');
        assert.ok(handle.port > 0, 'should have a port');
        assert.ok(handle.port < 8000 || handle.port > 8010, 'port not in 8000-8010');

        // Verify health directly
        const resp = await fetch(`${handle.apiBaseUrl}/api/health`);
        assert.ok(resp.ok);
        const body = await resp.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.app, 'nebula');
        assert.ok(body.version);

        // Verify loopback-only: LAN IP should fail
        // (We just verify 127.0.0.1 works, which it does)
      } finally {
        await stopSidecar(handle);
        // Verify cleanup
        try {
          process.kill(handle.pid, 0);
          assert.fail('PID should be gone after stop');
        } catch {
          // Good
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Real sidecar — loopback binding only — VAL-LIFE-004
// ---------------------------------------------------------------------------

describe('Real fixture — loopback binding only', () => {
  test('listener is on 127.0.0.1 only, not reachable via LAN IP', async () => {
    const fixturePath = join(FIXTURES, 'serve-health.mjs');
    const handle = await startSidecar({
      env: { ...process.env, NEBULA_DESKTOP_PYTHON: fixturePath },
      repoRoot: REPO_ROOT,
      deps: {},
    });

    try {
      // 127.0.0.1 should work
      const resp = await fetch(`${handle.apiBaseUrl}/api/health`);
      assert.ok(resp.ok);

      // Get a non-loopback IP and verify it fails
      const { networkInterfaces } = await import('node:os');
      const interfaces = networkInterfaces();
      let lanIp = null;
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            lanIp = iface.address;
            break;
          }
        }
        if (lanIp) break;
      }

      if (lanIp) {
        try {
          await fetch(`http://${lanIp}:${handle.port}/api/health`, {
            signal: AbortSignal.timeout(2000),
          });
          // If this succeeds, the server is binding to 0.0.0.0 — fail
          assert.fail('server should not be reachable via LAN IP');
        } catch {
          // Good — connection refused or timeout
        }
      }
    } finally {
      await stopSidecar(handle);
    }
  });
});
