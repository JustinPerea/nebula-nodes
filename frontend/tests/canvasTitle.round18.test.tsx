import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiFetchMock,
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(),
} }));

import type { NodeData } from '../src/types';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { canvasTitle, isDefaultTitle } from '../src/lib/directRoute';
import { runNodeName, summarizeRunScope } from '../src/lib/runScope';
import { changedNodesLine, placeholderRunConfirm, rowSegments } from '../src/lib/placeholderRunConfirm';
import { NodeLabel } from '../src/components/nodes/NodeLabel';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

/**
 * GM - Design, round 18, item 1 (verbatim): "Unnamed node: the default title
 * drops the route. "Grok Imagine 2.0" in all three places: card title "Grok
 * Imagine 2.0"; changed line "“Grok Imagine 2.0” changed while this was
 * open."; row "“Grok Imagine 2.0” · via xAI · $0.06". When the name already
 * is the model, the row drops the model and keeps only the route. A named
 * node keeps the full form: "“Alt still” · Grok Imagine 2.0 via xAI · $0.06".
 * On Krea: "“Grok Imagine 2.0” · via Krea · price not listed". Only for nodes
 * whose route depends on keys." Follow-up: "build the canvas-title-only
 * version. The library and search keep the catalog names, nothing is
 * migrated". "Unnamed = the saved label equals the catalog name or the
 * stripped name. New nodes are saved with the stripped title." And: "Add a
 * test that a node added after the change still reads as unnamed and follows
 * the rule."
 */

const PRICING = JSON.parse(readFileSync(resolve(__dirname, '../../backend/data/model_pricing.json'), 'utf8'));
const GROK = 'krea-image-xai-grok-imagine-2';
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };
const initialCache = useUIStore.getState().settingsCache;

function canvas(label: string) {
  const nodes = [
    { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', label: 'Prompt', params: { value: 'a fox' }, state: 'idle', outputs: {} } },
    { id: 'n2', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: GROK, label, params: {}, state: 'idle', outputs: {}, pending: codex } },
  ] as unknown as Node<NodeData>[];
  const edges = [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' }] as Edge[];
  return { nodes, edges };
}

function dialog(label: string, apiKeys: Record<string, string>) {
  const { nodes, edges } = canvas(label);
  const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 'n2' }, { pricing: PRICING, apiKeys, sizes: {} });
  return placeholderRunConfirm(nodes, edges, 'n2', summary)!;
}
const segments = (label: string, apiKeys: Record<string, string>) =>
  rowSegments(dialog(label, apiKeys).rows.find((row) => row.nodeId === 'n2')!);

const shownTitle = () => document.querySelector('.model-node__label')!;

beforeEach(() => {
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], runHistory: [], isExecuting: false,
    backendFreshStartPending: false, providerRecoveries: [], providerStartAmbiguities: [] });
  useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true, kreaConnectionMode: 'mcp' } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  useUIStore.setState({ settingsCache: initialCache });
  vi.restoreAllMocks();
});

describe('the canvas title: the display name without its gateway, for routes that depend on keys', () => {
  it('Grok Imagine 2.0 (Krea) reads "Grok Imagine 2.0"; Nano Banana (FAL) reads "Nano Banana"', () => {
    expect(canvasTitle(NODE_DEFINITIONS[GROK])).toBe('Grok Imagine 2.0');
    expect(canvasTitle(NODE_DEFINITIONS['nano-banana-fal'])).toBe('Nano Banana');
  });
  it('a node with one route, or a name that names no gateway, keeps its display name', () => {
    expect(canvasTitle(NODE_DEFINITIONS['gpt-image-1-5'])).toBe(NODE_DEFINITIONS['gpt-image-1-5'].displayName);
    const single = Object.values(NODE_DEFINITIONS).find((definition) => / \((Krea|FAL)\)$/.test(definition.displayName)
      && canvasTitle(definition) === definition.displayName);
    expect(single).toBeDefined();
  });
  it('the catalog keeps its names (#196): the definition is untouched', () => {
    expect(NODE_DEFINITIONS[GROK].displayName).toBe('Grok Imagine 2.0 (Krea)');
  });
  it('unnamed = either form of its own definition’s title', () => {
    const grok = NODE_DEFINITIONS[GROK];
    expect(isDefaultTitle(grok, 'Grok Imagine 2.0 (Krea)')).toBe(true);
    expect(isDefaultTitle(grok, 'Grok Imagine 2.0')).toBe(true);
    expect(isDefaultTitle(grok, 'Alt still')).toBe(false);
    // Another definition's stripped name is a name of its own.
    expect(isDefaultTitle(grok, 'Nano Banana')).toBe(false);
  });
});

describe('card title (NodeLabel)', () => {
  const grok = NODE_DEFINITIONS[GROK];
  const card = (label: string) => render(<NodeLabel nodeId="n2" label={label} displayName={grok.displayName}
    defaultTitle={canvasTitle(grok)} />);

  it('an old node saved under the catalog name reads "Grok Imagine 2.0", as unnamed', () => {
    card('Grok Imagine 2.0 (Krea)');
    expect(shownTitle().textContent).toBe('Grok Imagine 2.0');
    expect(shownTitle().getAttribute('title')).toBe('Double-click to rename');
  });
  it('a node saved under the stripped title reads the same, as unnamed', () => {
    card('Grok Imagine 2.0');
    expect(shownTitle().textContent).toBe('Grok Imagine 2.0');
    expect(shownTitle().getAttribute('title')).toBe('Double-click to rename');
  });
  it('a named node keeps its name, with the model as the hint', () => {
    card('Alt still');
    expect(shownTitle().textContent).toBe('Alt still');
    expect(shownTitle().getAttribute('title')).toBe('Grok Imagine 2.0 (Krea) · double-click to rename');
  });
});

describe('a node added after the change is saved with the stripped title and reads as unnamed', () => {
  // Round 21 (the #114 merge): addNode keeps no local copy (a failure adds
  // nothing) and sends no label, so the backend's own title names the node,
  // and its sync brings it in unnamed.
  it('addNode: no local fallback, and no label of its own', async () => {
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    const before = useGraphStore.getState().nodes.length;
    await useGraphStore.getState().addNode(GROK, { x: 0, y: 0 });
    expect(useGraphStore.getState().nodes).toHaveLength(before);
    const posted = apiFetchMock.mock.calls.find(([path, init]) => path === '/api/graph/node' && init?.method === 'POST');
    if (posted) expect(JSON.parse(String(posted[1].body))).not.toHaveProperty('label');
    const node = { id: 'n9', data: { definitionId: GROK, label: canvasTitle(NODE_DEFINITIONS[GROK]), params: {} } } as Node<NodeData>;
    expect(isDefaultTitle(NODE_DEFINITIONS[GROK], node.data.label)).toBe(true);
    expect(runNodeName(node, 'xai')).toBe('Grok Imagine 2.0 via xAI');
  });
  it('addNodeAndConnect', async () => {
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'text-input', label: 'Prompt', params: {}, state: 'idle', outputs: {} } }] as Node<NodeData>[] });
    apiFetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ id: 'n2', definitionId: GROK,
      connected: true, edge: { id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt',
        type: 'typed-edge', data: { dataType: 'Text' } } }) });
    await useGraphStore.getState().addNodeAndConnect(GROK, { x: 2, y: 3 }, {
      source: 'n1', target: '', sourceHandle: 'text', targetHandle: 'prompt', newNodeIs: 'target',
    });
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n2')?.data.label).toBe('Grok Imagine 2.0');
  });
  it('renaming to nothing goes back to the stripped title', () => {
    useGraphStore.setState({ nodes: [{ id: 'n2', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: GROK, label: 'Alt still', params: {}, state: 'idle', outputs: {} } }] as Node<NodeData>[] });
    apiFetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
    useGraphStore.getState().renameNode('n2', '   ');
    expect(useGraphStore.getState().nodes[0].data.label).toBe('Grok Imagine 2.0');
  });
});

describe('dialog rows and the changed line', () => {
  it('unnamed on the xAI key: “Grok Imagine 2.0” · via xAI · $0.06 (both saved forms)', () => {
    expect(segments('Grok Imagine 2.0 (Krea)', { XAI_API_KEY: 'x' })).toEqual(['“Grok Imagine 2.0”', 'via xAI', '$0.06']);
    expect(segments('Grok Imagine 2.0', { XAI_API_KEY: 'x' })).toEqual(['“Grok Imagine 2.0”', 'via xAI', '$0.06']);
  });
  it('unnamed on Krea: “Grok Imagine 2.0” · via Krea · price not listed', () => {
    expect(segments('Grok Imagine 2.0 (Krea)', { KREA_API_TOKEN: 'k' })).toEqual(['“Grok Imagine 2.0”', 'via Krea', 'price not listed']);
  });
  it('a named node keeps the full form', () => {
    expect(segments('Alt still', { XAI_API_KEY: 'x' })).toEqual(['“Alt still”', 'Grok Imagine 2.0 via xAI', '$0.06']);
  });
  it('the changed line names the unnamed node by its title', () => {
    const shown = dialog('Grok Imagine 2.0 (Krea)', { KREA_API_TOKEN: 'k' });
    const now = dialog('Grok Imagine 2.0 (Krea)', { XAI_API_KEY: 'x' });
    expect(changedNodesLine(shown, now)).toBe('“Grok Imagine 2.0” changed while this was open.');
  });
  it('the price footnote names it as its row does', () => {
    const model = dialog('Grok Imagine 2.0 (Krea)', { KREA_API_TOKEN: 'k' });
    expect(JSON.stringify(model.notes) + (model.totalLine ?? '')).not.toContain('(Krea)”');
  });
});
