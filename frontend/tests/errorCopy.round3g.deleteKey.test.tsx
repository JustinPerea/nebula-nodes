/**
 * Error copy round 3g, GM item 1 (option c), on the canvas itself: the Delete
 * and Backspace keys (React Flow's onBeforeDelete) ask "Delete this node?" /
 * "Delete {n} nodes?" only when the delete would detach a pin or close an
 * open proposal (lib/deleteConfirm.ts deleteLosesAttachments, read from the
 * canvas's own pin and proposal stores). Otherwise the key deletes with no
 * confirm. A World Labs hold still refuses first (round 3b).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

type FlowProps = {
  onBeforeDelete?: (elements: { nodes: { id: string }[]; edges: { id: string }[] }) => Promise<boolean>;
  deleteKeyCode?: string[] | null;
};
let flow: FlowProps = {};
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  ReactFlow: (props: FlowProps) => { flow = props; return null; },
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from '../src/components/Canvas';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { useAssetProposalsStore } from '../src/store/assetProposalsStore';
import { publishOpenProject } from '../src/lib/currentProject';
import type { Pin, ProposalView } from '../src/lib/wsClient';
import type { AssetProposalView } from '../src/lib/assetProposals';

const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };

function node(id: string, image?: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: image
      ? { label: 'Nano Banana', definitionId: 'nano-banana', params: {}, outputs: { image: { type: 'Image', value: image } }, state: 'complete' }
      : { label: 'Text Input', definitionId: 'text-input', params: { value: 'hello' }, outputs: {}, state: 'idle' } };
}

function pinOn(nodeId: string): Pin {
  return { id: `pin-${nodeId}`, text: 'Check this', anchor: { nodeId }, position: null, status: 'open', createdAt: '', detached: false,
    reply: null } as Pin;
}

function proposalReading(nodeId: string): ProposalView {
  return { id: `prop-${nodeId}`, status: 'open', references: [nodeId] } as unknown as ProposalView;
}

beforeEach(() => {
  flow = {};
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  useGraphStore.setState({ nodes: [node('n1'), node('n2')], edges: [], isExecuting: false });
  useCanvasPinsStore.setState({ pins: [] });
  useCanvasProposalsStore.setState({ proposals: {} });
  useAssetProposalsStore.setState({ proposals: {} });
  publishOpenProject(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUi, true);
  useCanvasPinsStore.setState({ pins: [] });
  useCanvasProposalsStore.setState({ proposals: {} });
  useAssetProposalsStore.setState({ proposals: {} });
  publishOpenProject(null);
});

const mount = () => render(<ReactFlowProvider><Canvas /></ReactFlowProvider>);
const press = async (...ids: string[]) => {
  let allowed: boolean | undefined;
  await act(async () => { allowed = await flow.onBeforeDelete!({ nodes: ids.map((id) => ({ id })), edges: [] }); });
  return allowed;
};

describe('the Delete key', () => {
  it('is the canvas\'s Delete and Backspace', () => {
    mount();
    expect(flow.deleteKeyCode).toEqual(['Backspace', 'Delete']);
  });

  it('deletes a plain node with no confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    expect(await press('n1')).toBe(true);
    expect(await press('n1', 'n2')).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks when a doomed node has a pin, with GM\'s plural', async () => {
    useCanvasPinsStore.setState({ pins: [pinOn('n2')] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    expect(await press('n1')).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(await press('n2')).toBe(false);
    expect(confirm).toHaveBeenLastCalledWith('Delete this node?');
    expect(await press('n1', 'n2')).toBe(false);
    expect(confirm).toHaveBeenLastCalledWith('Delete 2 nodes?');
    confirm.mockReturnValue(true);
    expect(await press('n2')).toBe(true);
  });

  it('asks when an open proposal reads a doomed node', async () => {
    useCanvasProposalsStore.setState({ proposals: { 'prop-n1': { view: proposalReading('n1'), acceptKey: 'k' } } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    expect(await press('n2')).toBe(true);
    expect(await press('n1')).toBe(false);
    expect(confirm).toHaveBeenCalledWith('Delete this node?');
  });

  it('asks when an open cover proposal for this project needs the doomed node\'s image', async () => {
    useGraphStore.setState({ nodes: [node('n1', '/api/outputs/a.png'), node('n2', '/api/outputs/b.png')] });
    publishOpenProject({ id: 'p1', name: 'Open now' });
    const view = { id: 'ap1', status: 'open', kind: 'project', target: { kind: 'project', id: 'p1', name: 'Open now' },
      change: { cover: { from: null, to: '/api/outputs/a.png', fromBy: null } } } as unknown as AssetProposalView;
    useAssetProposalsStore.setState({ proposals: { ap1: { view, acceptKey: 'k' } } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    expect(await press('n2')).toBe(true);
    expect(await press('n1')).toBe(false);
    expect(confirm).toHaveBeenCalledWith('Delete this node?');
  });

  it('a press that removes only wires asks nothing', async () => {
    useCanvasPinsStore.setState({ pins: [pinOn('n1')] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    expect(await press()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
