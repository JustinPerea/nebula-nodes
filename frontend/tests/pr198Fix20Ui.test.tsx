import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * PR #198 fix round 20, rendered.
 * - GM r29 call 2: while a scene's [Try again] is on its way, its stop line
 *   stays and the button is disabled (aria-disabled, so focus stays on it)
 *   with its label unchanged, in the state slot and in the "Unsaved" mark's
 *   popover, so a double press can't queue two tries.
 * - Review 18 LOW-1 (GM r29): focus on a stop line never drops to the page.
 *   A line that comes back after its try gives focus to its [Try again]; a
 *   focused line that goes hands focus on by the × rule: another stop line
 *   (the notice, never its [Try again]), else the next notice's ×, else a
 *   notice that takes focus itself (the clash prompt), else the canvas.
 */
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async () => new Response('{}', { status: 200 }),
}));

import { NoticeRegion } from '../src/components/NoticeRegion';
import { SceneUnsavedMark } from '../src/components/nodes/SceneUnsavedMark';
import { useGraphStore } from '../src/store/graphStore';

const LAZY = { timeout: 10_000 };
const initial = useGraphStore.getState();
afterEach(() => {
  cleanup();
  useGraphStore.setState(initial, true);
});

const scene = (id: string, label: string, x: number) => ({ id, type: 'cinemaSceneNode', position: { x, y: 0 },
  data: { label, definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } });
const LINE = 'Nebula couldn’t save your changes to “Opening” and “Ref scene”. They’re kept, and Nebula will try again with your next change.';

describe('GM r29 call 2: [Try again] disabled while its try is on its way', () => {
  it('the state slot: the line stays, [Try again] disabled with its label; pressing it retries nothing', async () => {
    const retry = vi.fn();
    // Opening's try is on its way (out of the stopped state); Ref is still stopped.
    useGraphStore.setState({
      nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300)],
      stoppedScenes: { n2: true }, sceneStops: { n2: { cause: 'server' } }, sceneTries: { n1: { cause: 'server' } },
      scenePopover: null, undoNotice: null, messageNotice: null, retrySceneSave: retry,
    } as never);
    render(<NoticeRegion screen="canvas" />);
    const text = await screen.findByText(LINE, {}, LAZY);
    const button = text.closest('[data-scene-stop]')!.querySelector('button')!;
    expect(button.textContent).toBe('Try again');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(retry).not.toHaveBeenCalled();
    // Answered: the try leaves, the button is back.
    useGraphStore.setState({ sceneTries: {}, stoppedScenes: { n1: true, n2: true }, sceneStops: { n1: { cause: 'server' }, n2: { cause: 'server' } } } as never);
    const again = (await screen.findByText(LINE, {}, LAZY)).closest('[data-scene-stop]')!.querySelector('button')!;
    expect(again.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(again);
    expect(retry.mock.calls.map(([id]) => id)).toEqual(['n1', 'n2']);
  });

  it('the mark’s popover: [Try again] disabled with its label while the try is on its way', () => {
    const retry = vi.fn();
    useGraphStore.setState({ nodes: [scene('n1', 'Opening', 0)], stoppedScenes: {}, sceneStops: {},
      sceneTries: { n1: { cause: 'server' } }, retrySceneSave: retry } as never);
    render(<SceneUnsavedMark nodeId="n1" line="Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change." stopped />);
    fireEvent.click(screen.getByRole('button', { name: 'Unsaved' }));
    const button = document.querySelector('[data-scene-unsaved-popover="n1"] button') as HTMLButtonElement;
    expect(button.textContent).toBe('Try again');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(retry).not.toHaveBeenCalled();
  });
});

const SERVER_ONE = 'Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change.';
const CANT_ONE = 'Nebula can’t save your changes to “Opening”.';
const TOO_BIG_ONE = '“Opening” is too big to save. Remove something from it, then try again.';
const CANT_REF = 'Nebula can’t save your changes to “Ref scene”.';
const lineEl = (text: string) => screen.getByText(text).closest('[data-scene-stop]') as HTMLElement;
const tryOf = (text: string) => lineEl(text).querySelector('button') as HTMLButtonElement;
const set = (state: Record<string, unknown>) => act(() => { useGraphStore.setState(state as never); });

describe('review 18 LOW-1 (GM r29): focus on a stop line never drops to the page', () => {
  const canvas = () => {
    const el = document.createElement('div');
    el.className = 'canvas-wrapper';
    el.tabIndex = 0;
    document.body.appendChild(el);
    return el;
  };
  afterEach(() => { document.querySelectorAll('.canvas-wrapper').forEach((el) => el.remove()); });

  const stoppedOpening = (cause: 'server' | 'bad-save' | 'too-big', extra: Record<string, unknown> = {}) => ({
    nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300)], stoppedScenes: { n1: true }, sceneStops: { n1: { cause } },
    sceneTries: {}, scenePopover: null, undoNotice: null, messageNotice: null, sceneClashes: {}, ...extra });

  it('(a) a [Try again] from the keyboard that fails the same way: focus stays on the same [Try again] the whole time', async () => {
    useGraphStore.setState({ ...stoppedOpening('server'), retrySceneSave: (id: string) => {
      useGraphStore.setState({ stoppedScenes: {}, sceneTries: { [id]: { cause: 'server' } } } as never); } } as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(SERVER_ONE, {}, LAZY);
    const button = tryOf(SERVER_ONE);
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    set({ stoppedScenes: { n1: true }, sceneTries: {} });
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBeNull();
  });

  it('(a) the try comes back under another cause (400, then 413): focus goes to the new line’s [Try again]', async () => {
    useGraphStore.setState({ ...stoppedOpening('bad-save'), retrySceneSave: (id: string) => {
      useGraphStore.setState({ stoppedScenes: {}, sceneTries: { [id]: { cause: 'bad-save' } } } as never); } } as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(CANT_ONE, {}, LAZY);
    tryOf(CANT_ONE).focus();
    fireEvent.click(tryOf(CANT_ONE));
    set({ stoppedScenes: { n1: true }, sceneStops: { n1: { cause: 'too-big' } }, sceneTries: {} });
    expect(document.activeElement).toBe(tryOf(TOO_BIG_ONE));
  });

  it('(b) a focused line that clears by itself, another stop line left: focus on that line itself, never its [Try again]', async () => {
    useGraphStore.setState({ ...stoppedOpening('server'), stoppedScenes: { n1: true, n2: true },
      sceneStops: { n1: { cause: 'server' }, n2: { cause: 'bad-save' } } } as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(SERVER_ONE, {}, LAZY);
    tryOf(SERVER_ONE).focus();
    set({ stoppedScenes: { n2: true }, sceneStops: { n2: { cause: 'bad-save' } } });
    expect(screen.queryByText(SERVER_ONE)).toBeNull();
    expect(document.activeElement).toBe(lineEl(CANT_REF));
  });

  it('(b) no stop line left, a toast below: focus on its ×, never its action', async () => {
    useGraphStore.setState(stoppedOpening('server', { undoNotice: { id: 7, text: 'Codex changed the canvas.', offer: null } }) as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(SERVER_ONE, {}, LAZY);
    tryOf(SERVER_ONE).focus();
    set({ stoppedScenes: {}, sceneStops: {} });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss');
    expect(document.activeElement?.closest('.canvas-undo-notice')?.textContent).toContain('Codex changed the canvas.');
  });

  it('(b) no stop line left, only a clash prompt (no ×): focus on the prompt itself', async () => {
    useGraphStore.setState(stoppedOpening('server', { sceneClashes: { n2: { id: 51, line: 'Codex changed “Ref scene” while you were editing it.', agent: 'Codex' } } }) as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(SERVER_ONE, {}, LAZY);
    tryOf(SERVER_ONE).focus();
    set({ stoppedScenes: {}, sceneStops: {} });
    expect(document.activeElement?.getAttribute('data-scene-clash')).toBe('n2');
  });

  it('(b) nothing else in the region: focus on the canvas', async () => {
    const wrapper = canvas();
    useGraphStore.setState(stoppedOpening('server') as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(SERVER_ONE, {}, LAZY);
    tryOf(SERVER_ONE).focus();
    set({ stoppedScenes: {}, sceneStops: {} });
    expect(document.activeElement).toBe(wrapper);
  });

  it('focus the person moved elsewhere stays there when the line goes', async () => {
    const wrapper = canvas();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    useGraphStore.setState(stoppedOpening('server') as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(SERVER_ONE, {}, LAZY);
    tryOf(SERVER_ONE).focus();
    elsewhere.focus();
    set({ stoppedScenes: {}, sceneStops: {} });
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(wrapper);
    elsewhere.remove();
  });
});
