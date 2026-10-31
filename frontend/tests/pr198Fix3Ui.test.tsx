import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ReactFlow, ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react';

/**
 * PR #198 fix round 3 (review 3, GM's r3 rulings):
 * - L4: a canvas card whose data is damaged never takes the canvas down:
 *   Cinema, Remotion and the editor read through it, and any card that
 *   throws anyway shows GM's line at card size, keeps its wires, and tries
 *   again when its data changes.
 * - GM r3 (b): the studio boundary keeps the studio's header and replaces
 *   only the body; L6: the Commons' "Back to canvas" goes to the canvas.
 * - GM r3 (a): Composition's toolbar is a row under the offline row.
 * - G1: the context menu's Delete is disabled, with GM's tooltip, while a
 *   scene has a shot rendering.
 * - N1: a load-failure notice doesn't flash back for a frame on reconnect.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  backendAssetUrlSync: (url: string) => url,
}));

import { CANVAS_NODE_TYPES } from '../src/components/canvasTypes';
import { withNodeCardBoundary } from '../src/components/nodes/withNodeCardBoundary';
import { StudioBoundary } from '../src/components/StudioBoundary';
import { ContextMenu } from '../src/components/ContextMenu';
import { nodeCardBoundaryLine } from '../src/lib/studioBoundary';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { useOfflineHiddenNotice } from '../src/hooks/useOfflineHiddenNotice';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

class NoResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoResizeObserver as unknown as typeof ResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };

const source = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8');
const css = (file: string) => source(file).replace(/\/\*[\s\S]*?\*\//g, '');

beforeEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  useGraphStore.setState({ nodes: [], edges: [], activeRuns: [] } as never);
  vi.restoreAllMocks();
});

const cinemaNode = (scene: unknown, id = 'n1'): Node => ({ id, type: 'cinemaSceneNode', position: { x: 0, y: 0 },
  data: { label: 'Opening', definitionId: 'cinema-scene', params: { scene }, state: 'idle', outputs: {} } });

function Flow({ nodes, nodeTypes = CANVAS_NODE_TYPES }: { nodes: Node[]; nodeTypes?: typeof CANVAS_NODE_TYPES }) {
  return (
    <ReactFlowProvider>
      <div style={{ width: 1200, height: 800 }}>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} />
      </div>
    </ReactFlowProvider>
  );
}

// -- L4: damaged data on a card ----------------------------------------------------------

describe('L4: a card whose data is damaged never takes the canvas down', () => {
  const SHAPES: [string, unknown][] = [
    ['scene a string', 'not a scene'],
    ['scene null', null],
    ['shots null', { version: 1, base: { model: 'seedream-4-5' }, shots: null }],
    ['shots a string', { version: 1, shots: 'x' }],
    ['shots [null]', { version: 1, shots: [null] }],
    ['a shot a number', { version: 1, shots: [7, { id: 's1', prompt: 'a' }] }],
    ['prompt a number', { version: 1, shots: [{ id: 's1', prompt: 42 }] }],
    ['output a string', { version: 1, shots: [{ id: 's1', prompt: 'a', output: 'broken' }] }],
    ['base a string', { version: 1, base: 'seedream-4-5', shots: [{ id: 's1', prompt: 'a' }] }],
    ['no id', { version: 1, shots: [{ prompt: 'a' }] }],
  ];

  it.each(SHAPES)('Cinema scene with %s: its card draws, no boundary', (_name, scene) => {
    render(<Flow nodes={[cinemaNode(scene)]} />);
    expect(document.querySelector('[data-node-card-boundary]')).toBeNull();
    expect(document.querySelector('.react-flow__node')).not.toBeNull();
    expect(document.body.textContent).toContain('Cinema Scene');
  });

  it.each([
    ['remotionNode', 'remotion-composition', { manifest: 'broken' }],
    ['remotionNode', 'remotion-composition', { manifest: { timeline: null } }],
    ['editNode', 'video-edit', { clips: 'broken' }],
    ['editNode', 'video-edit', { clips: [null, 3] }],
  ])('%s (%s) with damaged params %j: no boundary', (type, definitionId, params) => {
    render(<Flow nodes={[{ id: 'n2', type, position: { x: 0, y: 0 },
      data: { label: 'Cut', definitionId, params, state: 'idle', outputs: {} } }]} />);
    expect(document.querySelector('[data-node-card-boundary]')).toBeNull();
  });

  it('every canvas card type is inside a boundary', () => {
    for (const card of Object.values(CANVAS_NODE_TYPES)) {
      expect(String((card as { type?: { displayName?: string } }).type?.displayName ?? '')).toMatch(/^Bounded\(/);
    }
  });

  it('a card that throws anyway: GM\'s line at card size, its handles kept, the Agent log told, and it tries again on new data', () => {
    const logged: string[] = [];
    const listen = (event: Event) => logged.push((event as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener('nebula:agent-log-entry', listen);
    function Boom(props: NodeProps) {
      if ((props.data as { broken?: boolean }).broken) throw new TypeError("Cannot read properties of null (reading 'id')");
      return <div data-testid="card-ok">fine</div>;
    }
    const types = { boom: withNodeCardBoundary(Boom) } as unknown as typeof CANVAS_NODE_TYPES;
    const node = (broken: boolean): Node => ({ id: 'n7', type: 'boom', position: { x: 0, y: 0 },
      data: { label: 'Hero still', definitionId: 'text-input', broken, params: {}, outputs: {} } });
    const { rerender } = render(<Flow nodes={[node(true)]} nodeTypes={types} />);
    window.removeEventListener('nebula:agent-log-entry', listen);
    // React Flow hides a node it hasn't measured (no roles then): by attribute.
    const alert = document.querySelector('[data-node-card-boundary]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    // Fix round 4 (review 4, L3; GM r4 and r5): data that checks out reads
    // the neutral line under the card's kept header, and the log names the error.
    expect(alert.querySelector('.node-card-boundary__line')!.textContent)
      .toBe("Couldn’t show “Hero still”. Nebula ran into a problem drawing it, but its data is fine. Reload Nebula to try again.");
    expect(alert.querySelectorAll('.react-flow__handle').length).toBeGreaterThan(0);
    expect(logged).toEqual(["Couldn’t draw “Hero still”, node n7. Cannot read properties of null (reading 'id')"]);
    rerender(<Flow nodes={[node(false)]} nodeTypes={types} />);
    expect(screen.getByTestId('card-ok')).toBeTruthy();
    expect(document.querySelector('[data-node-card-boundary]')).toBeNull();
  });

  it('with no label: "this node"', () => {
    expect(nodeCardBoundaryLine(null, true)).toBe("Couldn’t show this node. Some of its data is missing or damaged.");
  });
});

// -- GM r3 (b) and L6: the studio boundary ---------------------------------------------------

describe('GM r3 (b): the studio boundary keeps the header; L6: Commons goes back to the canvas', () => {
  const Boom = () => { throw new TypeError('broken'); };

  it('the studio\'s header (title, back to Canvas) stays and the line takes the body', () => {
    const exit = vi.fn();
    useUIStore.setState({ exitCinemaEditor: exit } as never);
    render(<StudioBoundary studio="cinema-editor" node={{ id: 'n4', label: 'Opening' }} problem={() => null}><Boom /></StudioBoundary>);
    const header = document.querySelector('.studio-boundary > header.workspace-header');
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain('Cinema');
    expect(document.querySelector('.studio-boundary__body [role="alert"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    expect(exit).toHaveBeenCalledTimes(1);
    const rule = css('styles/workspace-header.css');
    expect(rule).toMatch(/\.studio-boundary\s*\{[^}]*grid-template-areas:\s*"header"\s*"offline"\s*"body"/);
  });

  it('Commons: "Back to canvas" lands on the canvas, not where Commons was opened from', () => {
    const exitCommons = vi.fn();
    useUIStore.setState({ viewMode: 'commons', exitCommons } as never);
    render(<StudioBoundary studio="commons" node={null} problem={() => null}><Boom /></StudioBoundary>);
    fireEvent.click(screen.getByRole('button', { name: 'Back to canvas' }));
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(exitCommons).not.toHaveBeenCalled();
  });
});

// -- GM r3 (a): Composition's toolbar row ------------------------------------------------------

describe('GM r3 (a): Composition\'s offline row sits under the top header, above the toolbar', () => {
  it('the toolbar is its own row after the header, and the grid orders header, offline, toolbar', () => {
    const view = source('components/video-editor/RemotionEditorView.tsx');
    expect(view).toMatch(/<WorkspaceHeader[^>]*\/>\s*\{\/\*[^]*?\*\/\}\s*<div className="remotion-editor-view__toolbar"/);
    expect(view).not.toMatch(/<WorkspaceHeader[^/]*>\s*<RemotionEditorToolbar/);
    const rule = css('styles/remotion-editor.css');
    expect(rule).toMatch(/\.remotion-editor-view\s*\{[^}]*grid-template-areas:\s*"header header"\s*"offline offline"\s*"toolbar toolbar"/);
    expect(rule).toMatch(/\.remotion-editor-view__toolbar\s*\{[^}]*grid-area:\s*toolbar/);
  });
});

// -- G1: the disabled Delete ---------------------------------------------------------------------

describe('G1 / GM 1: Delete is disabled while the scene has a shot rendering', () => {
  const open = () => useUIStore.setState({ contextMenu: { visible: true, position: { x: 10, y: 10 }, nodeId: 'n4', flowPosition: null } } as never);
  const scene = (shots: unknown[]) => ({ version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots });

  it('with a Stop for the shot: "Stop the run first."', () => {
    useGraphStore.setState({ nodes: [{ ...cinemaNode(scene([{ id: 's1', prompt: 'a' }]), 'n4') }],
      activeRuns: [{ id: 'r1', kind: 'cinema-shot', nodeId: 'n4', shotId: 's1', nodeIds: ['n4'], status: 'running' }] } as never);
    open();
    render(<ContextMenu />);
    const remove = screen.getByRole('button', { name: /Delete/ });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'Stop the run first.');
  });

  it('rendering with no Stop here: "Wait for “Opening” to finish."', () => {
    useGraphStore.setState({ nodes: [cinemaNode(scene([{ id: 's1', prompt: 'a', output: { status: 'running' } }]), 'n4')],
      activeRuns: [] } as never);
    open();
    render(<ContextMenu />);
    expect(screen.getByRole('button', { name: /Delete/ })).toHaveAttribute('title', 'Wait for “Opening” to finish.');
  });

  it('nothing rendering: Delete is enabled', () => {
    useGraphStore.setState({ nodes: [cinemaNode(scene([{ id: 's1', prompt: 'a' }]), 'n4')], activeRuns: [] } as never);
    open();
    render(<ContextMenu />);
    expect(screen.getByRole('button', { name: /Delete/ })).toBeEnabled();
  });

  it('the Inspector and the selection toolbar read the same tooltip', () => {
    expect(source('components/panels/Inspector.tsx')).toMatch(/sceneDeleteDisabledTitle\(s, \[renderNodeId\]\)/);
    expect(source('components/SelectionToolbar.tsx')).toMatch(/sceneDeleteDisabledTitle\(state, ids\)/);
    // Canvas's Delete key keeps every deleted node's wires out of React Flow's own removal (round 5).
    expect(source('components/Canvas.tsx')).toMatch(/wiresDeletedWith\(/);
  });
});

// -- N1 ----------------------------------------------------------------------------------------------

describe('N1: a load-failure notice doesn\'t flash back on reconnect', () => {
  it('the first render back online shows nothing; the check clears it, so it never shows', () => {
    const shown: string[] = [];
    function Probe() {
      const [notice, setNotice] = useState<string | null>("Couldn't check the Commons status. Commons is disabled.");
      const visible = useOfflineHiddenNotice(notice, () => setNotice(null));
      shown.push(visible ?? 'none');
      return <p>{visible ?? 'none'}</p>;
    }
    render(<Probe />);
    act(() => noteBackendConnection('offline'));
    shown.length = 0;
    act(() => noteBackendConnection('online'));
    expect(shown.every((text) => text === 'none')).toBe(true);
    expect(screen.getByText('none')).toBeTruthy();
  });

  it('a notice the check keeps does come back', () => {
    const retry = vi.fn();
    function Probe() {
      const visible = useOfflineHiddenNotice('Character not found.', retry);
      return <p>{visible ?? 'none'}</p>;
    }
    render(<Probe />);
    act(() => noteBackendConnection('offline'));
    act(() => noteBackendConnection('online'));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Character not found.')).toBeTruthy();
  });
});
