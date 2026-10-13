import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FuseV1Options } from '@electron/fuses';
import { NEBULA_FUSES, wantedFuseBits } from '../packaging/fuses.mjs';

test('every fuse is decided, and the risky ones are off', () => {
  assert.equal(NEBULA_FUSES.strictlyRequireAllFuses, true);
  const wanted = wantedFuseBits();
  const indices = Object.values(FuseV1Options).filter((v) => typeof v === 'number');
  assert.deepEqual(Object.keys(wanted).map(Number).sort((a, b) => a - b), indices.sort((a, b) => a - b));
  assert.equal(wanted[FuseV1Options.RunAsNode], false);
  assert.equal(wanted[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(wanted[FuseV1Options.EnableNodeCliInspectArguments], false);
  // Needed by the file:// renderer; renderer-files.mjs confines what it can read.
  assert.equal(wanted[FuseV1Options.GrantFileProtocolExtraPrivileges], true);
  assert.equal(wanted[FuseV1Options.EnableCookieEncryption], true);
});

test('package.mjs flips and checks the fuses before the codesign', () => {
  const source = readFileSync(new URL('../scripts/package.mjs', import.meta.url), 'utf8');
  const flip = source.indexOf('await flipFuses(appBinary, NEBULA_FUSES);');
  const check = source.indexOf('getCurrentFuseWire(appBinary)');
  const sign = source.indexOf("spawnSync('codesign'");
  assert.ok(flip > 0 && check > flip && sign > check);
});
