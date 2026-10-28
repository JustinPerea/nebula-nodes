import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlow, ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react';

/**
 * PR #198 fix round 5:
 * - Review 5, L5: a card that keeps failing writes one Agent log line per
 *   distinct error, not one per data change (the probe's running node wrote
 *   7 identical lines over 7 progress events). A card that draws again logs
 *   its next failure again.
 * - GM r6 item 4: the damaged Agent log says what the code knows: "<field>
 *   is missing." when absent, "<field> is damaged." when present but
 *   malformed, "missing or damaged" only when the code can't tell.
 * - GM r6 item 5: the studio's neutral Agent log line, "Couldn't open “X” in
 *   <studio>, node n4. <error message>".
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  backendAssetUrlSync: (url: string) => url,
}));

import { withNodeCardBoundary } from '../src/components/nodes/withNodeCardBoundary';
import { StudioBoundary } from '../src/components/StudioBoundary';
import { nodeDataProblem, studioBoundaryLogLine, studioDrawFailedLogLine } from '../src/lib/studioBoundary';

class NoResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoResizeObserver as unknown as typeof ResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };

beforeEach(() => {
  cleanup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Card(props: NodeProps) {
  const data = props.data as { boom?: string | false };
  if (data.boom) throw new TypeError(data.boom);
  return <div data-testid="card-ok">fine</div>;
}
const types = { boom: withNodeCardBoundary(Card) };

function Flow({ nodes }: { nodes: Node[] }) {
  return (
    <ReactFlowProvider>
      <div style={{ width: 1200, height: 800 }}>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={types as never} />
      </div>
    </ReactFlowProvider>
  );
}

const running = (progress: number, boom: string | false = 'draw bug'): Node => ({ id: 'n9', type: 'boom',
  position: { x: 0, y: 0 }, data: { label: 'Hero', definitionId: 'text-input', params: { text: `v${progress}` },
    outputs: {}, state: 'running', progress, boom } });

function logged(run: () => void): string[] {
  const lines: string[] = [];
  const listen = (event: Event) => lines.push((event as CustomEvent<{ message: string }>).detail.message);
  window.addEventListener('nebula:agent-log-entry', listen);
  try { run(); } finally { window.removeEventListener('nebula:agent-log-entry', listen); }
  return lines;
}

describe('L5: a card that keeps failing logs once per distinct error', () => {
  it('7 data changes of a running node that always throws: one line', () => {
    const lines = logged(() => {
      const view = render(<Flow nodes={[running(0)]} />);
      for (let i = 1; i <= 6; i += 1) act(() => { view.rerender(<Flow nodes={[running(i)]} />); });
    });
    expect(lines).toEqual(["Couldn't draw “Hero”, node n9. draw bug"]);
  });

  it('a different error is a new line; the same one again is not', () => {
    const lines = logged(() => {
      const view = render(<Flow nodes={[running(0)]} />);
      act(() => { view.rerender(<Flow nodes={[running(1, 'other bug')]} />); });
      act(() => { view.rerender(<Flow nodes={[running(2, 'other bug')]} />); });
      act(() => { view.rerender(<Flow nodes={[running(3)]} />); });
    });
    expect(lines).toEqual(["Couldn't draw “Hero”, node n9. draw bug", "Couldn't draw “Hero”, node n9. other bug"]);
  });

  it('a card that draws again logs its next failure again', () => {
    const lines = logged(() => {
      const view = render(<Flow nodes={[running(0)]} />);
      act(() => { view.rerender(<Flow nodes={[running(1, false)]} />); });
      expect(document.querySelector('[data-testid="card-ok"]')).not.toBeNull();
      act(() => { view.rerender(<Flow nodes={[running(2)]} />); });
    });
    expect(lines).toEqual(["Couldn't draw “Hero”, node n9. draw bug", "Couldn't draw “Hero”, node n9. draw bug"]);
  });
});

describe('GM r6 item 4: missing, damaged, or the code can\'t tell', () => {
  const card = (data: Record<string, unknown>): Node => ({ id: 'n4', type: 'boom', position: { x: 0, y: 0 },
    data: { boom: 'x', ...data } });

  it.each([
    ['no definitionId', { label: 'Hero', params: {}, outputs: {} }, 'definitionId', 'missing'],
    ['an unknown definition', { label: 'Hero', definitionId: 'remotion-composition', params: {}, outputs: {} }, 'definitionId', 'damaged'],
    ['params null', { label: 'Hero', definitionId: 'text-input', params: null, outputs: {} }, 'params', 'damaged'],
    ['outputs a string', { label: 'Hero', definitionId: 'text-input', params: {}, outputs: 'x' }, 'outputs', 'damaged'],
    ['clips not a list', { label: 'Hero', definitionId: 'video-edit', params: { clips: 'x' }, outputs: {} }, 'clips', 'damaged'],
    ['a clip null', { label: 'Hero', definitionId: 'video-edit', params: { clips: [null] }, outputs: {} }, 'clips[0]', 'damaged'],
    ['a manifest a string', { label: 'Hero', definitionId: 'remotion-node', params: { manifest: 'x' }, outputs: {} }, 'manifest', 'damaged'],
    ['no scene', { label: 'Hero', definitionId: 'cinema-scene', params: {}, outputs: {} }, 'scene', 'missing'],
    ['a scene shot null', { label: 'Hero', definitionId: 'cinema-scene', params: { scene: { shots: [null] } }, outputs: {} }, 'scene.shots[0]', 'damaged'],
    ['shots not a list', { label: 'Hero', definitionId: 'cinema-scene', params: { scene: { shots: 'x' } }, outputs: {} }, 'scene.shots', 'damaged'],
    ['no base (an older save)', { label: 'Hero', definitionId: 'cinema-scene', params: { scene: { shots: [] } }, outputs: {} }, 'scene.base', 'missing'],
    ['base a string', { label: 'Hero', definitionId: 'cinema-scene', params: { scene: { shots: [], base: 'x' } }, outputs: {} }, 'scene.base', 'damaged'],
    ['no base model', { label: 'Hero', definitionId: 'cinema-scene', params: { scene: { shots: [], base: {} } }, outputs: {} }, 'scene.base.model', 'missing'],
    ['a base model a number', { label: 'Hero', definitionId: 'cinema-scene', params: { scene: { shots: [], base: { model: 5 } } }, outputs: {} }, 'scene.base.model', 'damaged'],
    ['no aspect', { label: 'Hero', definitionId: 'cinema-scene', params: { scene: { shots: [], base: { model: 'm' } } }, outputs: {} }, 'scene.aspectRatio', 'missing'],
  ])('%s', (_name, data, field, state) => {
    expect(nodeDataProblem(data)).toEqual({ field, state });
    const lines = logged(() => render(<Flow nodes={[card(data)]} />));
    expect(lines).toEqual([`Couldn't open “Hero”, node n4. ${field} is ${state}.`]);
  });

  it('not an object at all', () => {
    expect(nodeDataProblem(undefined)).toEqual({ field: 'data', state: 'missing' });
    expect(nodeDataProblem('x')).toEqual({ field: 'data', state: 'damaged' });
  });

  it('a check that throws can\'t tell: "missing or damaged"', () => {
    const data = { label: 'Hero', definitionId: 'text-input', outputs: {}, boom: 'x',
      get params(): unknown { throw new TypeError('trap'); } };
    const lines = logged(() => render(<Flow nodes={[{ id: 'n4', type: 'boom', position: { x: 0, y: 0 }, data }]} />));
    expect(lines).toEqual(["Couldn't open “Hero”, node n4. data is missing or damaged."]);
  });

  it('the line from each kind, and a bare field the code can\'t tell', () => {
    expect(studioBoundaryLogLine('Opening', 'n4', { field: 'scene.base', state: 'missing' }))
      .toBe("Couldn't open “Opening”, node n4. scene.base is missing.");
    expect(studioBoundaryLogLine('Opening', 'n4', { field: 'scene.base', state: 'damaged' }))
      .toBe("Couldn't open “Opening”, node n4. scene.base is damaged.");
    expect(studioBoundaryLogLine('Opening', 'n4', 'node')).toBe("Couldn't open “Opening”, node n4. node is missing or damaged.");
    expect(studioBoundaryLogLine(null, 'n4', null)).toBe("Couldn't open a node, node n4. Its data couldn't be read.");
  });

  it('the studio logs the kind its check found', () => {
    const Throws = () => { throw new TypeError('studio broke'); };
    const lines = logged(() => render(<StudioBoundary studio="cinema-editor" node={{ id: 'n4', label: 'Opening' }}
      problem={() => ({ field: 'scene.base', state: 'damaged' })}><Throws /></StudioBoundary>));
    expect(lines).toEqual(["Couldn't open “Opening”, node n4. scene.base is damaged."]);
  });
});

describe('GM r6 item 5: the studio\'s neutral Agent log line', () => {
  const Throws = () => { throw new TypeError('studio broke'); };

  it('"Couldn\'t open “X” in <studio>, node n4. <error message>"', () => {
    const lines = logged(() => render(<StudioBoundary studio="cinema-editor" node={{ id: 'n4', label: 'Opening' }}
      problem={() => null}><Throws /></StudioBoundary>));
    expect(lines).toEqual(["Couldn't open “Opening” in Cinema, node n4. studio broke"]);
  });

  it('each studio by its name; a node with no name; an error with no message', () => {
    expect(studioDrawFailedLogLine('create', 'Opening', 'n4', new Error('x'))).toBe("Couldn't open “Opening” in Creator Studio, node n4. x");
    expect(studioDrawFailedLogLine('editor', 'Cut', 'n4', new Error('x'))).toBe("Couldn't open “Cut” in the video editor, node n4. x");
    expect(studioDrawFailedLogLine('remotion-editor', null, 'n4', new Error(''))).toBe("Couldn't open a node in the composition editor, node n4. An error with no message.");
  });
});
