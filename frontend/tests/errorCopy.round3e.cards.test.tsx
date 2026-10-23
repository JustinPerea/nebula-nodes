/**
 * Error copy round 3e, item 1 (GM - Design): every card on the canvas says
 * why its node's run failed. Round 3c-2 found nine cards whose state turned
 * to error with no line at all (Video Edit, Remotion, Cinema Scene,
 * Character, Camera Rig, Reference Set, Moodboard, Paper source, and the
 * reroute dot). Each now renders the shared NodeError (lib/nodeErrorCopy):
 * "Couldn't run the node." over the person's line, the classifier's line or
 * GM's general line, the raw text behind a closed Details. It clears when the
 * node runs again, and reads the same after a reload (a graph sync carries
 * the same fields).
 *
 * The cases cover every type in CANVAS_NODE_TYPES, so a new card type fails
 * here until it shows its run error too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ComponentType } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '../src/types';
import type { ExecutionEvent } from '../src/lib/wsClient';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/api', async (importOriginal) => ({ ...await importOriginal<object>(),
  lookupStoredAsset: vi.fn().mockResolvedValue({ status: 'missing' }) }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { CANVAS_NODE_TYPES } from '../src/components/canvasTypes';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const HEADING = "Couldn't run the node.";
// Round 3f (GM): a card's general line, with no provider named. "Run the node
// again. If it keeps failing, Details shows what {Provider} said." when the run
// names one (tests/errorCopy.round3f.test.tsx).
const GENERAL = "Run the node again. If it keeps failing, open Details.";
const RAW = 'FAL submit failed (500): {"detail":"upstream exploded","request_id":"req_123"}';
const PERSON = 'Add your fal.ai API key in Settings, then run the node again.';
const TABLE_LINE = 'fal.ai is having trouble right now. Try again in a few minutes.';

/** One node per card type, as the canvas makes them (graphStore's nodeTypes map). */
const CASES: Record<string, Pick<NodeData, 'definitionId'> & Partial<NodeData>> = {
  'model-node': { definitionId: 'gpt-image-2-generate' },
  'dynamic-node': { definitionId: 'fal-universal', isDynamic: true, dynamicInputPorts: [], dynamicOutputPorts: [] } as Partial<NodeData> & { definitionId: string },
  'reroute-node': { definitionId: 'reroute' },
  editNode: { definitionId: 'video-edit' },
  remotionNode: { definitionId: 'remotion-node' },
  cinemaSceneNode: { definitionId: 'cinema-scene' },
  characterNode: { definitionId: 'character' },
  cameraRigNode: { definitionId: 'camera-rig' },
  referenceSetNode: { definitionId: 'reference-set' },
  moodboardNode: { definitionId: 'nebula-moodboard' },
  videoQcNode: { definitionId: 'qc-frame-review' },
  paperSourceNode: { definitionId: 'paper-source' },
  batchNode: { definitionId: 'batch' },
};

const heading = (root: ParentNode) => root.querySelector('.failure-lines__heading')?.textContent ?? null;
const reason = (root: ParentNode) => root.querySelector('.failure-lines__reason')?.textContent ?? null;

function seed(type: string, patch: Partial<NodeData>) {
  const node: Node<NodeData> = { id: 'n1', type, position: { x: 0, y: 0 },
    data: { label: 'n1', params: {}, state: 'idle', outputs: {}, ...CASES[type], ...patch } as NodeData };
  useGraphStore.setState({ nodes: [node], edges: [] });
}

/** The card as the canvas draws it: its data from the store, so a run event re-renders it. */
function Card({ type }: { type: string }) {
  const data = useGraphStore((state) => state.nodes.find((node) => node.id === 'n1')!.data);
  const Component = CANVAS_NODE_TYPES[type] as ComponentType<NodeProps>;
  return <Component {...({ id: 'n1', type, data, selected: false } as unknown as NodeProps)} />;
}

const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };
beforeEach(() => {
  useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys: {} } });
});
afterEach(() => {
  cleanup();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUi, true);
});

describe('every card on the canvas shows its run error', () => {
  it('covers every card type the canvas draws', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(CANVAS_NODE_TYPES).sort());
  });

  for (const type of Object.keys(CASES)) {
    describe(type, () => {
      it("shows GM's general line over a closed Details for raw provider text", () => {
        seed(type, { state: 'error', error: RAW, errorCategory: 'unknown', errorFriendly: RAW.slice(0, 140) });
        const { container } = render(<Card type={type} />);
        expect(heading(container)).toBe(HEADING);
        expect(reason(container)).toBe(GENERAL);
        const details = container.querySelector('details.error-details') as HTMLDetailsElement | null;
        expect(details).not.toBeNull();
        expect(details!.open).toBe(false);
        expect(details!.textContent).toContain('req_123');
        // The raw text is never the line itself.
        expect(container.querySelector('.model-node__error-message')?.textContent).not.toContain('req_123');
      });

      // Round 3d: a status-table line keeps the provider's own words behind Details.
      it("keeps the provider's words behind Details under a status-table line", () => {
        seed(type, { state: 'error', error: RAW, errorCategory: 'unknown', errorPerson: TABLE_LINE, errorProviderText: true });
        const { container } = render(<Card type={type} />);
        expect(heading(container)).toBe(HEADING);
        expect(reason(container)).toBe(TABLE_LINE);
        const details = container.querySelector('details.error-details') as HTMLDetailsElement | null;
        expect(details).not.toBeNull();
        expect(details!.open).toBe(false);
        expect(details!.textContent).toContain('req_123');
      });

      it("shows the person's line with no Details", () => {
        seed(type, { state: 'error', error: 'FAL_KEY is required', errorCategory: 'invalid_input', errorPerson: PERSON });
        const { container } = render(<Card type={type} />);
        expect(heading(container)).toBe(HEADING);
        expect(reason(container)).toBe(PERSON);
        expect(container.querySelector('details.error-details')).toBeNull();
        expect(container.textContent).not.toContain('FAL_KEY');
      });

      it('clears when the node runs again', () => {
        seed(type, { state: 'error', error: RAW, errorCategory: 'unknown' });
        const { container } = render(<Card type={type} />);
        expect(heading(container)).toBe(HEADING);
        act(() => useGraphStore.getState().handleExecutionEvent({ type: 'executing', nodeId: 'n1' } as ExecutionEvent));
        expect(heading(container)).toBeNull();
        expect(container.querySelector('details.error-details')).toBeNull();
      });
    });
  }
});

/** Round 3e review: a linked Paper source's run error stays through a graph
 * sync. The run's closing sync (an agent's run_nodes or `nebula run`) and
 * every later one carry the backend's 'error' (services/node_errors.py);
 * the Paper source merge used to set 'complete' or 'idle' over it. */
describe('a linked Paper source keeps its run error through a graph sync', () => {
  const identity = { fileId: 'file', pageId: 'page', objectId: 'logo', fileName: 'Brand', pageName: 'Logos',
    objectName: 'Editable logo', openUrl: 'https://app.paper.design/file', navigation: 'file' as const };
  const exportSettings = { format: 'png' as const, scale: '2x' as const, bounds: 'object' as const, background: 'artwork' as const };
  const snapshot = { id: 'snapshot-A', hash: 'A', capturedAt: '2026-10-01T12:00:01Z', width: 400, height: 200,
    hasAlpha: true, hasTransparency: true, filePath: '/api/outputs/paper/A.png', previewUrl: '/api/outputs/paper/A.png',
    identity, exportSettings };
  const linked = (withSnapshot: boolean) => ({ id: 'source', identity, exportSettings, state: 'current', sequence: 1,
    snapshot: withSnapshot ? snapshot : null, snapshots: withSnapshot ? [snapshot] : [] });
  const receive = async (event: Record<string, unknown>) => {
    const { wsClient } = await import('../src/lib/wsClient');
    const { GRAPH_PARAMS_VERSION } = await import('../src/lib/savedParamsUpgrades');
    const subscribe = wsClient.subscribe as unknown as { mock: { calls: [(event: ExecutionEvent) => void][] } };
    const listener = subscribe.mock.calls.at(-1)![0];
    act(() => listener({ type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, empty: false, edges: [], ...event } as unknown as ExecutionEvent));
  };
  const synced = (withSnapshot: boolean, patch: Partial<NodeData>) => ({
    id: 'n1', type: 'paperSourceNode', position: { x: 0, y: 0 },
    data: { label: 'Paper source', definitionId: 'paper-source', params: { _paperSource: linked(withSnapshot) },
      outputs: withSnapshot ? { image: { type: 'Image', value: snapshot.filePath } } : {}, ...patch },
  });

  for (const withSnapshot of [true, false]) {
    it(`keeps 'error' and its line ${withSnapshot ? 'over a pinned snapshot' : 'with no snapshot yet'}`, async () => {
      seed('paperSourceNode', { params: { _paperSource: linked(withSnapshot) }, state: withSnapshot ? 'complete' : 'idle',
        outputs: withSnapshot ? { image: { type: 'Image', value: snapshot.filePath } } : {} });
      const { container } = render(<Card type="paperSourceNode" />);
      expect(heading(container)).toBeNull();
      await receive({ nodes: [synced(withSnapshot, { state: 'error', error: RAW, errorCategory: 'unknown',
        errorFriendly: RAW.slice(0, 140) })] });
      expect(useGraphStore.getState().nodes[0].data.state).toBe('error');
      expect(heading(container)).toBe(HEADING);
      expect(reason(container)).toBe(GENERAL);
      // A later sync that still carries the error (any agent edit) keeps it too.
      await receive({ nodes: [synced(withSnapshot, { state: 'error', error: RAW, errorCategory: 'unknown' })] });
      expect(heading(container)).toBe(HEADING);
    });
  }

  it("still reads 'complete' from a sync with no error", async () => {
    seed('paperSourceNode', { params: { _paperSource: linked(true) }, state: 'idle', outputs: {} });
    render(<Card type="paperSourceNode" />);
    await receive({ nodes: [synced(true, { state: 'complete' })] });
    expect(useGraphStore.getState().nodes[0].data.state).toBe('complete');
  });
});
