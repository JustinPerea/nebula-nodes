import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePersonToken, newPersonToken, registerPersonTokenHandler, PERSON_TOKEN_CHANNEL } from '../person-token.mjs';

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
