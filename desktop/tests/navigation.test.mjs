import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { externalBrowserUrl, installRendererNavigationGuard, isTrustedRendererUrl } from '../navigation.mjs';

const packaged = 'file:///app/frontend/dist/index.html';
const development = 'http://localhost:5173/';

const cases = [
  [packaged, packaged, true],
  [`${packaged}#canvas`, packaged, true],
  ['file:///app/frontend/dist/../dist/index.html#canvas', packaged, true],
  ['file:///app/frontend/dist/other.html', packaged, false],
  [`${packaged}?untrusted=1`, packaged, false],
  ['file://remote/app/frontend/dist/index.html', packaged, false],
  [development, development, true],
  [`${development}#canvas`, development, true],
  ['http://localhost:5173/other', development, false],
  ['http://localhost:5174/', development, false],
  ['http://127.0.0.1:5173/', development, false],
  ['http://user:pass@localhost:5173/', development, false],
  ['http://localhost.evil:5173/', development, false],
  ['https://malicious.example/', packaged, false],
  ['data:text/html,hello', packaged, false],
  ['about:blank', packaged, false],
  ['not a url', packaged, false],
];

test('trusted renderer requires the normalized configured document, allowing only hash variation', () => {
  for (const [actual, expected, trusted] of cases) {
    assert.equal(isTrustedRendererUrl(actual, expected), trusted, actual);
  }
  assert.equal(isTrustedRendererUrl(packaged, ''), false);
});

function preload(actual, rendererUrl = packaged, isMainFrame = true) {
  let metadata;
  runInNewContext(readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_key, value) => { metadata = value; } },
      ipcRenderer: { invoke: async () => ({ ok: true }) },
    }),
    URL,
    location: { href: actual },
    process: {
      platform: 'darwin', isMainFrame,
      argv: [`--nebula-renderer-url=${rendererUrl}`, '--nebula-connector-session=fixture-nonce',
        '--nebula-api-base=http://127.0.0.1:8033'],
    },
  });
  return metadata;
}

test('preload exposes the connector nonce only to the same trusted main-frame document', () => {
  for (const [actual, expected, trusted] of cases) {
    const metadata = preload(actual, expected);
    assert.equal(metadata.connectorSession, trusted ? 'fixture-nonce' : undefined, actual);
    assert.equal(metadata.apiBaseUrl, 'http://127.0.0.1:8033');
    assert.equal(typeof metadata.paperLinks.open, 'function');
    assert.equal(typeof metadata.credentials.set, 'function');
    assert.equal(Object.isFrozen(metadata), true);
  }
  assert.equal(preload(packaged, packaged, false).connectorSession, undefined);
  assert.equal(preload(packaged, packaged, null).connectorSession, undefined);
  assert.equal(preload(packaged, '').connectorSession, undefined);
});

test('external URLs reject credentials, custom protocols, control characters and malformed URLs', () => {
  assert.equal(externalBrowserUrl('https://www.krea.ai/docs/developers/mcp'), 'https://www.krea.ai/docs/developers/mcp');
  assert.equal(externalBrowserUrl('http://localhost:5173/help'), 'http://localhost:5173/help');
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'paper://file/a/b/c',
    'https://user@krea.ai/', 'https://krea.ai/\n', 'https://krea.ai/a b', 'https:\\malicious.example', '', null]) {
    assert.equal(externalBrowserUrl(url), null, String(url));
  }
});

function navigationFixture(rendererUrl = packaged, openExternal = async () => {}) {
  const handlers = new Map();
  let windowOpen;
  const contents = {
    on: (name, handler) => handlers.set(name, handler),
    setWindowOpenHandler: (handler) => { windowOpen = handler; },
  };
  installRendererNavigationGuard(contents, rendererUrl, { openExternal });
  return { handlers, open: (details) => windowOpen(details) };
}

test('main-frame navigation and redirects reject remote and unrelated documents before loading', () => {
  const { handlers } = navigationFixture();
  for (const name of ['will-navigate', 'will-redirect']) {
    for (const [url, rendererUrl, trusted] of cases.filter(([, expected]) => expected === packaged)) {
      let prevented = false;
      handlers.get(name)({ url, isMainFrame: true, preventDefault: () => { prevented = true; } });
      assert.equal(prevented, !trusted, `${name}: ${url} (${rendererUrl})`);
    }
    let prevented = false;
    handlers.get(name)({ preventDefault: () => { prevented = true; } }, 'https://malicious.example/');
    assert.equal(prevented, true, `${name} legacy arguments`);
  }
});

test('redirects of non-main frames do not expose the nonce or replace the renderer', () => {
  const { handlers } = navigationFixture();
  let prevented = false;
  handlers.get('will-redirect')({ url: 'https://assets.krea.ai/image.png', isMainFrame: false,
    preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(preload(packaged, packaged, false).connectorSession, undefined);
});

test('new windows are always denied; valid browser links open externally only', async () => {
  const calls = [];
  const fixture = navigationFixture(development, async (url) => calls.push(url));
  for (const url of ['https://www.krea.ai/docs/developers/mcp', 'http://localhost:5173/help',
    development, `${development}#canvas`, 'paper://file/a/b/c', 'javascript:alert(1)', 'https://user@krea.ai/']) {
    assert.deepEqual(fixture.open({ url }), { action: 'deny' });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['https://www.krea.ai/docs/developers/mcp', 'http://localhost:5173/help']);
});

test('an OS launch failure never falls back to creating a privileged child window', async () => {
  const fixture = navigationFixture(packaged, async () => { throw new Error('fixture failure'); });
  assert.deepEqual(fixture.open({ url: 'https://www.krea.ai/' }), { action: 'deny' });
  await new Promise((resolve) => setImmediate(resolve));
});
