/**
 * Node built-in test-runner tests for the App Support path migration module
 * (desktop/paths.mjs).
 *
 * Covers VAL-MIG-001, VAL-MIG-002, VAL-MIG-011:
 *   - App Support root computation
 *   - Subdirectory tree creation (state, output, characters, moodboards, presets)
 *   - NEBULA_* env var injection (all 6 vars pointing inside App Support)
 *   - Env vars do NOT point at legacy repo paths
 *   - process.env is NOT mutated (browser/dev mode unchanged)
 *   - prepareAppDataEnv combines directory creation and env var building
 *
 * Tests use injected home directory and filesystem deps so they never touch
 * the real ~/Library/Application Support/ path.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  APP_DATA_DIR_NAME,
  APP_DATA_SUBDIRS,
  NEBULA_PATH_ENV_VARS,
  computeAppDataRoot,
  ensureAppDataDirs,
  buildSidecarEnvVars,
  prepareAppDataEnv,
} from '../paths.mjs';

const tempDirs = [];

function mkTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-paths-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
  }
});

// ---------------------------------------------------------------------------
// Constants — VAL-MIG-001
// ---------------------------------------------------------------------------

describe('Published constants', () => {
  test('APP_DATA_DIR_NAME is "Nebula Nodes"', () => {
    assert.equal(APP_DATA_DIR_NAME, 'Nebula Nodes');
  });

  test('APP_DATA_SUBDIRS contains exactly the 5 required subdirs', () => {
    assert.deepEqual(APP_DATA_SUBDIRS.sort(), [
      'characters',
      'moodboards',
      'output',
      'presets',
      'state',
    ]);
  });

  test('NEBULA_PATH_ENV_VARS contains exactly the 6 required env vars', () => {
    assert.deepEqual(NEBULA_PATH_ENV_VARS.sort(), [
      'NEBULA_CHARACTER_ROOT',
      'NEBULA_MOODBOARD_ROOT',
      'NEBULA_OUTPUT_ROOT',
      'NEBULA_PRESET_ROOT',
      'NEBULA_SETTINGS_PATH',
      'NEBULA_STATE_DIR',
    ]);
  });
});

// ---------------------------------------------------------------------------
// computeAppDataRoot — VAL-MIG-001
// ---------------------------------------------------------------------------

describe('computeAppDataRoot', () => {
  test('returns ~/Library/Application Support/Nebula Nodes/', () => {
    const root = computeAppDataRoot({ home: '/Users/testuser' });
    assert.equal(root, '/Users/testuser/Library/Application Support/Nebula Nodes');
  });

  test('uses os.homedir() when no home option is provided', () => {
    const root = computeAppDataRoot();
    assert.ok(root.includes('Library'));
    assert.ok(root.includes('Application Support'));
    assert.ok(root.endsWith('Nebula Nodes'));
  });

  test('handles home paths with spaces', () => {
    const root = computeAppDataRoot({ home: '/Users/My User' });
    assert.equal(root, '/Users/My User/Library/Application Support/Nebula Nodes');
  });

  test('returns a string, not a Path object', () => {
    const root = computeAppDataRoot({ home: '/tmp/test' });
    assert.equal(typeof root, 'string');
  });
});

// ---------------------------------------------------------------------------
// ensureAppDataDirs — VAL-MIG-001
// ---------------------------------------------------------------------------

describe('ensureAppDataDirs', () => {
  test('creates root and all 5 subdirectories', () => {
    const base = mkTemp();
    const root = join(base, 'AppSupport', 'Nebula Nodes');
    const dirs = ensureAppDataDirs(root);

    assert.equal(dirs.length, 6); // root + 5 subdirs
    for (const dir of dirs) {
      assert.ok(existsSync(dir), `directory should exist: ${dir}`);
      const stat = statSync(dir);
      assert.ok(stat.isDirectory(), `should be a directory: ${dir}`);
    }
  });

  test('creates each required subdir under root', () => {
    const base = mkTemp();
    const root = join(base, 'AppSupport', 'Nebula Nodes');
    ensureAppDataDirs(root);

    for (const sub of APP_DATA_SUBDIRS) {
      const dir = join(root, sub);
      assert.ok(existsSync(dir), `subdir should exist: ${join(root, sub)}`);
    }
  });

  test('is idempotent — safe to call when directories already exist', () => {
    const base = mkTemp();
    const root = join(base, 'AppSupport', 'Nebula Nodes');
    ensureAppDataDirs(root);
    // Second call should not throw
    assert.doesNotThrow(() => ensureAppDataDirs(root));
    // Directories still exist
    for (const sub of APP_DATA_SUBDIRS) {
      assert.ok(existsSync(join(root, sub)));
    }
  });

  test('creates nested parent directories with recursive: true', () => {
    const base = mkTemp();
    const root = join(base, 'a', 'b', 'c', 'Nebula Nodes');
    ensureAppDataDirs(root);
    assert.ok(existsSync(root));
  });

  test('supports injected mkdirSync for unit testing', () => {
    const calls = [];
    const fakeMkdir = (path, opts) => {
      calls.push({ path, opts });
    };
    const root = '/fake/root';
    ensureAppDataDirs(root, { mkdirSync: fakeMkdir });

    assert.equal(calls.length, 6);
    assert.deepEqual(calls[0], { path: root, opts: { recursive: true } });
    assert.equal(calls[0].opts.recursive, true);
  });
});

// ---------------------------------------------------------------------------
// buildSidecarEnvVars — VAL-MIG-002
// ---------------------------------------------------------------------------

describe('buildSidecarEnvVars', () => {
  const root = '/Users/testuser/Library/Application Support/Nebula Nodes';
  const envVars = buildSidecarEnvVars(root);

  test('returns all 6 NEBULA_* path env vars', () => {
    for (const name of NEBULA_PATH_ENV_VARS) {
      assert.ok(name in envVars, `env var should be present: ${name}`);
    }
    assert.equal(Object.keys(envVars).length, 6);
  });

  test('NEBULA_STATE_DIR points to .../state/', () => {
    assert.equal(envVars.NEBULA_STATE_DIR, join(root, 'state'));
    assert.ok(envVars.NEBULA_STATE_DIR.endsWith('/state'));
  });

  test('NEBULA_OUTPUT_ROOT points to .../output/', () => {
    assert.equal(envVars.NEBULA_OUTPUT_ROOT, join(root, 'output'));
    assert.ok(envVars.NEBULA_OUTPUT_ROOT.endsWith('/output'));
  });

  test('NEBULA_CHARACTER_ROOT points to .../characters/', () => {
    assert.equal(envVars.NEBULA_CHARACTER_ROOT, join(root, 'characters'));
    assert.ok(envVars.NEBULA_CHARACTER_ROOT.endsWith('/characters'));
  });

  test('NEBULA_MOODBOARD_ROOT points to .../moodboards/', () => {
    assert.equal(envVars.NEBULA_MOODBOARD_ROOT, join(root, 'moodboards'));
    assert.ok(envVars.NEBULA_MOODBOARD_ROOT.endsWith('/moodboards'));
  });

  test('NEBULA_PRESET_ROOT points to .../presets/', () => {
    assert.equal(envVars.NEBULA_PRESET_ROOT, join(root, 'presets'));
    assert.ok(envVars.NEBULA_PRESET_ROOT.endsWith('/presets'));
  });

  test('NEBULA_SETTINGS_PATH points to .../settings.json', () => {
    assert.equal(envVars.NEBULA_SETTINGS_PATH, join(root, 'settings.json'));
    assert.ok(envVars.NEBULA_SETTINGS_PATH.endsWith('/settings.json'));
  });

  test('all env vars point inside the App Support root', () => {
    for (const [name, value] of Object.entries(envVars)) {
      assert.ok(
        value.startsWith(root),
        `${name} should point inside App Support root: ${value}`,
      );
    }
  });

  test('no env var points at a legacy repo path', () => {
    for (const [name, value] of Object.entries(envVars)) {
      assert.ok(
        !value.includes('/nebula_nodes/output'),
        `${name} must not point at legacy repo output: ${value}`,
      );
      assert.ok(
        !value.includes('/.nebula/'),
        `${name} must not point at legacy ~/.nebula/: ${value}`,
      );
      assert.ok(
        !value.endsWith('/settings.json') || value.includes('Application Support'),
        `${name} settings path must be in App Support: ${value}`,
      );
    }
  });

  test('returns a new object — does not mutate process.env', () => {
    const beforeKeys = Object.keys(process.env);
    const vars = buildSidecarEnvVars('/some/path');
    const afterKeys = Object.keys(process.env);

    // No NEBULA_* keys should have been added to process.env
    for (const name of NEBULA_PATH_ENV_VARS) {
      assert.ok(
        !(name in process.env) || beforeKeys.includes(name),
        `${name} should not be added to process.env by buildSidecarEnvVars`,
      );
    }
    assert.deepEqual(afterKeys, beforeKeys, 'process.env keys unchanged');
  });
});

// ---------------------------------------------------------------------------
// prepareAppDataEnv — VAL-MIG-001, VAL-MIG-002
// ---------------------------------------------------------------------------

describe('prepareAppDataEnv', () => {
  test('creates directories and returns env vars', () => {
    const base = mkTemp();
    const result = prepareAppDataEnv({ home: base });

    // Root should exist
    assert.ok(existsSync(result.root));
    assert.ok(result.root.endsWith('Nebula Nodes'));

    // All subdirs should exist
    for (const sub of APP_DATA_SUBDIRS) {
      assert.ok(existsSync(join(result.root, sub)));
    }

    // All env vars should be present
    for (const name of NEBULA_PATH_ENV_VARS) {
      assert.ok(name in result.envVars, `${name} should be in envVars`);
    }
  });

  test('env vars point inside the created root', () => {
    const base = mkTemp();
    const result = prepareAppDataEnv({ home: base });

    for (const [name, value] of Object.entries(result.envVars)) {
      assert.ok(
        value.startsWith(result.root),
        `${name} should point inside root: ${value}`,
      );
    }
  });

  test('does not mutate process.env', () => {
    const base = mkTemp();
    const beforeKeys = Object.keys(process.env);
    prepareAppDataEnv({ home: base });
    const afterKeys = Object.keys(process.env);
    assert.deepEqual(afterKeys, beforeKeys);
  });

  test('directories are created before env vars are returned', () => {
    const base = mkTemp();
    const result = prepareAppDataEnv({ home: base });

    // By the time we get the result, all directories must exist
    for (const sub of APP_DATA_SUBDIRS) {
      const dir = join(result.root, sub);
      assert.ok(
        existsSync(dir),
        `directory must exist before env vars are used: ${dir}`,
      );
    }
  });

  test('supports injected mkdirSync', () => {
    const calls = [];
    const fakeMkdir = (path, opts) => {
      calls.push({ path, opts });
    };
    const result = prepareAppDataEnv({
      home: '/fake/home',
      mkdirSync: fakeMkdir,
    });

    assert.equal(calls.length, 6);
    assert.ok(result.root.includes('Nebula Nodes'));
    assert.equal(Object.keys(result.envVars).length, 6);
  });
});

// ---------------------------------------------------------------------------
// Browser/dev mode unchanged — VAL-MIG-011
// ---------------------------------------------------------------------------

describe('Browser/dev mode unchanged (VAL-MIG-011)', () => {
  test('buildSidecarEnvVars does not set any env var on process.env', () => {
    // Snapshot the NEBULA_* values before
    const before = {};
    for (const name of NEBULA_PATH_ENV_VARS) {
      before[name] = process.env[name];
    }

    buildSidecarEnvVars('/some/app/support/path');

    // After calling, process.env should be unchanged
    for (const name of NEBULA_PATH_ENV_VARS) {
      assert.equal(
        process.env[name],
        before[name],
        `${name} should not be set on process.env by buildSidecarEnvVars`,
      );
    }
  });

  test('prepareAppDataEnv does not set any env var on process.env', () => {
    const base = mkTemp();
    const before = {};
    for (const name of NEBULA_PATH_ENV_VARS) {
      before[name] = process.env[name];
    }

    prepareAppDataEnv({ home: base });

    for (const name of NEBULA_PATH_ENV_VARS) {
      assert.equal(
        process.env[name],
        before[name],
        `${name} should not be set on process.env by prepareAppDataEnv`,
      );
    }
  });
});
