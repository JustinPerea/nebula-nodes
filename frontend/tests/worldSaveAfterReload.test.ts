import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureProjectSnapshot, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import type { SavedProject } from '../src/lib/projects';
import * as execution from '../src/lib/api';
import { getBackendBaseUrl, rewriteExecutionAssetUrls } from '../src/lib/backend';
import { serializeGraph } from '../src/lib/graphFileShared';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { parseWorldValueV2 } from '../src/lib/spatialValue';
import { worldV2Fixture } from './fixtures/spatialValues';

// #185's live review: a project holding a World saved fine until the tab was
// reloaded. Loading it turned every backend-relative link in the snapshot into
// http://<backend>/api/outputs/... for display, the next save sent those back,
// and the backend's strict World contract refused them (400, "Save failed").
// Whatever the tab shows, what leaves it carries the links the backend gave.

vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  holdsPersonCredential: () => true,
}));
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(),
  openProject: vi.fn(), createProject: vi.fn(), recoverProject: vi.fn(),
}));

const THUMB = '/api/outputs/run-w/thumb.png';
const PANORAMA = '/api/outputs/run-w/pano.png';

// A full, valid World v2 (the strict card parser must accept it).
function worldValue() {
  return JSON.parse(JSON.stringify(worldV2Fixture)) as typeof worldV2Fixture;
}

function worldNode() {
  return {
    id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
    data: {
      definitionId: 'worldlabs-environment', label: 'World Labs Environment', params: {}, state: 'complete',
      outputs: {
        world: { type: 'World', value: worldValue() },
        panorama: { type: 'Image', value: PANORAMA },
        thumbnail: { type: 'Image', value: THUMB },
      },
    },
  };
}

function project(): SavedProject {
  return {
    id: 'alpha', name: 'alpha', createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [worldNode()] as never, edges: [], runHistory: [], viewport: { x: 0, y: 0, zoom: 1 }, createSessionId: null },
  };
}

const initial = useProjectStore.getState();
let unsubscribe: (() => void) | null = null;

beforeAll(async () => {
  // Test mode resolves the backend to http://localhost:8000 (a string only;
  // nothing is requested), as a reloaded tab resolves its real backend.
  await getBackendBaseUrl();
});

beforeEach(() => {
  vi.clearAllMocks();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], providerRecoveries: [], providerStartAmbiguities: [],
    isExecuting: false, isImportingGraph: false, createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION } as never);
  vi.mocked(projects.getProject).mockImplementation(async () => project());
  vi.mocked(projects.saveProject).mockImplementation(async (_id, snapshot) => ({ ...project(), snapshot }));
});

afterEach(async () => {
  unsubscribe?.(); unsubscribe = null;
  await Promise.resolve();
  setProjectContext(null);
});

function savedWorldNode(snapshot: { nodes: unknown[] }) {
  return snapshot.nodes[0] as ReturnType<typeof worldNode>;
}

describe('a World project saves after the tab reloads it', () => {
  it('shows absolute links, and the next save sends the relative ones it loaded', async () => {
    await useProjectStore.getState().initialize();
    // The tab holds the World as the backend gave it, so its strict card
    // parser accepts it (it resolves each link when it draws or fetches it);
    // plain media is still shown from the backend's own origin.
    const shown = useGraphStore.getState().nodes[0].data.outputs as Record<string, { value: unknown }>;
    expect(shown.world.value).toEqual(worldValue());
    expect(parseWorldValueV2(shown.world.value)).not.toBeNull();
    expect(shown.panorama.value).toBe(`http://localhost:8000${PANORAMA}`);

    unsubscribe = subscribeProjectAutosave();
    // The person moves the node.
    useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) => ({ ...node, position: { x: 300, y: 40 } })) });
    await vi.waitFor(() => expect(projects.saveProject).toHaveBeenCalledTimes(1));

    const sent = savedWorldNode(vi.mocked(projects.saveProject).mock.calls[0][1]);
    expect(sent.position).toEqual({ x: 300, y: 40 });
    expect(sent.data.outputs.world.value).toEqual(worldValue());
    expect(sent.data.outputs.panorama.value).toBe(PANORAMA);
    expect(sent.data.outputs.thumbnail.value).toBe(THUMB);
    await vi.waitFor(() => expect(useProjectStore.getState().saveStatus).toBe('saved'));
  });

  it('a World a run just made (websocket outputs rewritten for display) is captured with relative links', () => {
    const live = worldNode();
    live.data.outputs = rewriteExecutionAssetUrls(live.data.outputs);
    expect(live.data.outputs.panorama.value).toBe(`http://localhost:8000${PANORAMA}`);
    // The run's World stays as the backend sent it, and the card can show it.
    expect(live.data.outputs.world.value).toEqual(worldValue());
    expect(parseWorldValueV2(live.data.outputs.world.value)).not.toBeNull();
    useGraphStore.setState({ nodes: [live] as never });

    const node = savedWorldNode(captureProjectSnapshot());
    expect(node.data.outputs.world.value).toEqual(worldValue());
    expect(node.data.outputs.panorama.value).toBe(PANORAMA);
  });

  it('Save graph writes the relative links too', () => {
    const live = worldNode();
    live.data.outputs = rewriteExecutionAssetUrls(live.data.outputs);
    const file = serializeGraph([live] as never, []);
    expect(file.nodes[0].data.outputs).toEqual(worldNode().data.outputs);
  });
});
