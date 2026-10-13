/**
 * How the packaged Nebula.app finds and checks its checkout (app-repo.mjs),
 * and when it honours dev/test overrides (packaged-launch.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APP_CONFIG_FILE_NAME, REQUIRED_REPO_FILES, checkRepo, readAppConfig } from '../app-repo.mjs';
import { treatAsPackaged } from '../packaged-launch.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'nebula-app-repo-'));
}

function fakeRepo({ python = true, executable = true, main = true } = {}) {
  const root = scratch();
  mkdirSync(join(root, 'desktop'), { recursive: true });
  mkdirSync(join(root, 'backend', '.venv', 'bin'), { recursive: true });
  if (main) writeFileSync(join(root, REQUIRED_REPO_FILES.main), '');
  writeFileSync(join(root, REQUIRED_REPO_FILES.backend), '');
  if (python) {
    const py = join(root, REQUIRED_REPO_FILES.python);
    writeFileSync(py, '#!/bin/sh\n');
    chmodSync(py, executable ? 0o755 : 0o644);
  }
  return root;
}

describe('readAppConfig', () => {
  test('reads the repo path and flags', () => {
    const dir = scratch();
    writeFileSync(join(dir, APP_CONFIG_FILE_NAME), JSON.stringify({
      repoRoot: '/Users/x/nebula', validation: true, electronVersion: '44.3.0',
    }));
    const result = readAppConfig(dir);
    assert.deepEqual(result, {
      ok: true,
      config: { repoRoot: '/Users/x/nebula', validation: true, electronVersion: '44.3.0' },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test('validation is only true when it is literally true', () => {
    const dir = scratch();
    writeFileSync(join(dir, APP_CONFIG_FILE_NAME), JSON.stringify({ repoRoot: '/r', validation: 'yes' }));
    assert.equal(readAppConfig(dir).config.validation, false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a missing or unreadable config is a clear failure', () => {
    const dir = scratch();
    const missing = readAppConfig(dir);
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /npm run package/);
    writeFileSync(join(dir, APP_CONFIG_FILE_NAME), '{not json');
    assert.equal(readAppConfig(dir).ok, false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a relative repo path is refused', () => {
    const dir = scratch();
    writeFileSync(join(dir, APP_CONFIG_FILE_NAME), JSON.stringify({ repoRoot: 'nebula_nodes' }));
    assert.equal(readAppConfig(dir).ok, false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('checkRepo', () => {
  test('a complete checkout passes', () => {
    const root = fakeRepo();
    assert.deepEqual(checkRepo(root), { ok: true });
    rmSync(root, { recursive: true, force: true });
  });

  test('a moved checkout names the old path and how to rebuild', () => {
    const result = checkRepo(join(tmpdir(), 'nebula-definitely-not-here'));
    assert.equal(result.ok, false);
    assert.match(result.detail, /nebula-definitely-not-here/);
    assert.match(result.detail, /npm run package && npm run install-app/);
  });

  test('a checkout without desktop/main.mjs is incomplete', () => {
    const root = fakeRepo({ main: false });
    const result = checkRepo(root);
    assert.equal(result.ok, false);
    assert.match(result.detail, /desktop\/main\.mjs/);
    rmSync(root, { recursive: true, force: true });
  });

  test('a missing or non-executable venv python says how to create it', () => {
    for (const opts of [{ python: false }, { executable: false }]) {
      const root = fakeRepo(opts);
      const result = checkRepo(root);
      assert.equal(result.ok, false);
      assert.match(result.problem, /virtualenv|environment/);
      assert.match(result.detail, /python3 -m venv \.venv/);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('treatAsPackaged', () => {
  test('npm run start is never packaged', () => {
    assert.equal(treatAsPackaged(false, null), false);
  });

  test('a normal Nebula.app ignores dev/test overrides', () => {
    assert.equal(treatAsPackaged(true, null), true);
    assert.equal(treatAsPackaged(true, { validation: false }), true);
  });

  test('only a validation build honours them', () => {
    assert.equal(treatAsPackaged(true, { validation: true }), false);
  });
});
