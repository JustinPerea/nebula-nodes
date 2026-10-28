import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlow, ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react';

/**
 * PR #198 fix round 4 (review 4, L3; GM's r4 and r5 wording):
 * - A card or studio says "missing or damaged" only when the data check
 *   finds something wrong; otherwise GM's neutral line ("Nebula ran into a
 *   problem drawing it, but its data is fine. Reload Nebula to try again.")
 *   and the Agent log's "Couldn't draw “X”, node n4. <error message>".
 * - GM r4: a card keeps its header (icon and label) and replaces only the
 *   body; no "so Nebula can't show it." on cards.
 * - The studio boundary's own header can't take the app down: a header
 *   that throws gives a plain one with the way back.
 */

const flags = vi.hoisted(() => ({ headerThrows: false, iconThrows: false }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  backendAssetUrlSync: (url: string) => url,
}));
vi.mock('../src/components/WorkspaceHeader', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/components/WorkspaceHeader')>();
  return { ...original, WorkspaceHeader: (props: Parameters<typeof original.WorkspaceHeader>[0]) => {
    if (flags.headerThrows) throw new TypeError('the header broke');
    return original.WorkspaceHeader(props);
  } };
});
vi.mock('../src/components/nodes/NodeTypeIcon', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/components/nodes/NodeTypeIcon')>();
  return { ...original, NodeTypeIcon: (props: Parameters<typeof original.NodeTypeIcon>[0]) => {
    if (flags.iconThrows) throw new TypeError('the icon broke');
    return original.NodeTypeIcon(props);
  } };
});

import { withNodeCardBoundary } from '../src/components/nodes/withNodeCardBoundary';
import { StudioBoundary } from '../src/components/StudioBoundary';
import { CANVAS_NODE_TYPES } from '../src/components/canvasTypes';
import { nodeCardBoundaryLine, nodeDataProblem, studioBoundaryLine } from '../src/lib/studioBoundary';
import { useUIStore } from '../src/store/uiStore';

class NoResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoResizeObserver as unknown as typeof ResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };

beforeEach(() => {
  cleanup();
  flags.headerThrows = false;
  flags.iconThrows = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Boom(props: NodeProps) {
  if ((props.data as { boom?: boolean }).boom) throw new TypeError("Cannot read properties of null (reading 'id')");
  return <div data-testid="card-ok">fine</div>;
}
const types = { boom: withNodeCardBoundary(Boom) } as unknown as typeof CANVAS_NODE_TYPES;

function Flow({ nodes }: { nodes: Node[] }) {
  return (
    <ReactFlowProvider>
      <div style={{ width: 1200, height: 800 }}>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={types} />
      </div>
    </ReactFlowProvider>
  );
}

const card = (data: Record<string, unknown>): Node => ({ id: 'n7', type: 'boom', position: { x: 0, y: 0 },
  data: { boom: true, ...data } });

function logged(run: () => void): string[] {
  const lines: string[] = [];
  const listen = (event: Event) => lines.push((event as CustomEvent<{ message: string }>).detail.message);
  window.addEventListener('nebula:agent-log-entry', listen);
  try { run(); } finally { window.removeEventListener('nebula:agent-log-entry', listen); }
  return lines;
}

const NEUTRAL = 'Nebula ran into a problem drawing it, but its data is fine. Reload Nebula to try again.';

describe('L3: a card that throws on data that checks out', () => {
  it('GM r5: the neutral line, the header kept, the Agent log names the error', () => {
    const lines = logged(() => render(<Flow nodes={[card({ label: 'Hero still', definitionId: 'text-input',
      params: { text: '' }, outputs: {} })]} />));
    const boundary = document.querySelector('[data-node-card-boundary]')!;
    expect(boundary.querySelector('.node-card-boundary__line')!.textContent).toBe(`Couldn't show “Hero still”. ${NEUTRAL}`);
    // GM r4: the header (icon and label) stays; only the body is replaced.
    const header = boundary.querySelector('.node-card-boundary__header')!;
    expect(header.textContent).toContain('Hero still');
    expect(header.querySelector('[role="img"]')).not.toBeNull();
    expect(boundary.textContent).not.toMatch(/missing or damaged|so Nebula can't show it/);
    expect(lines).toEqual(["Couldn't draw “Hero still”, node n7. Cannot read properties of null (reading 'id')"]);
  });

  it('with no label: "Couldn\'t show this node. …"', () => {
    expect(nodeCardBoundaryLine(null, false)).toBe(`Couldn't show this node. ${NEUTRAL}`);
  });
});

describe('L3: a card whose data is damaged', () => {
  it.each([
    // Fix round 5 (GM r6 item 4): each is there but malformed, so "is damaged."
    ['params null', { label: 'Hero still', definitionId: 'text-input', params: null, outputs: {} }, 'params'],
    ['outputs null', { label: 'Hero still', definitionId: 'text-input', params: {}, outputs: null }, 'outputs'],
    ['an unknown definition', { label: 'Hero still', definitionId: 'remotion-composition', params: {}, outputs: {} }, 'definitionId'],
    ['clips not a list', { label: 'Hero still', definitionId: 'video-edit', params: { clips: 'x' }, outputs: {} }, 'clips'],
    ['a clip null', { label: 'Hero still', definitionId: 'video-edit', params: { clips: [null] }, outputs: {} }, 'clips[0]'],
    ['a layer a string', { label: 'Hero still', definitionId: 'remotion-node', params: { manifest: { timeline: ['x'] } }, outputs: {} }, 'manifest.timeline[0]'],
    ['a scene shot null', { label: 'Hero still', definitionId: 'cinema-scene', params: { scene: { shots: [null] } }, outputs: {} }, 'scene.shots[0]'],
  ])('%s: GM r4\'s damaged line', (_name, data, field) => {
    expect(nodeDataProblem(data)).toEqual({ field, state: 'damaged' });
    const lines = logged(() => render(<Flow nodes={[card(data)]} />));
    const boundary = document.querySelector('[data-node-card-boundary]')!;
    expect(boundary.querySelector('.node-card-boundary__line')!.textContent)
      .toBe('Couldn\'t show “Hero still”. Some of its data is missing or damaged.');
    expect(lines).toEqual([`Couldn't open “Hero still”, node n7. ${field} is damaged.`]);
  });

  it('a label that isn\'t text is damaged data, and the card says "this node"', () => {
    expect(nodeDataProblem({ label: { broken: true }, definitionId: 'text-input', params: {}, outputs: {} })).toEqual({ field: 'label', state: 'damaged' });
    render(<Flow nodes={[card({ label: { broken: true }, definitionId: 'text-input', params: {}, outputs: {} })]} />);
    expect(document.querySelector('.node-card-boundary__line')!.textContent)
      .toBe("Couldn't show this node. Some of its data is missing or damaged.");
  });

  it('data that checks out is not damaged', () => {
    expect(nodeDataProblem({ label: 'A', definitionId: 'video-edit', params: { clips: [{ id: 'c1' }] }, outputs: {} })).toBeNull();
    expect(nodeDataProblem({ label: 'A', definitionId: 'remotion-node', params: {}, outputs: {} })).toBeNull();
    expect(nodeDataProblem({ definitionId: 'cinema-scene', params: { scene: { version: 1, base: { model: 'm' },
      aspectRatio: '16:9', shots: [{ id: 's1', prompt: 'a' }] } } })).toBeNull();
  });

  it('a header icon that throws doesn\'t take the canvas down: the card still says why', () => {
    flags.iconThrows = true;
    render(<Flow nodes={[card({ label: 'Hero still', definitionId: 'text-input', params: {}, outputs: {} })]} />);
    expect(document.querySelector('.node-card-boundary__line')!.textContent).toBe(`Couldn't show “Hero still”. ${NEUTRAL}`);
    expect(document.querySelector('.node-card-boundary__header')!.textContent).toContain('Hero still');
  });
});

describe('L3: the studio boundary', () => {
  const Throws = () => { throw new TypeError('studio broke'); };

  it('GM r5: data that checks out reads the neutral studio line, with the same way back', () => {
    const exit = vi.fn();
    useUIStore.setState({ exitCinemaEditor: exit } as never);
    const lines = logged(() => render(<StudioBoundary studio="cinema-editor" node={{ id: 'n4', label: 'Opening' }}
      problem={() => null}><Throws /></StudioBoundary>));
    expect(document.querySelector('.studio-boundary__line')!.textContent)
      .toBe("Couldn't open “Opening”. Nebula ran into a problem showing it, but its data is fine. Reload Nebula to try again.");
    // GM r6 item 5 (fix round 5): the studio's own neutral Agent log line.
    expect(lines).toEqual(["Couldn't open “Opening” in Cinema, node n4. studio broke"]);
    fireEvent.click(screen.getByRole('button', { name: 'Back to canvas' }));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('damaged data keeps GM\'s approved studio line', () => {
    render(<StudioBoundary studio="cinema-editor" node={{ id: 'n4', label: 'Opening' }}
      problem={() => 'scene.base'}><Throws /></StudioBoundary>);
    expect(document.querySelector('.studio-boundary__line')!.textContent)
      .toBe("Couldn't open “Opening”. Some of its data is missing or damaged, so Nebula can't show it.");
    expect(studioBoundaryLine('editor', null, true)).toBe("Couldn't open this clip. Some of its data is missing or damaged, so Nebula can't show it.");
    expect(studioBoundaryLine('editor', null, false))
      .toBe("Couldn't open this clip. Nebula ran into a problem showing it, but its data is fine. Reload Nebula to try again.");
  });

  it('a header that throws stays inside the boundary: a plain header with the way back', () => {
    flags.headerThrows = true;
    const exit = vi.fn();
    useUIStore.setState({ exitCinemaEditor: exit } as never);
    expect(() => render(<StudioBoundary studio="cinema-editor" node={{ id: 'n4', label: 'Opening' }}
      problem={() => { throw new Error('the check broke too'); }}><Throws /></StudioBoundary>)).not.toThrow();
    expect(document.querySelector('.studio-boundary__line')).not.toBeNull();
    const back = screen.getByRole('button', { name: 'Back to Canvas' });
    act(() => { fireEvent.click(back); });
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
