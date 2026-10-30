import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * PR #198 fix round 23, rendered:
 * - GM r34: the state lines and the card's "Unsaved" mark read the scene's
 *   name live (a rename during a try shows at once; the mark too).
 * - Review 21 NIT-5: focus lands on a line with no [Try again] (the run's
 *   line) when the line focus was in, or an answered clash prompt, gives way
 *   to it.
 */
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async () => new Response('{}', { status: 200 }),
}));

import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { NoticeRegion } from '../src/components/NoticeRegion';
import { CinemaSceneNode } from '../src/components/nodes/CinemaSceneNode';
import { useGraphStore } from '../src/store/graphStore';

const LAZY = { timeout: 10_000 };
const initial = useGraphStore.getState();
afterEach(() => {
  cleanup();
  document.querySelectorAll('.canvas-wrapper').forEach((el) => el.remove());
  vi.restoreAllMocks();
  useGraphStore.setState(initial, true);
});

const scene = (id: string, label: string, x: number) => ({ id, type: 'cinemaSceneNode', position: { x, y: 0 },
  data: { label, definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } });
const set = (state: Record<string, unknown>) => act(() => { useGraphStore.setState(state as never); });
const SERVER = (name: string) => `Nebula couldn’t save your changes to “${name}”. They’re kept, and Nebula will try again with your next change.`;
const SHOT2 = (name: string) => `Nebula couldn’t save your changes to “${name}”. Shot 2 has no model.`;
const RUN_ONE = 'Your changes to “Opening” are kept. Nebula will save them when the run finishes.';
const CLASH = 'Codex changed “Opening” while you were editing it.';
const base = { stoppedScenes: {}, sceneTries: {}, scenePopover: null, undoNotice: null, messageNotice: null, sceneClashes: {} };
const shot2Stop = { cause: 'other', reason: 'Shot 2 has no model.', nebula: false, line: SHOT2('Opening') };

describe('GM r34: names read live', () => {
  it('the card’s mark says its stop’s line with the name the card shows now, not the one it had when the save failed', () => {
    const props = { id: 'n1', selected: false, type: 'cinemaSceneNode', dragging: false, zIndex: 0, isConnectable: true,
      positionAbsoluteX: 0, positionAbsoluteY: 0, selectable: true, deletable: true, draggable: true,
      data: { label: 'Opening', definitionId: 'cinema-scene', state: 'idle', outputs: {},
        params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [] } } } } as unknown as NodeProps;
    useGraphStore.setState({ ...base, nodes: [scene('n1', 'Opening', 0)], unsavedScenes: { n1: SERVER('Opening') },
      stoppedScenes: { n1: true }, sceneStops: { n1: { cause: 'server' } }, retrySceneSave: vi.fn() } as never);
    const { container } = render(<ReactFlowProvider><CinemaSceneNode {...props} /></ReactFlowProvider>);
    const mark = () => container.querySelector('.cinema-scene-node__unsaved') as HTMLElement;
    expect(mark().getAttribute('title')).toBe(SERVER('Opening'));
    set({ nodes: [scene('n1', 'Renamed', 0)] });
    expect(mark().getAttribute('title')).toBe(SERVER('Renamed'));
    // During a try, the stop it came out of, by the new name too.
    set({ stoppedScenes: {}, sceneTries: { n1: shot2Stop } });
    expect(mark().getAttribute('title')).toBe(SHOT2('Renamed'));
  });

  it('a rename during a try: the line names the new name in the same render, still held', async () => {
    useGraphStore.setState({ ...base, nodes: [scene('n1', 'Opening', 0)], stoppedScenes: { n1: true }, sceneStops: { n1: shot2Stop },
      retrySceneSave: vi.fn() } as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(SHOT2('Opening'), {}, LAZY);
    set({ stoppedScenes: {}, sceneTries: { n1: shot2Stop } });
    set({ nodes: [scene('n1', 'Renamed', 0)] });
    const line = document.querySelector('[data-scene-stop]') as HTMLElement;
    expect(line.textContent).toContain(SHOT2('Renamed'));
    expect(line.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(SHOT2('Opening'))).toBeNull();
  });
});

describe('review 21 NIT-5: focus onto a line with no [Try again]', () => {
  const canvas = () => {
    const el = document.createElement('div');
    el.className = 'canvas-wrapper';
    el.tabIndex = 0;
    document.body.appendChild(el);
    return el;
  };

  it('[Try again] focused, its scene’s line becomes the run’s line: focus goes to that line itself', async () => {
    canvas();
    useGraphStore.setState({ ...base, nodes: [scene('n1', 'Opening', 0)], stoppedScenes: { n1: true }, sceneStops: { n1: { cause: 'server' } },
      retrySceneSave: vi.fn() } as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(SERVER('Opening'), {}, LAZY);
    (document.querySelector('[data-scene-stop] button') as HTMLButtonElement).focus();
    set({ stoppedScenes: {}, sceneStops: { n1: { cause: 'run-lock' } } });
    await screen.findByText(RUN_ONE, {}, LAZY);
    await vi.waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('data-scene-stop')).toBe('run-lock'),
      { timeout: 5000, interval: 5 });
    expect(document.activeElement?.tagName).toBe('DIV');
  });

  it('an answered clash prompt goes and the run’s line takes the scene: focus goes to that line itself, not the × rule’s first line', async () => {
    canvas();
    // Another scene's 400 line ranks first in the slot: the × rule alone would land there.
    useGraphStore.setState({ ...base, nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300)],
      stoppedScenes: { n2: true }, sceneStops: { n2: { cause: 'bad-save' } },
      sceneClashes: { n1: { id: 71, line: CLASH, agent: 'Codex' } },
      resolveSceneClash: (id: string) => { useGraphStore.setState((s) => ({ sceneClashes: { ...s.sceneClashes,
        [id]: { ...(s.sceneClashes as Record<string, object>)[id], sending: 'mine' } } }) as never); } } as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(CLASH, {}, LAZY);
    const keep = document.querySelector('[data-scene-clash="n1"] button') as HTMLButtonElement;
    keep.focus();
    fireEvent.click(keep, { detail: 0 });
    set({ sceneClashes: {}, sceneStops: { n1: { cause: 'run-lock' }, n2: { cause: 'bad-save' } } });
    await vi.waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('data-scene-stop')).toBe('run-lock'),
      { timeout: 5000, interval: 5 });
    expect([...document.querySelectorAll('[data-scene-stop]')].map((el) => el.getAttribute('data-scene-stop'))).toEqual(['bad-save', 'run-lock']);
  });
});
