import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createPaperLinkSenderValidator, isPaperArtworkUrl, PAPER_LINK_CHANNEL, registerPaperLinkHandler } from '../paper-links.mjs';

const desktopUrl = 'paper://file/01M3WWYCQ4Q8BQQVPE963SJXET/p-1-0/D-0';
const webUrl = 'https://app.paper.design/file/01M3WWYCQ4Q8BQQVPE963SJXET/p-1-0/D-0';

test('canonical desktop and HTTPS links reach only the registered artwork destination', async () => {
  const calls = [];
  const handlers = new Map();
  registerPaperLinkHandler({ handle: (name, handler) => handlers.set(name, handler) }, { openExternal: async (url) => calls.push(url) }, () => true);
  assert.deepEqual([...handlers.keys()], [PAPER_LINK_CHANNEL]);
  for (const url of [desktopUrl, webUrl]) {
    assert.equal(isPaperArtworkUrl(url), true);
    assert.deepEqual(await handlers.get(PAPER_LINK_CHANNEL)({}, url), { ok: true });
  }
  assert.deepEqual(calls, [desktopUrl, webUrl]);
});

const invalidTargets = [
  undefined, null, 42, {}, '',
  'javascript:alert(1)', 'file:///tmp/asset', 'data:text/html,hello',
  'http://app.paper.design/file/a/b/c', 'https://evil.example/file/a/b/c',
  'paper://auth/token', 'paper://file/a', 'paper://file/a/b', 'paper://file/a/b/c/d',
  'paper://FILE/a/b/c', 'PAPER://file/a/b/c', 'paper://file/a/b/c/',
  'paper://user:pass@file/a/b/c', 'paper://file:99/a/b/c',
  'paper://file/a/b/c?redirect=https://evil.example', 'paper://file/a/b/c#action',
  'paper://file/a/b/../c', 'paper://file/a/b/./c', 'paper://file/a/b/%2E%2E/c',
  'paper://file/a/b/c%2Fd', 'paper://file/a/b/%63', 'paper://file/a/b/ç',
  'paper://file/a/b/c\n', 'paper://file/a/b/\tc', ' paper://file/a/b/c',
  'paper://file/a/b/c ', 'paper://file/a//c', `paper://file/a/b/${'a'.repeat(129)}`,
  'https://app.paper.design.evil/file/a/b/c', 'https://user@app.paper.design/file/a/b/c',
  'https://app.paper.design:443/file/a/b/c', 'https://app.paper.design/file/a/b/c?x=1',
  'https://app.paper.design/file/a/b/c#x', 'https://app.paper.design/file/a/b/../c',
  'https://app.paper.design/file/a/b/c\n', 'https://app.paper.design/file/a/b/c%2Fd',
];
for (const target of invalidTargets) {
  test(`rejects unsupported or ambiguous OS target ${JSON.stringify(target)}`, async () => {
    let opened = false;
    let handler;
    registerPaperLinkHandler({ handle: (_name, fn) => { handler = fn; } }, { openExternal: async () => { opened = true; } }, () => true);
    assert.equal(isPaperArtworkUrl(target), false);
    assert.deepEqual(await handler({}, target), { ok: false, error: 'INVALID_PAPER_ARTWORK_URL' });
    assert.equal(opened, false);
  });
}

test('untrusted senders do not invoke the OS even with a canonical target', async () => {
  let handler;
  let opened = false;
  registerPaperLinkHandler({ handle: (_name, fn) => { handler = fn; } }, { openExternal: async () => { opened = true; } }, () => false);
  assert.deepEqual(await handler({}, desktopUrl), { ok: false, error: 'UNTRUSTED_SENDER' });
  assert.equal(opened, false);
});

test('OS failure is returned as a structured error', async () => {
  let handler;
  registerPaperLinkHandler({ handle: (_name, fn) => { handler = fn; } }, { openExternal: async () => { throw new Error('No Paper handler'); } }, () => true);
  assert.deepEqual(await handler({}, desktopUrl), { ok: false, error: 'No Paper handler' });
});

test('the dev renderer sender must match the actual contents, main frame and exact origin', () => {
  const frame = { url: 'http://127.0.0.1:5193/?app=1' };
  const contents = { mainFrame: frame };
  const validate = createPaperLinkSenderValidator('http://127.0.0.1:5193/', () => contents);
  assert.equal(validate({ sender: contents, senderFrame: frame }), true);
  assert.equal(validate({ sender: {}, senderFrame: frame }), false);
  assert.equal(validate({ sender: contents, senderFrame: { url: frame.url } }), false);
  assert.equal(validate({ sender: contents, senderFrame: null }), false);
  for (const url of ['http://127.0.0.1:5193.evil/', 'http://127.0.0.1:5194/', 'https://127.0.0.1:5193/', 'http://user@127.0.0.1:5193/', 'file:///app/index.html', 'data:text/html,hello']) {
    frame.url = url;
    assert.equal(validate({ sender: contents, senderFrame: frame }), false, url);
  }
});

test('packaged sender must match the exact app file and main frame', () => {
  const frame = { url: 'file:///Nebula/frontend/dist/index.html#/canvas' };
  const contents = { mainFrame: frame };
  const validate = createPaperLinkSenderValidator('file:///Nebula/frontend/dist/index.html', () => contents);
  assert.equal(validate({ sender: contents, senderFrame: frame }), true);
  for (const url of ['file:///tmp/other.html', 'file:///Nebula/frontend/dist/index.html.evil', 'file://evil/Nebula/frontend/dist/index.html', 'https://evil.example/']) {
    frame.url = url;
    assert.equal(validate({ sender: contents, senderFrame: frame }), false, url);
  }
  assert.equal(createPaperLinkSenderValidator('file:///app/index.html', () => null)({ sender: contents, senderFrame: frame }), false);
});

test('preload exposes only a frozen Paper open method and a fixed channel', async () => {
  let metadata;
  const calls = [];
  const source = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  runInNewContext(source, {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'nebulaDesktop'); metadata = value; } },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; } },
      };
    },
    process: { platform: 'darwin', argv: [] },
  });
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.paperLinks), true);
  assert.deepEqual(Object.keys(metadata.paperLinks), ['open']);
  assert.equal(metadata.ipcRenderer, undefined);
  await metadata.paperLinks.open(desktopUrl);
  assert.deepEqual(calls, [[PAPER_LINK_CHANNEL, desktopUrl]]);
});
