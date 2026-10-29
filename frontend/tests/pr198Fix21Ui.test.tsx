import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PR #198 fix round 21 (GM r30), rendered: every notice button held while
 * its action is on its way (a [Try again], a clash answer being sent) is
 * aria-disabled at once, label unchanged, no reason tooltip; it greys with
 * the shared disabled style only after ~150 ms (data-held-look), so a fast
 * try never flickers. The line (or the prompt) is aria-busy meanwhile.
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
import { SceneUnsavedMark } from '../src/components/nodes/SceneUnsavedMark';
import { useGraphStore } from '../src/store/graphStore';

const LAZY = { timeout: 10_000 };
const initial = useGraphStore.getState();
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  useGraphStore.setState(initial, true);
});

const scene = (id: string, label: string, x: number) => ({ id, type: 'cinemaSceneNode', position: { x, y: 0 },
  data: { label, definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } });
const SERVER_ONE = 'Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change.';
const CLASH = 'Codex changed “Opening” while you were editing it.';
const set = (state: Record<string, unknown>) => act(() => { useGraphStore.setState(state as never); });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const stopLine = () => document.querySelector('[data-scene-stop]') as HTMLElement;
const stopButton = () => stopLine().querySelector('button') as HTMLButtonElement;

/** A stopped "Opening" with its line on screen, real timers until it shows, fake after. */
async function stoppedLine(retry = vi.fn()) {
  useGraphStore.setState({ nodes: [scene('n1', 'Opening', 0)], stoppedScenes: { n1: true }, sceneStops: { n1: { cause: 'server' } },
    sceneTries: {}, scenePopover: null, undoNotice: null, messageNotice: null, sceneClashes: {}, retrySceneSave: retry } as never);
  render(<NoticeRegion screen="canvas" />);
  await screen.findByText(SERVER_ONE, {}, LAZY);
  vi.useFakeTimers();
  return retry;
}
const startTry = () => set({ stoppedScenes: {}, sceneTries: { n1: { cause: 'server' } } });
const backStopped = () => set({ stoppedScenes: { n1: true }, sceneTries: {} });

describe('GM r30: a held [Try again] in the state slot', () => {
  it('aria-disabled and the line aria-busy at once; no grey before 150 ms, grey after; no reason tooltip; the label as it is', async () => {
    await stoppedLine();
    startTry();
    expect(stopButton().getAttribute('aria-disabled')).toBe('true');
    expect(stopLine().getAttribute('aria-busy')).toBe('true');
    expect(stopButton().hasAttribute('data-held-look')).toBe(false);
    expect(stopButton().hasAttribute('title')).toBe(false);
    advance(149);
    expect(stopButton().hasAttribute('data-held-look')).toBe(false);
    advance(1);
    expect(stopButton().hasAttribute('data-held-look')).toBe(true);
    expect(stopButton().textContent).toBe('Try again');
    expect(stopButton().hasAttribute('title')).toBe(false);
  });

  it('the try answered: aria-busy, aria-disabled and the grey all go at once', async () => {
    await stoppedLine();
    startTry();
    advance(400);
    expect(stopButton().hasAttribute('data-held-look')).toBe(true);
    backStopped();
    expect(stopLine().hasAttribute('aria-busy')).toBe(false);
    expect(stopButton().hasAttribute('aria-disabled')).toBe(false);
    expect(stopButton().hasAttribute('data-held-look')).toBe(false);
  });

  it('a try answered in under 150 ms never greys; the next, slower try greys at 150 ms (nothing carried over)', async () => {
    await stoppedLine();
    startTry();
    const seen: boolean[] = [];
    for (let t = 0; t < 100; t += 10) { advance(10); seen.push(stopButton().hasAttribute('data-held-look')); }
    expect(stopButton().getAttribute('aria-disabled')).toBe('true');
    expect(stopLine().getAttribute('aria-busy')).toBe('true');
    backStopped();
    for (let t = 0; t < 400; t += 10) { advance(10); seen.push(stopButton().hasAttribute('data-held-look')); }
    expect(seen.every((grey) => !grey)).toBe(true);
    expect(stopButton().hasAttribute('aria-disabled')).toBe(false);
    startTry();
    advance(149);
    expect(stopButton().hasAttribute('data-held-look')).toBe(false);
    advance(1);
    expect(stopButton().hasAttribute('data-held-look')).toBe(true);
  });
});

describe('GM r30: the "Unsaved" popover’s [Try again]', () => {
  it('held with the same delayed grey; the popover aria-busy while the try runs', () => {
    useGraphStore.setState({ nodes: [scene('n1', 'Opening', 0)], stoppedScenes: { n1: true }, sceneStops: { n1: { cause: 'server' } },
      sceneTries: {}, retrySceneSave: vi.fn() } as never);
    render(<SceneUnsavedMark nodeId="n1" line={SERVER_ONE} stopped />);
    fireEvent.click(screen.getByRole('button', { name: 'Unsaved' }));
    vi.useFakeTimers();
    const popover = () => document.querySelector('[data-scene-unsaved-popover="n1"]') as HTMLElement;
    const button = () => popover().querySelector('button') as HTMLButtonElement;
    set({ stoppedScenes: {}, sceneTries: { n1: { cause: 'server' } } });
    expect(button().getAttribute('aria-disabled')).toBe('true');
    expect(popover().getAttribute('aria-busy')).toBe('true');
    advance(149);
    expect(button().hasAttribute('data-held-look')).toBe(false);
    advance(1);
    expect(button().hasAttribute('data-held-look')).toBe(true);
    expect(button().hasAttribute('title')).toBe(false);
    set({ stoppedScenes: { n1: true }, sceneTries: {} });
    expect(popover().hasAttribute('aria-busy')).toBe(false);
    expect(button().hasAttribute('data-held-look')).toBe(false);
  });
});

describe('GM r30: a clash answer being sent', () => {
  it('the prompt stays aria-busy; Keep mine and Use Codex’s held at once, grey after 150 ms, labels as they are; presses send nothing', async () => {
    const resolve = vi.fn();
    useGraphStore.setState({ nodes: [scene('n1', 'Opening', 0)], stoppedScenes: {}, sceneStops: {}, sceneTries: {}, undoNotice: null,
      messageNotice: null, sceneClashes: { n1: { id: 61, line: CLASH, agent: 'Codex' } }, resolveSceneClash: resolve } as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(CLASH, {}, LAZY);
    vi.useFakeTimers();
    const prompt = () => document.querySelector('[data-scene-clash="n1"]') as HTMLElement;
    const buttons = () => [...prompt().querySelectorAll('button')] as HTMLButtonElement[];
    expect(prompt().hasAttribute('aria-busy')).toBe(false);
    set({ sceneClashes: { n1: { id: 61, line: CLASH, agent: 'Codex', sending: 'mine' } } });
    expect(prompt().getAttribute('aria-busy')).toBe('true');
    expect(buttons().map((b) => [b.textContent, b.getAttribute('aria-disabled'), b.hasAttribute('data-held-look'), b.hasAttribute('title')]))
      .toEqual([['Keep mine', 'true', false, false], ['Use Codex’s', 'true', false, false]]);
    advance(149);
    expect(buttons().some((b) => b.hasAttribute('data-held-look'))).toBe(false);
    advance(1);
    expect(buttons().every((b) => b.hasAttribute('data-held-look'))).toBe(true);
    for (const b of buttons()) fireEvent.click(b);
    expect(resolve).not.toHaveBeenCalled();
    // Asked again (a new clash during the save): a prompt that isn't sending, its buttons live.
    set({ sceneClashes: { n1: { id: 62, line: CLASH, agent: 'Codex' } } });
    expect(prompt().hasAttribute('aria-busy')).toBe(false);
    expect(buttons().every((b) => !b.hasAttribute('aria-disabled') && !b.hasAttribute('data-held-look'))).toBe(true);
    fireEvent.click(buttons()[0]);
    expect(resolve).toHaveBeenCalledWith('n1', 'mine');
  });
});

describe('GM r30: the shared disabled style, keyed on aria-disabled', () => {
  const css = readFileSync(join(__dirname, '../src/styles/canvasProposals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) => {
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (match[1].split(',').map((part) => part.trim()).includes(selector)) return match[2];
    }
    return '';
  };

  it('a held notice button greys with the app’s disabled token once data-held-look comes; no new grey', () => {
    const held = rule("body.app-slava-restraint .canvas-undo-notice button[aria-disabled='true'][data-held-look]");
    expect(held).toMatch(/opacity:\s*var\(--sr-disabled-opacity\)/);
    expect(held).not.toMatch(/#[0-9a-f]{3,6}|rgb|color:/i);
    // aria-disabled alone (the first ~150 ms) has no look of its own.
    expect(rule("body.app-slava-restraint .canvas-undo-notice button[aria-disabled='true']")).toBe('');
  });
});

describe('review 19 NIT-1: the card’s "Unsaved" mark during a try', () => {
  it('stays a button (its popover’s [Try again] held) while the try runs, and is a plain label for a save that isn’t stopped', () => {
    const props = { id: 'n1', selected: false, type: 'cinemaSceneNode', dragging: false, zIndex: 0, isConnectable: true,
      positionAbsoluteX: 0, positionAbsoluteY: 0, selectable: true, deletable: true, draggable: true,
      data: { label: 'Opening', definitionId: 'cinema-scene', state: 'idle', outputs: {},
        params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [] } } } } as unknown as NodeProps;
    useGraphStore.setState({ unsavedScenes: { n1: SERVER_ONE }, stoppedScenes: { n1: true }, sceneStops: { n1: { cause: 'server' } },
      sceneTries: {}, retrySceneSave: vi.fn() } as never);
    const { container } = render(<ReactFlowProvider><CinemaSceneNode {...props} /></ReactFlowProvider>);
    const mark = () => container.querySelector('.cinema-scene-node__unsaved') as HTMLElement;
    expect(mark().tagName).toBe('BUTTON');
    set({ stoppedScenes: {}, sceneTries: { n1: { cause: 'server' } } });
    expect(mark().tagName).toBe('BUTTON');
    set({ sceneTries: {} });
    expect(mark().tagName).not.toBe('BUTTON');
  });
});

describe('round 21 (coordinator): focus when an answered clash prompt goes never drops to the page', () => {
  const OTHER_STOP = 'Nebula can’t save your changes to “Ref scene”.';
  const canvas = () => {
    const el = document.createElement('div');
    el.className = 'canvas-wrapper';
    el.tabIndex = 0;
    document.body.appendChild(el);
    return el;
  };
  afterEach(() => { document.querySelectorAll('.canvas-wrapper').forEach((el) => el.remove()); vi.restoreAllMocks(); });
  const asked = (extra: Record<string, unknown> = {}) => ({ nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300)],
    stoppedScenes: {}, sceneStops: {}, sceneTries: {}, scenePopover: null, undoNotice: null, messageNotice: null,
    sceneClashes: { n1: { id: 71, line: CLASH, agent: 'Codex' } },
    resolveSceneClash: (id: string) => { useGraphStore.setState((s) => ({ sceneClashes: { ...s.sceneClashes,
      [id]: { ...(s.sceneClashes as Record<string, object>)[id], sending: 'mine' } } }) as never); }, ...extra });
  /** Render, answer Keep mine (keyboard: a click with detail 0; mouse: detail 1), focus on it. */
  async function answer(state: Record<string, unknown>, how: 'keyboard' | 'mouse') {
    useGraphStore.setState(state as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(CLASH, {}, LAZY);
    const keep = document.querySelector('[data-scene-clash="n1"] button') as HTMLButtonElement;
    keep.focus();
    const focusCalls: { el: Element; options?: FocusOptions }[] = [];
    const real = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      focusCalls.push({ el: this, options });
      real.call(this, options);
    });
    fireEvent.click(keep, { detail: how === 'keyboard' ? 0 : 1 });
    expect(document.activeElement).toBe(keep);
    return focusCalls;
  }
  const lastFocus = (calls: { el: Element; options?: FocusOptions }[]) => calls[calls.length - 1];

  it.each<['another stop line' | 'a toast below' | 'nothing else']>([['another stop line'], ['a toast below'], ['nothing else']])(
    'a keyboard answer that lands, %s: focus goes by the × rule (the line itself, the toast’s ×, the canvas), ringed', async (other) => {
      const wrapper = canvas();
      const extra = other === 'another stop line' ? { stoppedScenes: { n2: true }, sceneStops: { n2: { cause: 'bad-save' } } }
        : other === 'a toast below' ? { undoNotice: { id: 9, text: 'Codex changed the canvas.', offer: null } } : {};
      const calls = await answer(asked(extra), 'keyboard');
      set({ sceneClashes: {} });
      expect(document.querySelector('[data-scene-clash]')).toBeNull();
      const active = document.activeElement as HTMLElement;
      if (other === 'another stop line') {
        expect(active.getAttribute('data-scene-stop')).toBe('bad-save');
        expect(active.textContent).toContain(OTHER_STOP);
      } else if (other === 'a toast below') {
        expect(active.getAttribute('aria-label')).toBe('Dismiss');
        expect(active.closest('.canvas-undo-notice')?.textContent).toContain('Codex changed the canvas.');
      } else expect(active).toBe(wrapper);
      expect(lastFocus(calls)).toEqual({ el: active, options: { focusVisible: true } });
    });

  it('a keyboard answer that fails: focus goes to the [Try again] of the stop line that took the prompt’s place, ringed', async () => {
    canvas();
    const calls = await answer(asked({ stoppedScenes: { n2: true }, sceneStops: { n2: { cause: 'bad-save' } } }), 'keyboard');
    set({ sceneClashes: {}, stoppedScenes: { n1: true, n2: true }, sceneStops: { n1: { cause: 'server' }, n2: { cause: 'bad-save' } } });
    const active = document.activeElement as HTMLElement;
    expect(active.tagName).toBe('BUTTON');
    expect(active.textContent).toBe('Try again');
    expect(active.closest('[data-scene-stop]')?.getAttribute('data-scene-stop')).toBe('server');
    expect(active.closest('[data-scene-stop]')?.textContent).toContain(SERVER_ONE);
    expect(lastFocus(calls)).toEqual({ el: active, options: { focusVisible: true } });
  });

  it('a mouse answer that lands, nothing else: focus goes to the canvas with no ring', async () => {
    const wrapper = canvas();
    const calls = await answer(asked(), 'mouse');
    set({ sceneClashes: {} });
    expect(document.activeElement).toBe(wrapper);
    expect(lastFocus(calls)).toEqual({ el: wrapper, options: { focusVisible: false } });
  });
});
