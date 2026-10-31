import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundleRefusalLine, loadFromFile } from '../src/lib/graphFile';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';

// GM PR #205 r11 item 2: a bundle whose graph.json the backend's restore
// refuses for its shape reads, under "Nebula couldn’t load the canvas.", the
// line the same check gives a plain file. The line is picked by the answer's
// `code` (backend main._graph_file_refusal), never by its words; the
// backend's words stay the error's detail, for the log and for agents.

const LOAD = 'Nebula couldn’t load the canvas.';
const noticeStops: (() => void)[] = [];

function notices() {
  const spy = vi.fn();
  const listener = (event: Event) => spy((event as CustomEvent<CanvasNoticeDetail>).detail.text);
  window.addEventListener(CANVAS_NOTICE_EVENT, listener);
  noticeStops.push(() => window.removeEventListener(CANVAS_NOTICE_EVENT, listener));
  return spy;
}

function zipFile(): File {
  return new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])], { type: 'application/zip' }) as File;
}

function answer(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function loadBundleAnswering(response: Response) {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  const said = notices();
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(zipFile()) }]),
  });
  const result = await loadFromFile();
  return { result, said, errors, fetchMock };
}

afterEach(() => {
  for (const stop of noticeStops.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'showOpenFilePicker');
});

describe('a bundle’s graph.json refused by the restore (GM #205 r11 item 2)', () => {
  it.each([
    ['nested too deeply', 400, { detail: 'graph.json is nested too deeply', code: 'graph_too_complex' },
      'This file is too complex to open.'],
    ['too many values', 413, { detail: 'graph.json contains too many values', code: 'graph_too_complex' },
      'This file is too complex to open.'],
    ['too deep for the parser', 400, { detail: 'Invalid graph.json: maximum recursion depth exceeded', code: 'graph_too_complex' },
      'This file is too complex to open.'],
    ['a non-finite number', 400, { detail: 'graph.json contains a non-finite number', code: 'graph_unreadable_value' },
      'Part of this file holds a value Nebula can’t read.'],
    ['a number out of range', 400, { detail: 'Invalid graph.json: a number is out of range: NaN', code: 'graph_unreadable_value' },
      'Part of this file holds a value Nebula can’t read.'],
    ['too many nodes', 413, { detail: 'graph.json contains too many nodes', code: 'graph_too_many_nodes', maxNodes: 10_000 },
      'The canvas has more than 10,000 nodes.'],
    ['too many connections', 413, { detail: 'graph.json contains too many edges', code: 'graph_too_many_edges', maxEdges: 50_000 },
      'The canvas has more than 50,000 connections.'],
    ['too large', 413, { detail: 'graph.json is too large', code: 'graph_too_large',
      sizeBytes: 600 * 1024 * 1024, limitBytes: 528 * 1024 * 1024 },
      'This canvas is 600.0 MB. Nebula opens canvases up to 528 MB.'],
  ])('%s: the plain file’s line under the load heading; the backend’s words go to the log', async (_case, status, body, line) => {
    const { result, said, errors } = await loadBundleAnswering(answer(status, body));
    expect(result).toBeNull();
    expect(said.mock.calls).toEqual([[`${LOAD} ${line}`]]);
    expect(said.mock.calls[0][0]).not.toContain(body.detail);
    // The log keeps the engine's exact reason.
    expect(errors).toHaveBeenCalledWith('[nebula] graph load', body.detail);
  });

  // GM PR #205 r12: graph.json that isn't a Nebula graph, and the zip's own
  // checks. Each kind, as the backend sends it, and the line under the
  // load heading; the backend's words go to the log.
  const DAMAGED = 'This file is damaged or isn’t a Nebula canvas.';
  const COMPLEX = 'This file is too complex to open.';
  it.each([
    ['graph_invalid', 400, 'graph.json must contain an object', {}, DAMAGED],
    ['graph_invalid', 400, 'Invalid graph.json: Expecting value: line 1 column 1 (char 0)', {}, DAMAGED],
    ['graph_invalid', 400, 'nodes[0].data.label must be a string', {}, DAMAGED],
    ['graph_newer_version', 400, 'Unsupported .nebula file version', { version: 4 },
      'This file is from a newer Nebula. Update Nebula, then open it again.'],
    ['bundle_not_zip', 400, 'Not a valid zip bundle: File is not a zip file', {}, DAMAGED],
    ['bundle_encrypted', 400, 'Encrypted zip bundles are not supported', {}, DAMAGED],
    ['bundle_unsupported_compression', 400, 'Zip bundle uses an unsupported compression method', {}, DAMAGED],
    ['bundle_unsafe_path', 400, 'Zip bundle contains duplicate or colliding paths', {}, DAMAGED],
    ['bundle_path_too_long', 400, 'Zip bundle path is too long', { maxPathBytes: 1024 }, DAMAGED],
    ['bundle_link', 400, 'Zip bundle contains a symlink', {}, DAMAGED],
    ['bundle_special_file', 400, 'Zip bundle contains a special file', {}, DAMAGED],
    ['bundle_size_metadata', 400, 'Zip bundle contains invalid size metadata', {}, DAMAGED],
    ['bundle_missing_graph', 400, 'Zip bundle is missing graph.json', {}, DAMAGED],
    ['bundle_too_many_members', 413, 'Zip bundle contains too many members', { maxMembers: 4096 }, COMPLEX],
    ['bundle_expands_too_far', 413, 'Zip bundle expands beyond the restore limit', { limitBytes: 8 }, COMPLEX],
    ['bundle_unsafe_ratio', 413, 'Zip bundle member has an unsafe compression ratio', { maxRatio: 250 }, COMPLEX],
    ['bundle_restore_failed', 500, 'Could not restore zip bundle assets', {}, 'Its files couldn’t be copied. Try again.'],
  ])('%s (%s): the line under the load heading', async (code, status, detail, fields, line) => {
    const { result, said, errors } = await loadBundleAnswering(answer(status, { detail, code, ...fields }));
    expect(result).toBeNull();
    expect(said.mock.calls).toEqual([[`${LOAD} ${line}`]]);
    expect(errors).toHaveBeenCalledWith('[nebula] graph load', detail);
  });

  it('a 500 with no code reads as it did', async () => {
    const { said } = await loadBundleAnswering(answer(500, { detail: 'Restored bundle returned an invalid URL mapping' }));
    expect(said.mock.calls).toHaveLength(1);
    expect(said.mock.calls[0][0]).toMatch(/^Nebula couldn’t load the canvas\. /);
    expect(said.mock.calls[0][0]).not.toContain('Its files couldn’t be copied.');
  });

  it('the node line uses the limit the answer carries', async () => {
    const { said } = await loadBundleAnswering(answer(413,
      { detail: 'graph.json contains too many nodes', code: 'graph_too_many_nodes', maxNodes: 2_500 }));
    expect(said).toHaveBeenCalledWith(`${LOAD} The canvas has more than 2,500 nodes.`);
  });

  it.each([
    ['an unknown code', 400, { detail: 'graph.json has a new problem', code: 'graph_something_new' },
      `${LOAD} graph.json has a new problem`],
    ['no code', 400, { detail: 'graph.json must contain an object' }, `${LOAD} graph.json must contain an object`],
    ['a size with no numbers', 413, { detail: 'graph.json is too large', code: 'graph_too_large' },
      `${LOAD} graph.json is too large`],
  ])('%s: the answer reads as it did, with the backend’s words', async (_case, status, body, line) => {
    const { said } = await loadBundleAnswering(answer(status, body));
    expect(said.mock.calls).toEqual([[line]]);
  });

  it('an empty refusal still reads as one under the load heading', async () => {
    const { said } = await loadBundleAnswering(new Response('', { status: 400 }));
    expect(said.mock.calls).toEqual([[`${LOAD} Try again, or reload if it keeps happening.`]]);
  });
});

describe('bundleRefusalLine', () => {
  it('falls back to this tab’s limit when the answer’s is missing or not a positive whole number', () => {
    for (const maxNodes of [undefined, 0, -3, 1.5, '10', Number.NaN]) {
      expect(bundleRefusalLine({ code: 'graph_too_many_nodes', maxNodes })).toBe('The canvas has more than 10,000 nodes.');
    }
    for (const maxEdges of [undefined, 0, '9']) {
      expect(bundleRefusalLine({ code: 'graph_too_many_edges', maxEdges })).toBe('The canvas has more than 50,000 connections.');
    }
  });

  it('is null for anything that isn’t a shape refusal', () => {
    for (const body of [null, 'graph_too_complex', [], {}, { code: 7 }, { code: 'person_required' },
      { code: 'graph_too_large', sizeBytes: 5 }, { code: 'graph_too_large', limitBytes: 64 },
      { code: 'graph_too_large', sizeBytes: 0, limitBytes: 64 }]) {
      expect(bundleRefusalLine(body)).toBeNull();
    }
  });
});
