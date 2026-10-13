import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEV_ONLY_ENV_VARS, resolveLaunchOverrides } from '../launch-overrides.mjs';

const ALL = {
  NEBULA_DESKTOP_DEBUG_PORT: '47001',
  NEBULA_DESKTOP_USER_DATA_DIR: '/tmp/nebula-profile',
  NEBULA_DESKTOP_APP_ID: 'nebula-test',
  NEBULA_DESKTOP_TEST: '1',
  VITE_DEV_SERVER_URL: 'http://localhost:5173',
  NEBULA_DESKTOP_DEV_PERSON: '1',
};

describe('resolveLaunchOverrides', () => {
  test('a packaged build ignores every dev/test override and names them', () => {
    const result = resolveLaunchOverrides({ env: ALL, isPackaged: true });
    assert.equal(result.debugPort, undefined);
    assert.equal(result.userDataDir, undefined);
    assert.equal(result.appId, undefined);
    assert.equal(result.devServerUrl, undefined);
    assert.equal(result.devPersonOptIn, undefined);
    assert.equal(result.mockKeychain, false);
    assert.deepEqual([...result.ignored].sort(), [...DEV_ONLY_ENV_VARS].sort());
  });

  test('a packaged build with a clean environment reports nothing ignored', () => {
    const result = resolveLaunchOverrides({ env: { HOME: '/Users/x' }, isPackaged: true });
    assert.deepEqual(result.ignored, []);
    assert.equal(result.mockKeychain, false);
  });

  test('an unpackaged run honours the overrides', () => {
    const result = resolveLaunchOverrides({ env: ALL, isPackaged: false });
    assert.equal(result.debugPort, '47001');
    assert.equal(result.userDataDir, '/tmp/nebula-profile');
    assert.equal(result.appId, 'nebula-test');
    assert.equal(result.devServerUrl, 'http://localhost:5173');
    assert.equal(result.devPersonOptIn, '1');
    assert.equal(result.mockKeychain, true);
    assert.deepEqual(result.ignored, []);
  });

  test('a user-data dir alone keeps the real keychain', () => {
    const result = resolveLaunchOverrides({
      env: { NEBULA_DESKTOP_USER_DATA_DIR: '/tmp/p' },
      isPackaged: false,
    });
    assert.equal(result.userDataDir, '/tmp/p');
    assert.equal(result.mockKeychain, false);
  });

  test('NEBULA_DESKTOP_TEST without a user-data dir never mocks the keychain', () => {
    // The mock key would otherwise apply to the person's real profile.
    const result = resolveLaunchOverrides({ env: { NEBULA_DESKTOP_TEST: '1' }, isPackaged: false });
    assert.equal(result.mockKeychain, false);
  });

  test('only the exact value 1 turns the mock keychain on', () => {
    for (const value of ['true', 'yes', '0', '']) {
      const result = resolveLaunchOverrides({
        env: { NEBULA_DESKTOP_USER_DATA_DIR: '/tmp/p', NEBULA_DESKTOP_TEST: value },
        isPackaged: false,
      });
      assert.equal(result.mockKeychain, false, `NEBULA_DESKTOP_TEST=${JSON.stringify(value)}`);
    }
  });

  test('empty strings count as unset', () => {
    const result = resolveLaunchOverrides({
      env: { NEBULA_DESKTOP_DEBUG_PORT: '', NEBULA_DESKTOP_USER_DATA_DIR: '', VITE_DEV_SERVER_URL: '' },
      isPackaged: false,
    });
    assert.equal(result.debugPort, undefined);
    assert.equal(result.userDataDir, undefined);
    assert.equal(result.devServerUrl, undefined);
  });
});

describe('main.mjs wiring', () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');

  test('main reads the dev/test overrides only through resolveLaunchOverrides', () => {
    for (const name of DEV_ONLY_ENV_VARS) {
      assert.equal(source.includes(`process.env.${name}`), false, `main.mjs reads process.env.${name} directly`);
    }
    assert.match(source, /resolveLaunchOverrides\(\{ env: process\.env, isPackaged: app\.isPackaged \}\)/);
  });

  test('the mock keychain switch is gated on overrides.mockKeychain', () => {
    const switchAt = source.indexOf("appendSwitch('use-mock-keychain')");
    const gateAt = source.lastIndexOf('if (overrides.mockKeychain)', switchAt);
    assert.ok(switchAt > 0 && gateAt > 0, 'mock keychain switch must sit inside the overrides.mockKeychain branch');
    assert.equal(source.slice(gateAt, switchAt).includes('}'), false);
  });

  test('the missing-renderer check runs before app data is prepared or migrated', () => {
    const ready = source.indexOf('app.whenReady().then(');
    const check = source.indexOf('The desktop renderer is not built', ready);
    const prepare = source.indexOf('prepareAppDataEnv({', ready);
    const migrate = source.indexOf('isMigrationNeeded(', ready);
    assert.ok(ready > 0 && check > ready, 'check must be inside whenReady');
    assert.ok(check < prepare, 'check must precede prepareAppDataEnv');
    assert.ok(check < migrate, 'check must precede the migration');
  });
});
