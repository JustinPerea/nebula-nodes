import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

/**
 * PR #198 fix round 24, rendered: review 22 LOW-3 (GM r34): the card's
 * "Unsaved" mark reads the scene's name live while its timed retries go,
 * and once they give way to another line, that line's.
 */
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async () => new Response('{}', { status: 200 }),
}));

import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { CinemaSceneNode } from '../src/components/nodes/CinemaSceneNode';
import { useGraphStore } from '../src/store/graphStore';

const initial = useGraphStore.getState();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useGraphStore.setState(initial, true);
});

const scene = (id: string, label: string) => ({ id, type: 'cinemaSceneNode', position: { x: 0, y: 0 },
  data: { label, definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } });
const set = (state: Record<string, unknown>) => act(() => { useGraphStore.setState(state as never); });
const RETRYING = (name: string) => `Nebula couldn’t save your changes to “${name}”. They’re kept, and Nebula is trying again.`;
const CLASH = 'Codex changed “Opening” while you were editing it.';

describe('review 22 LOW-3: the mark while timed retries go', () => {
  it('a rename shows in the mark at once; a line that isn’t the retries’ stays as it was written', () => {
    const props = { id: 'n1', selected: false, type: 'cinemaSceneNode', dragging: false, zIndex: 0, isConnectable: true,
      positionAbsoluteX: 0, positionAbsoluteY: 0, selectable: true, deletable: true, draggable: true,
      data: { label: 'Opening', definitionId: 'cinema-scene', state: 'idle', outputs: {},
        params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [] } } } } as unknown as NodeProps;
    useGraphStore.setState({ nodes: [scene('n1', 'Opening')], unsavedScenes: { n1: RETRYING('Opening') },
      stoppedScenes: {}, sceneStops: { n1: { cause: 'retrying' } }, sceneTries: {}, sceneClashes: {},
      retrySceneSave: vi.fn() } as never);
    const { container } = render(<ReactFlowProvider><CinemaSceneNode {...props} /></ReactFlowProvider>);
    const mark = () => container.querySelector('.cinema-scene-node__unsaved') as HTMLElement;
    expect(mark().getAttribute('title')).toBe(RETRYING('Opening'));
    set({ nodes: [scene('n1', 'Opening IV')] });
    expect(mark().getAttribute('title')).toBe(RETRYING('Opening IV'));
    // Another line took the mark (a clash's, which takes the retrying line's place): it is said as written.
    set({ unsavedScenes: { n1: CLASH }, sceneStops: {} });
    expect(mark().getAttribute('title')).toBe(CLASH);
  });
});
