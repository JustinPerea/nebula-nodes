import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { confineFileScheme, rendererFilePath } from '../renderer-files.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'nebula-renderer-files-'));
  const root = join(base, 'dist-desktop');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  writeFileSync(join(root, 'assets', 'index.js'), 'export {}');
  writeFileSync(join(base, 'settings.json'), '{"secret": true}');
  symlinkSync(join(base, 'settings.json'), join(root, 'assets', 'escape.json'));
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('files inside the renderer folder are served, with query and hash ignored', () => {
  const { root, cleanup } = fixture();
  try {
    const index = pathToFileURL(join(root, 'index.html')).href;
    assert.ok(rendererFilePath(index, root)?.endsWith('index.html'));
    assert.ok(rendererFilePath(`${index}#/project/1`, root));
    assert.ok(rendererFilePath(pathToFileURL(join(root, 'assets', 'index.js')).href + '?v=1', root));
  } finally {
    cleanup();
  }
});

test('anything outside it is refused: siblings, traversal, symlinks out, missing, other hosts', () => {
  const { base, root, cleanup } = fixture();
  try {
    assert.equal(rendererFilePath(pathToFileURL(join(base, 'settings.json')).href, root), null);
    assert.equal(rendererFilePath(pathToFileURL(root).href + '/../settings.json', root), null);
    assert.equal(rendererFilePath(pathToFileURL(root).href + '/assets/%2e%2e/%2e%2e/settings.json', root), null);
    assert.equal(rendererFilePath(pathToFileURL(join(root, 'assets', 'escape.json')).href, root), null);
    assert.equal(rendererFilePath(pathToFileURL(join(root, 'missing.js')).href, root), null);
    assert.equal(rendererFilePath(pathToFileURL(root).href, root), null, 'the folder itself is not a file');
    assert.equal(rendererFilePath(`${root}-other/index.html`, root), null);
    assert.equal(rendererFilePath('file://evil.example/etc/passwd', root), null);
    assert.equal(rendererFilePath('https://example.com/index.html', root), null);
    assert.equal(rendererFilePath('not a url', root), null);
  } finally {
    cleanup();
  }
});

test('the handler 404s outside reads and forwards inside ones to the built-in file handler', async () => {
  const { base, root, cleanup } = fixture();
  try {
    let handler;
    const forwarded = [];
    const warnings = [];
    confineFileScheme(
      { handle: (scheme, fn) => { assert.equal(scheme, 'file'); handler = fn; } },
      { fetch: (url, options) => { forwarded.push([url, options]); return new Response(readFileSync(new URL(url))); } },
      root,
      (line) => warnings.push(line),
    );
    const outside = await handler({ url: pathToFileURL(join(base, 'settings.json')).href });
    assert.equal(outside.status, 404);
    assert.equal(forwarded.length, 0);
    assert.equal(warnings.length, 1);
    const inside = await handler({ url: pathToFileURL(join(root, 'index.html')).href });
    assert.equal(inside.status, 200);
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0][1], { bypassCustomProtocolHandlers: true });
  } finally {
    cleanup();
  }
});

test('main.mjs confines file:// before any window loads, outside dev mode', () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const ready = source.lastIndexOf('app.whenReady().then(');
  const confine = source.indexOf('confineFileScheme(protocol, net, dirname(fileURLToPath(rendererUrl)));', ready);
  const firstWindow = source.indexOf('new BrowserWindow', ready);
  assert.ok(confine > ready, 'confinement must be installed in the main whenReady');
  assert.ok(firstWindow === -1 || confine < firstWindow);
  assert.match(source.slice(ready, confine), /if \(!isDevelopment\) \{\s*$/);
});
