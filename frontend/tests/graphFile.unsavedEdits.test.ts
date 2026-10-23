/**
 * Q116 a) (Justin, 2026-10-23): "a): "Download your edits" plus "Continue
 * without them"." The question's option: "Offer "Download your edits" (saves
 * them as a .nebula file you can open later) …".
 *
 * The held recovered copy is written with the graph file writer the app
 * already has (serializeGraph, the .nebula format), and the app's own open
 * path (Load graph: inspectGraphFileWithinLimit, then readGraphSelection, the
 * reader loadFromFile uses) reads it back with the same nodes, wires, params
 * and outputs. The writer lives in the startup entry (graphFileShared): this
 * screen shows up when Nebula was updated under the tab, which is exactly
 * when an old build's deferred chunk may be gone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as shared from '../src/lib/graphFileShared';
import { editsFileName, editsFileText, saveEditsToFile } from '../src/lib/graphFileShared';
import {
  GRAPH_JSON_MAX_IMPORT_BYTES, GRAPH_MAX_EDGES, GRAPH_MAX_NODES, GRAPH_MAX_VALUES, inspectGraphFileWithinLimit,
  readGraphSelection,
} from '../src/lib/graphFile';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import type { ProjectSnapshot } from '../src/lib/projects';

const snapshot: ProjectSnapshot = {
  nodes: [
    { id: 'n1', type: 'model-node', position: { x: 12, y: -40 },
      data: { definitionId: 'text-input', label: 'Prompt', params: { value: 'A glass bottle on wet sand' },
        state: 'idle', outputs: {} } },
    { id: 'n2', type: 'model-node', position: { x: 420, y: 60 },
      data: { definitionId: 'nano-banana', label: 'Image', params: { prompt: '', aspect_ratio: '16:9' },
        state: 'complete', outputs: { image: { type: 'Image', value: '/api/outputs/2026-10-23/bottle.png' } } } },
  ],
  edges: [{ id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt', type: 'typed-edge',
    data: { dataType: 'Text' } }],
  runHistory: [], viewport: { x: 30, y: -12, zoom: 0.75 }, createSessionId: null, createDraft: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe('the unsaved edits file', () => {
  it("is named after the project, made safe for a file name, and says it holds the unsaved edits", () => {
    expect(editsFileName('Glass campaign')).toBe('Glass campaign - unsaved edits.nebula');
    expect(editsFileName('Spring / Summer: v2?')).toBe('Spring Summer v2 - unsaved edits.nebula');
    expect(editsFileName('Café “Lune”')).toBe('Café “Lune” - unsaved edits.nebula');
    expect(editsFileName('  ..hidden.. ')).toBe('hidden - unsaved edits.nebula');
    expect(editsFileName('\u0000/\\')).toBe('Untitled project - unsaved edits.nebula');
    expect(editsFileName('x'.repeat(300))).toBe(`${'x'.repeat(80)} - unsaved edits.nebula`);
  });

  it('round-trips through the real open path: same nodes, wires, params and outputs', async () => {
    const text = editsFileText(snapshot, 'Glass campaign');
    const file = new File([text], editsFileName('Glass campaign'), { type: 'application/json' });
    const selection = await inspectGraphFileWithinLimit(file);
    expect(selection.isZip).toBe(false);
    const loaded = await readGraphSelection(selection);
    expect(loaded.paramsVersion).toBe(GRAPH_PARAMS_VERSION);
    expect(loaded.nodes.map((node) => ({ id: node.id, position: node.position, definitionId: node.data.definitionId,
      label: node.data.label, params: node.data.params, outputs: node.data.outputs }))).toEqual(snapshot.nodes.map((node) => ({
      id: node.id, position: node.position, definitionId: node.data.definitionId, label: node.data.label,
      params: node.data.params, outputs: node.data.outputs })));
    expect(loaded.edges.map(({ id, source, sourceHandle, target, targetHandle }) => ({ id, source, sourceHandle, target, targetHandle })))
      .toEqual([{ id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt' }]);
    expect(loaded.viewport).toEqual({ x: 30, y: -12, zoom: 0.75 });
  });

  it('saves through the save picker and reports the name the person chose', async () => {
    const written: unknown[] = [];
    const picker = vi.fn(async () => ({
      name: 'Glass campaign edits.nebula',
      createWritable: async () => ({ write: async (data: unknown) => { written.push(data); }, close: async () => {} }),
    }));
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = picker;
    await expect(saveEditsToFile(snapshot, 'Glass campaign')).resolves.toEqual({ name: 'Glass campaign edits.nebula', reopens: true });
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'Glass campaign - unsaved edits.nebula' }));
    expect(written).toHaveLength(1);
    const loaded = await readGraphSelection({ file: written[0] as Blob, isZip: false });
    expect(loaded.nodes.map((node) => node.id)).toEqual(['n1', 'n2']);
  });

  it('a cancelled save picker reports the cancel and downloads nothing', async () => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = vi.fn(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await expect(saveEditsToFile(snapshot, 'Glass campaign')).resolves.toBeNull();
    expect(click).not.toHaveBeenCalled();
  });

  it('without a save picker it downloads the file under its own name', async () => {
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const createObjectURL = vi.fn(() => 'blob:edits');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    await expect(saveEditsToFile(snapshot, 'Glass campaign')).resolves
      .toEqual({ name: 'Glass campaign - unsaved edits.nebula', reopens: true });
    expect(downloads).toEqual(['Glass campaign - unsaved edits.nebula']);
  });
});

/** Review: Load graph refuses a JSON file over 16 MiB, over 10,000 nodes or
 * 50,000 wires, or over 1,000,000 values. The backend refuses a recovered
 * copy over its own versions of those limits (413), so a held copy can be one
 * Load graph won't open. The file is still written (nothing is lost), and the
 * download says so instead of "Load graph … to bring them back". */
describe('an edits file Load graph cannot open', () => {
  const editsFileReopens = (shared as unknown as {
    editsFileReopens?: (text: string, file: shared.NebulaFile) => boolean;
  }).editsFileReopens;
  const node = snapshot.nodes[0];
  const many = (count: number) => ({ ...snapshot, nodes: Array.from({ length: count }, (_, index) => ({ ...node, id: `n${index}` })),
    edges: [] });
  const check = (edits: Pick<ProjectSnapshot, 'nodes' | 'edges' | 'viewport'>) => {
    const text = editsFileText(edits, 'Glass campaign');
    return editsFileReopens!(text, JSON.parse(text) as shared.NebulaFile);
  };

  it('the limits are the reader\'s own, in the startup entry', () => {
    expect(typeof editsFileReopens).toBe('function');
    const limits = shared as unknown as Record<string, unknown>;
    expect(limits.GRAPH_MAX_NODES).toBe(GRAPH_MAX_NODES);
    expect(limits.GRAPH_MAX_EDGES).toBe(GRAPH_MAX_EDGES);
    expect(limits.GRAPH_MAX_VALUES).toBe(GRAPH_MAX_VALUES);
    expect(limits.GRAPH_JSON_MAX_IMPORT_BYTES).toBe(GRAPH_JSON_MAX_IMPORT_BYTES);
  });

  it('reopens within every limit, and not past one', () => {
    expect(check(snapshot)).toBe(true);
    expect(check(many(GRAPH_MAX_NODES))).toBe(true);
    expect(check(many(GRAPH_MAX_NODES + 1))).toBe(false);
    const edge = snapshot.edges[0];
    expect(check({ ...snapshot, edges: Array.from({ length: GRAPH_MAX_EDGES + 1 }, (_, index) => ({ ...edge, id: `e${index}` })) }))
      .toBe(false);
    const values = { ...node, data: { ...node.data, params: { list: new Array(GRAPH_MAX_VALUES).fill(0) } } };
    expect(check({ ...snapshot, nodes: [values] })).toBe(false);
    const big = { ...node, data: { ...node.data, params: { value: 'x'.repeat(GRAPH_JSON_MAX_IMPORT_BYTES) } } };
    expect(check({ ...snapshot, nodes: [big] })).toBe(false);
  });

  it('agrees with the reader at the byte limit: the file is written compact', async () => {
    const text = editsFileText(snapshot, 'Glass campaign');
    expect(text).toBe(JSON.stringify(JSON.parse(text)));
  });

  it('still writes the file past a limit, and says it won\'t reopen', async () => {
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:edits'), revokeObjectURL: vi.fn() });
    await expect(saveEditsToFile(many(GRAPH_MAX_NODES + 1), 'Glass campaign')).resolves
      .toEqual({ name: 'Glass campaign - unsaved edits.nebula', reopens: false });
    expect(downloads).toEqual(['Glass campaign - unsaved edits.nebula']);
  });
});
