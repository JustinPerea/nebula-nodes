import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEBUG_SWITCHES,
  debugSwitchesInUse,
  decidePersonToken,
  newPersonToken,
  registerPersonTokenHandler,
  PERSON_TOKEN_CHANNEL,
} from '../person-token.mjs';

test('a launch token is 43 base64url characters', () => {
  assert.match(newPersonToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newPersonToken(), newPersonToken());
});

test('no token with a debug port open, or in the dev renderer without opt-in', () => {
  assert.deepEqual(decidePersonToken({ debugPort: '9222', isDevelopment: false }), { token: null, reason: 'DEBUG_PORT' });
  assert.deepEqual(decidePersonToken({ debugPort: '9222', isDevelopment: true, devOptIn: '1' }), { token: null, reason: 'DEBUG_PORT' });
  assert.deepEqual(decidePersonToken({ isDevelopment: true }), { token: null, reason: 'DEV_RENDERER' });
  assert.match(decidePersonToken({ isDevelopment: true, devOptIn: '1' }).token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(decidePersonToken({ isDevelopment: false }).token, /^[A-Za-z0-9_-]{43}$/);
});

function handlerFor(person, trusted) {
  let handler;
  registerPersonTokenHandler({ handle: (channel, fn) => { assert.equal(channel, PERSON_TOKEN_CHANNEL); handler = fn; } },
    person, () => trusted);
  return handler;
}

test('only the trusted main frame gets the token', () => {
  const person = { token: 'T'.repeat(43), reason: null };
  assert.deepEqual(handlerFor(person, true)({}), { ok: true, token: person.token });
  assert.deepEqual(handlerFor(person, false)({}), { ok: false, error: 'UNTRUSTED_SENDER' });
});

test('says why there is no token', () => {
  assert.deepEqual(handlerFor({ token: null, reason: 'DEBUG_PORT' }, true)({}), { ok: false, error: 'DEBUG_PORT' });
  assert.deepEqual(handlerFor({ token: null, reason: 'DEV_RENDERER' }, true)({}), { ok: false, error: 'DEV_RENDERER' });
});

test('debug switches from argv, execArgv, NODE_OPTIONS or Chromium count', () => {
  assert.deepEqual(debugSwitchesInUse({}), []);
  assert.deepEqual(debugSwitchesInUse({ argv: ['/x/Nebula', '--no-sandbox', '--inspector-free'] }), []);
  assert.deepEqual(debugSwitchesInUse({ argv: ['/x/Nebula', '--remote-debugging-port=9333'] }), ['remote-debugging-port']);
  assert.deepEqual(debugSwitchesInUse({ argv: ['/x/Nebula', '--remote-debugging-pipe'] }), ['remote-debugging-pipe']);
  assert.deepEqual(debugSwitchesInUse({ argv: ['--inspect-brk=0', '--inspect'] }), ['inspect', 'inspect-brk']);
  assert.deepEqual(debugSwitchesInUse({ execArgv: ['--inspect-port=9229'] }), ['inspect-port']);
  assert.deepEqual(debugSwitchesInUse({ nodeOptions: '--max-old-space-size=4096 --inspect=127.0.0.1:9229' }), ['inspect']);
  const seen = new Set(['remote-debugging-port']);
  assert.deepEqual(debugSwitchesInUse({ hasSwitch: (name) => seen.has(name) }), ['remote-debugging-port']);
  for (const name of DEBUG_SWITCHES) {
    assert.deepEqual(debugSwitchesInUse({ hasSwitch: (n) => n === name }), [name]);
  }
});

test('a debug switch on the command line means no token, like the env debug port', () => {
  // The review repro: `Nebula --remote-debugging-port=N` with no NEBULA_DESKTOP_DEBUG_PORT.
  const switches = debugSwitchesInUse({ argv: ['/x/Nebula', '--remote-debugging-port=9333'] });
  assert.deepEqual(decidePersonToken({ debugSwitches: switches, isDevelopment: false }), { token: null, reason: 'DEBUG_PORT' });
  assert.deepEqual(decidePersonToken({ debugSwitches: ['inspect'], isDevelopment: true, devOptIn: '1' }), { token: null, reason: 'DEBUG_PORT' });
  assert.match(decidePersonToken({ debugSwitches: [], isDevelopment: false }).token, /^[A-Za-z0-9_-]{43}$/);
});

test('main.mjs checks argv switches before adding its own, and feeds them to the token', () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const detect = source.indexOf('debugSwitchesInUse({');
  const append = source.indexOf("appendSwitch('remote-debugging-port'");
  assert.ok(detect > 0 && append > detect, 'detection must run before main appends its own debug port');
  assert.match(source, /hasSwitch: \(name\) => app\.commandLine\.hasSwitch\(name\)/);
  assert.match(source, /decidePersonToken\(\{[^}]*debugSwitches: launchDebugSwitches/);
  // A normal Nebula.app refuses; the lock and the backend are never reached.
  assert.match(source, /const refuseDebugLaunch = launchDebugSwitches\.length > 0 && treatAsPackaged\(app\.isPackaged, packaged\);/);
  assert.match(source, /const acquiredLock = refuseDebugLaunch \? false : app\.requestSingleInstanceLock\(\);\nif \(refuseDebugLaunch\) \{/);
});
