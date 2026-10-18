import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  BUILD_STAMP_FILE,
  FrontendBuildError,
  REBUILD_COMMAND,
  checkParamsVersions,
  healthParamsVersion,
  readBuildParamsVersion,
} from '../frontend-build.mjs';

const DIR = '/repo/frontend/dist-desktop';

/** A readFileSync that serves `files` (path -> text) and ENOENTs the rest. */
function reader(files) {
  return (path) => {
    if (Object.hasOwn(files, path)) return files[path];
    const err = new Error(`ENOENT: no such file, open '${path}'`);
    err.code = 'ENOENT';
    throw err;
  };
}
const stampAt = (text) => reader({ [join(DIR, BUILD_STAMP_FILE)]: text });

test('the stamp file name matches what the frontend build writes', () => {
  assert.equal(BUILD_STAMP_FILE, 'nebula-build.json');
  assert.equal(REBUILD_COMMAND, 'cd frontend && npm run build:desktop');
});

test('a stamped build reports its params version', () => {
  assert.equal(readBuildParamsVersion(DIR, { readFileSync: stampAt('{"paramsVersion": 1}') }), 1);
  assert.equal(readBuildParamsVersion(DIR, { readFileSync: stampAt('{"paramsVersion": 0, "extra": true}') }), 0);
});

test('a build with no stamp predates it: rebuild', () => {
  assert.throws(
    () => readBuildParamsVersion(DIR, { readFileSync: reader({}) }),
    (err) => err instanceof FrontendBuildError
      && err.type === 'build_stamp_missing'
      && err.message.includes('older version of Nebula')
      && err.message.includes(REBUILD_COMMAND),
  );
});

for (const [name, text] of [
  ['not JSON', '{"paramsVersion": '],
  ['no field', '{}'],
  ['a string', '{"paramsVersion": "1"}'],
  ['negative', '{"paramsVersion": -1}'],
  ['fractional', '{"paramsVersion": 1.5}'],
  ['null', 'null'],
  ['an array', '[1]'],
]) {
  test(`a damaged stamp (${name}) asks for a rebuild`, () => {
    assert.throws(
      () => readBuildParamsVersion(DIR, { readFileSync: stampAt(text) }),
      (err) => err instanceof FrontendBuildError
        && err.type === 'build_stamp_unreadable'
        && err.message.includes(REBUILD_COMMAND),
    );
  });
}

test('an unreadable stamp (not ENOENT) asks for a rebuild', () => {
  const eacces = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  assert.throws(
    () => readBuildParamsVersion(DIR, { readFileSync: eacces }),
    (err) => err instanceof FrontendBuildError && err.type === 'build_stamp_unreadable',
  );
});

test('equal versions pass', () => {
  assert.equal(checkParamsVersions(1, { status: 'ok', app: 'nebula', version: '0.1.0', paramsVersion: 1 }), null);
  assert.equal(checkParamsVersions(0, { status: 'ok', app: 'nebula', version: '0.1.0', paramsVersion: 0 }), null);
});

test('a frontend older than the backend: rebuild and start again', () => {
  const err = checkParamsVersions(1, { paramsVersion: 2 });
  assert.ok(err instanceof FrontendBuildError);
  assert.equal(err.type, 'frontend_older');
  assert.equal(err.frontendVersion, 1);
  assert.equal(err.backendVersion, 2);
  assert.match(err.message, /frontend is older than the backend/);
  assert.match(err.message, /backend was updated/);
  assert.ok(err.message.includes(REBUILD_COMMAND));
});

test('a frontend newer than the backend: rebuild from this checkout', () => {
  const err = checkParamsVersions(3, { paramsVersion: 2 });
  assert.equal(err.type, 'frontend_newer');
  assert.match(err.message, /frontend is newer than the backend/);
  assert.match(err.message, /from this checkout/);
  assert.match(err.message, /switch branches/);
  assert.ok(err.message.includes(REBUILD_COMMAND));
});

test('a backend without the field is version 0 (from before the health field)', () => {
  const health = { status: 'ok', app: 'nebula', version: '0.1.0' };
  assert.equal(healthParamsVersion(health), 0);
  assert.equal(checkParamsVersions(0, health), null);
  const err = checkParamsVersions(1, health);
  assert.equal(err.type, 'frontend_newer');
  assert.equal(err.backendVersion, 0);
});

test('a backend version that is not a version stops startup without blaming the frontend', () => {
  for (const value of ['1', -1, 1.5, null, true]) {
    const err = checkParamsVersions(1, { paramsVersion: value });
    assert.equal(err?.type, 'backend_version_unreadable', `value ${JSON.stringify(value)}`);
    assert.equal(err.heading, 'Backend startup failed');
  }
});

test('the failure surface gets its own heading', () => {
  assert.equal(checkParamsVersions(1, { paramsVersion: 2 }).heading, 'The desktop frontend needs a rebuild');
});
