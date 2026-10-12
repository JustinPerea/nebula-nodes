import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { FOLDER_PICKER_CHANNEL, folderPickerDefaultPath, registerFolderPickerHandler } from '../folder-picker.mjs';

function register({ trusted = true, window = { id: 1 }, result = { canceled: false, filePaths: ['/Users/me/out'] }, fail } = {}) {
  const calls = [];
  let handler;
  registerFolderPickerHandler(
    { handle: (name, fn) => { assert.equal(name, FOLDER_PICKER_CHANNEL); handler = fn; } },
    { showOpenDialog: async (...args) => { calls.push(args); if (fail) throw new Error(fail); return result; } },
    () => trusted,
    () => window,
  );
  return { handler, calls };
}

test('returns the picked folder, shown over the main window, starting where the setting points', async () => {
  const { handler, calls } = register();
  assert.deepEqual(await handler({}, '/Users/me/current'), { ok: true, path: '/Users/me/out' });
  assert.deepEqual(calls, [[{ id: 1 }, { properties: ['openDirectory', 'createDirectory'], defaultPath: '/Users/me/current' }]]);
});

test('a cancelled chooser returns no path', async () => {
  const { handler } = register({ result: { canceled: true, filePaths: [] } });
  assert.deepEqual(await handler({}, undefined), { ok: true, path: null });
});

test('drops start folders that are not plain absolute paths', async () => {
  for (const value of [undefined, null, 42, '', 'relative/dir', '~/Downloads', '/tmp/a\nb', '/x'.repeat(600)]) {
    assert.equal(folderPickerDefaultPath(value), undefined, JSON.stringify(value));
    const { handler, calls } = register();
    await handler({}, value);
    assert.deepEqual(calls[0][1], { properties: ['openDirectory', 'createDirectory'] });
  }
});

test('untrusted senders never open a chooser', async () => {
  const { handler, calls } = register({ trusted: false });
  assert.deepEqual(await handler({}, '/Users/me'), { ok: false, error: 'UNTRUSTED_SENDER' });
  assert.equal(calls.length, 0);
});

test('chooser failures come back as structured errors', async () => {
  const { handler } = register({ fail: 'no display' });
  assert.deepEqual(await handler({}, '/Users/me'), { ok: false, error: 'no display' });
});

test('preload exposes only a frozen choose method on the fixed channel', async () => {
  let metadata;
  const calls = [];
  const source = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  runInNewContext(source, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_key, value) => { metadata = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true, path: null }; } },
    }),
    process: { platform: 'darwin', argv: [] },
  });
  assert.equal(Object.isFrozen(metadata.folders), true);
  assert.deepEqual(Object.keys(metadata.folders), ['choose']);
  await metadata.folders.choose('/Users/me');
  assert.deepEqual(calls, [[FOLDER_PICKER_CHANNEL, '/Users/me']]);
});
