import { describe, expect, it, vi } from 'vitest';
import { join, relative } from 'node:path';
// The upload record is asked for a stored name (lib/uploadNames.ts): no record here.
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ names: {} }), { status: 200 }))),
}));

import { CONTENT_HASH_NAME, fileParamName, shownFileName, UPLOADED_FILE } from '../src/lib/fileName';
import { uploadingLabel, uploadProjectChangedLine } from '../src/lib/uploadNotice';

// GM r48 Q1 on #222: a file param's name, everywhere it shows, is the name it
// was uploaded with, else the path's base name, and never a bare content
// hash ("Uploaded file"). One shared function names it (lib/fileName.ts
// fileParamName, and shownFileName for a name already in hand); this ratchet
// keeps every surface on it, so a new surface can't take a base name itself.

const SRC = join(__dirname, '../src');
const sources = import.meta.glob('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const files = Object.entries(sources)
  .filter(([path]) => !/\.test\.tsx?$/.test(path))
  .map(([path, text]) => [relative(SRC, join(__dirname, path)), text] as const);

// A base name taken by hand: a split on the path separators, then its last part.
const BASENAME = /\.split\(\s*(\/\[\\\\\/\]\/|'\/'|"\/"|\/\\\/\/)\s*\)\s*\.(pop\(\)|at\(-1\))/;

// Where a base name is taken for something other than a file param's name.
const ALLOWED: Record<string, string> = {
  'lib/fileName.ts': 'the shared name function itself (and storedName, the upload record key)',
  'components/nodes/WorldEnvironmentViewer.tsx': "a download's file name from its URL, not a file param",
  'components/commons/CommonsSettings.tsx': "a linked Commons folder's path, not a file param",
  'lib/spatialValue.ts': "a URI's extension, never shown",
  'lib/meshFormat.ts': "a mesh URL's extension, never shown",
};

describe('every file param name goes through fileParamName', () => {
  it('reads the source tree', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some(([path]) => path === 'components/panels/Inspector.tsx')).toBe(true);
  });

  it('no module takes a base name by hand, except where it is no file param name (each with its reason)', () => {
    const offenders = files.filter(([path, text]) => BASENAME.test(text) && !(path in ALLOWED)).map(([path]) => path);
    expect(offenders).toEqual([]);
    // An allowance that no longer matches goes, so the list stays honest.
    const stale = Object.keys(ALLOWED).filter((path) => !files.some(([p, text]) => p === path && BASENAME.test(text)));
    expect(stale).toEqual([]);
  });

  it('inputFileName (filePath\'s kept name only) is read by fileParamName alone', () => {
    const readers = files.filter(([path, text]) => path !== 'lib/fileName.ts' && /\binputFileName\(/.test(text)).map(([p]) => p);
    expect(readers).toEqual([]);
  });

  it('each surface names files through it: the Inspector row, the node face and the upload lines', () => {
    const text = (path: string) => files.find(([p]) => p === path)?.[1] ?? '';
    expect(text('components/panels/Inspector.tsx')).toMatch(/fileParamName\(activeNodeData\.params, param\.key\)/);
    expect(text('components/nodes/ModelNode.tsx')).toMatch(/fileParamName\(nodeData\.params, 'filePath'\)/);
    expect(text('lib/uploadNotice.ts').match(/shownFileName\(name\)/g)).toHaveLength(2);
  });

  it('the scan catches a base name taken by hand', () => {
    expect(BASENAME.test("const n = fileValue.split(/[\\\\/]/).pop();")).toBe(true);
    expect(BASENAME.test("const n = value.split('/').pop();")).toBe(true);
    expect(BASENAME.test('const n = value.split("/").pop();')).toBe(true);
    expect(BASENAME.test('const n = value.split(/\\//).pop();')).toBe(true);
    expect(BASENAME.test("const n = value.split(',');")).toBe(false);
    expect(BASENAME.test("const parts = url.pathname.split('/');")).toBe(false);
    expect(BASENAME.test("const n = value.split('/').at(-1);")).toBe(true);
  });
});

describe('a bare content hash never shows', () => {
  const hash = 'ab'.repeat(32);
  it.each([
    [`/out/chat-uploads/${hash}.png`],
    [`C:\\nebula\\${hash}.wav`],
    [hash],
    [`${'F'.repeat(40)}.jpeg`],
  ])('fileParamName(%s) is "Uploaded file" with no record', (path) => {
    expect(fileParamName({ filePath: path }, 'filePath')).toBe(UPLOADED_FILE);
    expect(fileParamName({ lut: path }, 'lut')).toBe(UPLOADED_FILE);
  });

  it("not even as filePath's kept name, nor in the upload lines", () => {
    const file = `${hash}.png`;
    expect(fileParamName({ filePath: `/out/${file}`, _fileName: { file, name: file } }, 'filePath')).toBe(UPLOADED_FILE);
    expect(uploadingLabel(file)).toBe('Uploading “Uploaded file”…');
    expect(uploadProjectChangedLine(file)).toContain('“Uploaded file”');
  });

  it('a name that only looks like hex stays', () => {
    expect(shownFileName('cafe.png')).toBe('cafe.png');
    expect(shownFileName(`${'a'.repeat(31)}.png`)).toBe(`${'a'.repeat(31)}.png`);
    expect(CONTENT_HASH_NAME.test(`${'a'.repeat(64)}.verylongext`)).toBe(false);
    expect(fileParamName({ filePath: '/looks/teal-orange.cube' }, 'filePath')).toBe('teal-orange.cube');
    expect(fileParamName({ filePath: '' }, 'filePath')).toBeNull();
  });
});
