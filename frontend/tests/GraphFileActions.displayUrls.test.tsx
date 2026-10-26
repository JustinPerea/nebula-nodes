import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { worldV2Fixture } from './fixtures/spatialValues';

// Load graph shows what the backend imported the way every other read of the
// graph does (applyProject, fetchCLIGraph, CLI sync): this backend's relative
// links become absolute for display, so a packaged desktop tab (a file://
// page) can draw them. A World keeps its relative links (its strict contract).

const mocks = vi.hoisted(() => ({ saveToFile: vi.fn(), loadFromFile: vi.fn(), apiFetch: vi.fn() }));
vi.mock('../src/lib/graphFile', () => ({ saveToFile: mocks.saveToFile, loadFromFile: mocks.loadFromFile }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: mocks.apiFetch,
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ fitView: vi.fn(), getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    screenToFlowPosition: (position: { x: number; y: number }) => position }),
  useStore: () => [0, 0, 1],
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

import { GraphFileActions } from '../src/components/GraphFileActions';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { requestGraphLoad } from '../src/lib/graphFileActions';
import { getBackendBaseUrl } from '../src/lib/backend';

const IMAGE = '/api/outputs/run-a/image.png';
function node(): Node<NodeData> {
  return { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: {
    label: 'n1', definitionId: 'worldlabs-environment', params: {}, state: 'complete',
    outputs: {
      image: { type: 'Image', value: IMAGE },
      world: { type: 'World', value: JSON.parse(JSON.stringify(worldV2Fixture)) },
    },
  } };
}

const initialGraph = { ...useGraphStore.getState() };
const initialUI = { ...useUIStore.getState() };
let base = '';

beforeAll(async () => {
  // Test mode resolves the backend to a loopback origin (a string only).
  base = await getBackendBaseUrl();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadFromFile.mockResolvedValue({ nodes: [node()], edges: [], warnings: [],
    viewport: { x: 0, y: 0, zoom: 1 }, paramsVersion: 0 });
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ nodes: [node()], edges: [] }), { status: 200 }));
  useGraphStore.setState({ ...initialGraph, nodes: [], edges: [], isExecuting: false, createLaunchingIds: [] }, true);
  useUIStore.setState({ ...initialUI, viewMode: 'canvas' }, true);
});
afterEach(() => {
  useGraphStore.getState().releaseGraphImport();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
});

describe('Load graph display links', () => {
  it("shows the imported graph's backend links resolved, and leaves a World's links relative", async () => {
    expect(base).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
    render(<GraphFileActions />);
    act(() => requestGraphLoad());
    await waitFor(() => expect(useGraphStore.getState().nodes[0]?.id).toBe('n1'));
    const outputs = useGraphStore.getState().nodes[0].data.outputs;
    expect(outputs.image.value).toBe(`${base}${IMAGE}`);
    expect(outputs.world.value).toEqual(worldV2Fixture);
  });
});
