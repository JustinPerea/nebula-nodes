import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * PR #198 fix round 22, review 20 NIT-1, rendered: where focus goes when an
 * answered clash prompt leaves the region, for the branches round 21's tests
 * left untested:
 * - asked again: the new prompt itself, ahead of the × rule (a toast below);
 * - focus the person moved meanwhile stays where they put it;
 * - the × rule's same-slot search: another scene's prompt in the same slot.
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
  document.querySelectorAll('.canvas-wrapper, [data-test-elsewhere]').forEach((el) => el.remove());
  vi.restoreAllMocks();
  useGraphStore.setState(initial, true);
});

const scene = (id: string, label: string, x: number) => ({ id, type: 'cinemaSceneNode', position: { x, y: 0 },
  data: { label, definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } });
const CLASH = 'Codex changed “Opening” while you were editing it.';
const CLASH_REF = 'Codex changed “Ref scene” while you were editing it.';
const set = (state: Record<string, unknown>) => act(() => { useGraphStore.setState(state as never); });
const canvas = () => {
  const el = document.createElement('div');
  el.className = 'canvas-wrapper';
  el.tabIndex = 0;
  document.body.appendChild(el);
  return el;
};
const asked = (extra: Record<string, unknown> = {}) => ({ nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300)],
  stoppedScenes: {}, sceneStops: {}, sceneTries: {}, scenePopover: null, undoNotice: null, messageNotice: null,
  sceneClashes: { n1: { id: 71, line: CLASH, agent: 'Codex' } },
  resolveSceneClash: (id: string) => { useGraphStore.setState((s) => ({ sceneClashes: { ...s.sceneClashes,
    [id]: { ...(s.sceneClashes as Record<string, object>)[id], sending: 'mine' } } }) as never); }, ...extra });
/** Render, answer Keep mine on n1 by keyboard (a click with detail 0), focus on it. */
async function answer(state: Record<string, unknown>) {
  useGraphStore.setState(state as never);
  render(<NoticeRegion screen="canvas" />);
  await screen.findByText(CLASH, {}, LAZY);
  const keep = document.querySelector('[data-scene-clash="n1"] button') as HTMLButtonElement;
  keep.focus();
  const calls: { el: Element; options?: FocusOptions }[] = [];
  const real = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    calls.push({ el: this, options });
    real.call(this, options);
  });
  fireEvent.click(keep, { detail: 0 });
  return calls;
}

describe('review 20 NIT-1: focus when an answered clash prompt goes', () => {
  it('asked again, with a toast below: focus goes to the new prompt itself (never its Keep mine), ahead of the toast’s ×, ringed', async () => {
    canvas();
    const calls = await answer(asked({ undoNotice: { id: 9, text: 'Codex changed the canvas.', offer: null } }));
    // Codex changed it again during the answer's save: a new prompt for the same scene.
    set({ sceneClashes: { n1: { id: 72, line: CLASH, agent: 'Codex' } } });
    // Review 21 NIT-6: the new prompt mounts, then takes focus.
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-scene-clash')).toBe('n1'), { timeout: 5000, interval: 5 });
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute('data-scene-clash')).toBe('n1');
    expect(active.tagName).toBe('DIV');
    expect(calls[calls.length - 1]).toEqual({ el: active, options: { focusVisible: true } });
  });

  it('focus the person moved while the answer was out stays where they put it', async () => {
    canvas();
    const elsewhere = document.createElement('button');
    elsewhere.setAttribute('data-test-elsewhere', '');
    document.body.appendChild(elsewhere);
    await answer(asked());
    elsewhere.focus();
    set({ sceneClashes: {} });
    expect(document.activeElement).toBe(elsewhere);
  });

  it('the × rule searches the same slot: another scene’s prompt there takes focus before the canvas', async () => {
    canvas();
    const calls = await answer(asked({ sceneClashes: { n1: { id: 71, line: CLASH, agent: 'Codex' },
      n2: { id: 81, line: CLASH_REF, agent: 'Codex' } } }));
    set({ sceneClashes: { n2: { id: 81, line: CLASH_REF, agent: 'Codex' } } });
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute('data-scene-clash')).toBe('n2');
    expect(calls[calls.length - 1]).toEqual({ el: active, options: { focusVisible: true } });
  });
});
