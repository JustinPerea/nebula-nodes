import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * PR #198 fix round 19 (GM r28 item 2), rendered: the scenes' stop lines
 * are a state in their own slot of the region's stack, above the event
 * slots (the message line and the canvas notice), one line per cause, with
 * [Try again] for every scene the line names and no ×.
 */
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async () => new Response('{}', { status: 200 }),
}));

import { NoticeRegion } from '../src/components/NoticeRegion';
import { useGraphStore } from '../src/store/graphStore';

const LAZY = { timeout: 10_000 };
const initial = useGraphStore.getState();
afterEach(() => {
  cleanup();
  useGraphStore.setState(initial, true);
});

const scene = (id: string, label: string, x: number) => ({ id, type: 'cinemaSceneNode', position: { x, y: 0 },
  data: { label, definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } });
const MERGED = 'Nebula couldn’t save your changes to “Opening” and “Ref scene”. They’re kept, and Nebula will try again with your next change.';
const CANT = 'Nebula can’t save your changes to “Finale”.';

describe('GM r28 item 2: the state slot', () => {
  it('a merged line and a line of another cause sit above the event slot; [Try again] retries every scene the line names', async () => {
    const retry = vi.fn();
    useGraphStore.setState({
      nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300), scene('n3', 'Finale', 600)],
      stoppedScenes: { n1: true, n2: true, n3: true },
      sceneStops: { n1: { cause: 'server' }, n2: { cause: 'server' }, n3: { cause: 'bad-save' } },
      scenePopover: null,
      undoNotice: { id: 7, text: 'Codex changed the canvas.', offer: 'undo' },
      messageNotice: { id: 8, text: 'Some other line.', tone: 'info' },
      retrySceneSave: retry,
    } as never);
    render(<NoticeRegion screen="canvas" />);
    const merged = await screen.findByText(MERGED, {}, LAZY);
    const cant = await screen.findByText(CANT, {}, LAZY);
    const event = await screen.findByText('Codex changed the canvas.', {}, LAZY);
    const message = await screen.findByText('Some other line.', {}, LAZY);
    const item = (element: HTMLElement) => element.closest<HTMLElement>('[data-notice-slot] > *')!;
    expect(item(merged).parentElement).toHaveAttribute('data-notice-slot', 'scene-stop');
    expect(item(cant).parentElement).toHaveAttribute('data-notice-slot', 'scene-stop');
    // One line per cause, in GM's order; both above both event slots.
    expect(item(merged).compareDocumentPosition(item(cant)) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    for (const below of [event, message]) {
      expect(item(below).compareDocumentPosition(item(merged)) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    }
    // [Try again], no ×: the line goes when the stop does.
    const line = item(merged);
    expect(Array.from(line.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['Try again']);
    fireEvent.click(line.querySelector('button')!);
    expect(retry.mock.calls.map(([id]) => id)).toEqual(['n1', 'n2']);
  });

  it('a scene whose clash waits, or whose popover is open, isn’t in the line; the rest stay', async () => {
    useGraphStore.setState({
      nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300), scene('n3', 'Finale', 600)],
      // n3's clash waits: it is no stopped scene on screen (markSceneStopped).
      stoppedScenes: { n1: true, n2: true },
      sceneStops: { n1: { cause: 'server' }, n2: { cause: 'server' }, n3: { cause: 'server' } },
      scenePopover: 'n2',
    } as never);
    render(<NoticeRegion screen="canvas" />);
    expect(await screen.findByText('Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change.', {}, LAZY))
      .toBeTruthy();
    expect(document.querySelectorAll('[data-scene-stop]')).toHaveLength(1);
  });
});
