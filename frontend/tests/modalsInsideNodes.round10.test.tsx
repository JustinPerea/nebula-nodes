import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { ReactFlow, ReactFlowProvider, applyNodeChanges, type Node, type NodeChange, type NodeProps } from '@xyflow/react';

/**
 * Review 9, M-1 (live LD1/LD2): the Mesh and World previews portal their
 * modal dialogs from inside the node card, and React bubbles a portal's
 * events to its React parents, so React Flow's node handlers saw them:
 * arrows on the Mesh preview's Close moved the node, Enter and Space
 * selected it, Escape deselected it, and a click or right-click inside
 * selected it or opened its menu. With React Flow (its real node wrapper),
 * nothing pressed or clicked inside an open preview changes the node.
 */

vi.mock('@google/model-viewer', () => ({}));
vi.mock('../src/components/nodes/WorldEnvironmentViewer', () => ({
  WorldEnvironmentViewer: () => <div data-testid="world-viewer" tabIndex={0} />,
}));

import { MeshPreview } from '../src/components/nodes/MeshPreview';
import { WorldPreview } from '../src/components/nodes/WorldPreview';

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const world = {
  schemaVersion: 1, provider: 'worldlabs', worldId: 'world-123', model: 'marble-1.1', displayName: 'Moonlit courtyard',
  marbleUrl: 'https://marble.worldlabs.ai/world/world-123', promptType: 'text',
  assets: { splats: { '100k': '/api/outputs/w-100k.spz', '500k': '/api/outputs/w-500k.spz' },
    panorama: '/api/outputs/p.jpg', colliderMesh: '/api/outputs/c.glb', thumbnail: '/api/outputs/t.jpg' },
  semantics: { metricScaleFactor: 1, groundPlaneOffset: 0, coordinateFrame: 'marble_raw_opencv' },
};

function MeshNode() { return <div style={{ width: 200, height: 120 }}><MeshPreview src="/api/outputs/m.glb" /></div>; }
function WorldNode() { return <div style={{ width: 200, height: 120 }}><WorldPreview value={world} /></div>; }
const nodeTypes = { mesh: MeshNode, world: WorldNode } as unknown as Record<string, React.ComponentType<NodeProps>>;

let latest: Node[] = [];
let setLatest: (update: (nodes: Node[]) => Node[]) => void = () => {};
const contextMenu = vi.fn();
function Flow({ type, selected }: { type: 'mesh' | 'world'; selected: boolean }) {
  const [nodes, setNodes] = useState<Node[]>([{ id: 'n', type, position: { x: 900, y: 160 }, selected, data: {}, width: 200, height: 120 }]);
  useEffect(() => {
    latest = nodes;
    setLatest = setNodes;
  }, [nodes]);
  return (
    <div style={{ width: 1280, height: 800 }}>
      <ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} deleteKeyCode={null} onNodeContextMenu={contextMenu}
        onNodesChange={(changes: NodeChange[]) => setNodes((current) => {
          const next = applyNodeChanges(changes, current);
          latest = next;
          return next;
        })} />
    </div>
  );
}

async function openPreview(type: 'mesh' | 'world', selected: boolean): Promise<HTMLElement> {
  render(<ReactFlowProvider><Flow type={type} selected={selected} /></ReactFlowProvider>);
  const trigger = type === 'mesh'
    ? screen.getByRole('button', { name: /open glb model preview/i })
    : screen.getByRole('button', { name: 'Explore 3D world: Moonlit courtyard' });
  await act(async () => { fireEvent.click(trigger); });
  const dialog = await screen.findByRole('dialog');
  // Opening clicked the trigger inside the node; start from the state under test.
  act(() => { setLatest((current) => current.map((n) => ({ ...n, selected }))); });
  return dialog;
}
const state = () => ({ position: [latest[0].position.x, latest[0].position.y], selected: Boolean(latest[0].selected) });
const closeOf = (type: 'mesh' | 'world') => screen.getByRole('button', { name: type === 'mesh' ? 'Close' : 'Close world viewer' });

describe.each(['mesh', 'world'] as const)('the %s preview, open over its node', (type) => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Offline fixture')));
    contextMenu.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'])('%s on its Close never moves the selected node', async (key) => {
    await openPreview(type, true);
    const before = state();
    act(() => { fireEvent.keyDown(closeOf(type), { key, code: key }); });
    expect(state().position).toEqual(before.position);
  });

  it.each(['Enter', ' '])('"%s" never selects the node behind it', async (key) => {
    await openPreview(type, false);
    act(() => { fireEvent.keyDown(closeOf(type), { key }); });
    expect(state().selected).toBe(false);
  });

  it('Escape closes the preview and leaves the node selected', async () => {
    await openPreview(type, true);
    act(() => { fireEvent.keyDown(closeOf(type), { key: 'Escape', code: 'Escape' }); });
    expect(state().selected).toBe(true);
  });

  it('a click on its backdrop closes it without selecting the node; a right-click opens no node menu', async () => {
    const dialog = await openPreview(type, false);
    act(() => { fireEvent.contextMenu(dialog); });
    expect(contextMenu).not.toHaveBeenCalled();
    act(() => { fireEvent.click(dialog.parentElement!); });
    expect(state().selected).toBe(false);
  });
});
