import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConnectorEncryptionKey, isKreaAuthorizationUrl, registerKreaAuthLinkHandler } from '../connector-vault.mjs';

const fakeStorage = {
  isAsyncEncryptionAvailable: () => true,
  encryptStringAsync: async (text) => Buffer.from(`fixture-encrypted:${text}`),
  decryptStringAsync: async (bytes) => ({ result: bytes.toString().replace('fixture-encrypted:', ''), shouldReEncrypt: false }),
};

test('private connector key survives restart and is encrypted on disk with owner-only permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nebula-connector-'));
  try {
    const path = join(dir, 'key.enc');
    const key = await getConnectorEncryptionKey(path, fakeStorage);
    assert.match(key, /^[A-Za-z0-9_-]{43}=$/);
    assert.equal(Buffer.from(key, 'base64url').length, 32);
    assert.equal(await getConnectorEncryptionKey(path, fakeStorage), key);
    assert.equal((await readFile(path, 'utf8')).includes(key), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unavailable OS credential encryption never leaves a plaintext key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nebula-connector-'));
  try {
    const path = join(dir, 'key.enc');
    await assert.rejects(getConnectorEncryptionKey(path, { isAsyncEncryptionAvailable: () => false }), /safeStorage/);
    await assert.rejects(access(path), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('OAuth opens only the Krea consent endpoint from a trusted renderer', async () => {
  const url = 'https://www.krea.ai/auth/v1/oauth/authorize?client_id=public&state=fixture';
  assert.equal(isKreaAuthorizationUrl(url), true);
  for (const invalid of ['https://www.krea.ai.evil/auth/v1/oauth/authorize', 'https://www.krea.ai/auth/v1/oauth/token',
    'https://user@www.krea.ai/auth/v1/oauth/authorize', 'javascript:alert(1)', 'http://www.krea.ai/auth/v1/oauth/authorize']) {
    assert.equal(isKreaAuthorizationUrl(invalid), false);
  }
  let handler;
  const calls = [];
  registerKreaAuthLinkHandler({ handle: (_name, fn) => { handler = fn; } }, { openExternal: async (value) => calls.push(value) }, (event) => event.trusted);
  await assert.rejects(handler({}, url), /Invalid/);
  await assert.rejects(handler({ trusted: true }, 'https://evil.test/'), /Invalid/);
  await handler({ trusted: true }, url);
  assert.deepEqual(calls, [url]);
});
