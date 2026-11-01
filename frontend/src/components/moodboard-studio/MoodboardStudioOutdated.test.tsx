import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Moodboard } from '../../types';

// #208 (review 1, GM r1 and r2): a board analyzed before alpha counted, with
// a transparent image, says so in Studio twice, verbatim as the backend sends
// it: under its colours, and by "Brief sent to generators", since that brief
// is built from those colours while a run analyzes again and sends a new one.

const api = vi.hoisted(() => ({
  analyzeMoodboard: vi.fn(), createMoodboard: vi.fn(), editMoodboard: vi.fn(), fetchMoodboard: vi.fn(),
  fetchMoodboards: vi.fn(), keepMoodboardBriefOverride: vi.fn(), lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(), updateMoodboard: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ ...api, SAVE_BOARD: "Couldn't save the board." }));
vi.mock('../../lib/backend', async (importOriginal) => ({
  ...(await importOriginal<object>()), apiFetch: vi.fn(), backendAssetUrlSync: (url: string) => url,
}));
vi.mock('../../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));
vi.mock('../WorkspaceHeader', () => ({
  WorkspaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../asset-trash/AssetTrash', () => ({ RecentlyDeletedAssets: () => null, UndoDeleteToast: () => null }));
vi.mock('../../hooks/useAssetDelete', () => ({
  useAssetDelete: () => ({ lastDeleted: null, busy: false, error: null, refreshKey: 0, remove: vi.fn(),
    undo: vi.fn(), dismiss: vi.fn(), refresh: vi.fn() }),
}));

import { MoodboardStudioView } from './MoodboardStudioView';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import { useStoredAssetsStore } from '../../store/storedAssetsStore';

const COLORS_LINE = 'These colors counted transparent areas as dark. Analyze again to update them.';
const BRIEF_LINE = 'This brief uses the old colors. The next run analyzes the board again and sends an updated one.';
const OVERRIDE_LINE = 'This brief uses the old colors. The next run sends it with the updated ones.';

function board(outdated: boolean): Moodboard {
  const image = { id: 'img1', url: '/api/outputs/chat-uploads/mark.png', weight: 1, notes: '', privateNote: '',
    excluded: false, placements: [{ id: 'c1', frameId: null, x: 0, y: 0, w: 400, h: 300, weight: 1 }] };
  return {
    id: 'mb1', name: 'Mark', version: 3, notes: '', mode: 'look', strength: 0.7, images: [image],
    analysis: {
      version: 5, summary: '1 reference image analyzed as look. Palette: #040605.', palette: ['#040605'],
      accents: [], colors: [], keywords: [], images: [], warnings: [], styleBrief: 'Color palette: #040605.',
      ...(outdated ? { outdated: COLORS_LINE } : {}),
    },
    brief: {
      styleBrief: 'Color palette: #040605.', generatedStyleBrief: 'Color palette: #040605.', negativePrompt: '',
      avoid: [], avoidPrompt: '', direction: '', pinnedColors: { include: [], exclude: [] }, palette: ['#040605'],
      accents: [], override: { active: false, stale: false }, needsAnalysis: false,
      ...(outdated ? { outdated: BRIEF_LINE } : {}),
    },
    direction: '', avoid: [], pinnedColors: { include: [], exclude: [] }, briefOverride: null, coverImageId: null,
    thumbnail: image.url, projectId: null, createdAt: '', updatedAt: '',
  } as unknown as Moodboard;
}

let current = board(true);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.fetchMoodboard.mockImplementation(async (id: string) => (id === 'mb1' ? current : null));
  api.fetchMoodboards.mockImplementation(async (scope: string) => (scope === 'global' ? [current] : []));
  api.lookupStoredAsset.mockImplementation(async () => ({ status: 'ready', asset: current }));
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  useStoredAssetsStore.setState({ entries: {} });
  useBoardCanvasStore.setState({ view: 'list', selection: {}, viewports: {} });
  setOpenProject(['p1', 'Project']);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function open() {
  act(() => { useUIStore.getState().enterMoodboardEditor('mb1', 'global'); });
  render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
  await screen.findByDisplayValue('Mark');
}

describe('a board whose saved colors are out of date', () => {
  it('says so under the colors and by the brief, in GM’s words', async () => {
    current = board(true);
    await open();
    expect((await screen.findByText(COLORS_LINE)).className).toBe('moodboard-analysis__outdated');
    const line = await screen.findByText(BRIEF_LINE);
    expect(line.className).toBe('moodboard-analysis__outdated');
    expect(line.closest('.moodboard-brief')).not.toBeNull();
  });

  it('says neither on a board whose colors are current', async () => {
    current = board(false);
    await open();
    expect(await screen.findByText('Color palette: #040605.')).toBeTruthy();
    expect(screen.queryByText(COLORS_LINE)).toBeNull();
    expect(screen.queryByText(BRIEF_LINE)).toBeNull();
  });

  it('sits right after the brief text and before its controls (GM r5)', async () => {
    current = board(true);
    await open();
    const line = await screen.findByText(BRIEF_LINE);
    const text = screen.getByText('Color palette: #040605.', { selector: '.moodboard-brief__text' });
    const write = screen.getByRole('button', { name: 'Write your own' });
    expect(text.nextElementSibling).toBe(line);
    expect(line.nextElementSibling).toBe(write);
  });

  it('shows the hand-written line after the person’s brief, before its controls', async () => {
    const withOverride = board(true) as unknown as Record<string, unknown>;
    const brief = withOverride.brief as Record<string, unknown>;
    current = {
      ...withOverride,
      briefOverride: { text: 'Warm dusk light.', by: 'person', basis: 'b', updatedAt: '' },
      brief: { ...brief, styleBrief: 'Warm dusk light.', override: { active: true, stale: false },
        outdated: OVERRIDE_LINE },
    } as unknown as Moodboard;
    await open();
    const line = await screen.findByText(OVERRIDE_LINE);
    expect(line.previousElementSibling?.querySelector('textarea')).not.toBeNull();
    expect(line.nextElementSibling?.textContent).toBe('Use the generated brief');
    expect(screen.queryByText(BRIEF_LINE)).toBeNull();
  });
});

// GM r6 on #208, item 4: "The brief holds its place ... When clearing the
// line would shorten a panel scrolled to the bottom, put a bottom spacer of
// the removed height in its place. The spacer collapses on the person's next
// scroll, or when the panel's content next changes. No jump, and no automatic
// scroll." On b972eb9d clearing the two 27 px lines shortened the content by
// 54 px, the browser clamped scrollTop (654 -> 600), and the brief moved.
// GM r10 (review 4, M1): the spacer shrinks as the person scrolls up or the
// content grows; removing it in one step was the same jump, one scroll later.
describe('Analyze clearing the lines while the panel is scrolled to the bottom', () => {
  const LINE_H = 27;
  const CONTENT_H = 1000;
  const CLIENT_H = 400;

  /** The panel's geometry as a browser lays it out: the content is a fixed
   *  height (plus whatever `grow` adds) plus each "old colors" line and, while
   *  shown, the spacer and the flex `gap` before it; scrollTop is clamped to
   *  the bottom whenever it is read (layout). */
  function layout(panel: HTMLElement, { gap = 0 }: { gap?: number } = {}) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const height = this.classList.contains('moodboard-analysis__outdated') ? LINE_H : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect;
    });
    if (gap) {
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
        const style = real(el, pseudo);
        if (el !== panel) return style;
        return new Proxy(style, {
          get: (target, key) => {
            if (key === 'rowGap') return `${gap}px`;
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
    }
    const spacer = () => panel.querySelector<HTMLElement>('.moodboard-hold-spacer');
    const holding = () => { const el = spacer(); return !!el && 'holding' in el.dataset; };
    const spacerH = () => (holding() ? parseFloat(spacer()!.style.getPropertyValue('--moodboard-hold-h')) || 0 : 0);
    let extra = 0;
    let clientH = CLIENT_H;
    const scrollHeight = () => CONTENT_H + extra
      + LINE_H * panel.querySelectorAll('.moodboard-analysis__outdated').length
      + (holding() ? gap + spacerH() : 0);
    let stored = 0;
    const max = () => Math.max(0, scrollHeight() - clientH);
    Object.defineProperty(panel, 'clientHeight', { configurable: true, get: () => clientH });
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, get: scrollHeight });
    Object.defineProperty(panel, 'scrollTop', {
      configurable: true,
      get: () => { stored = Math.min(Math.max(0, stored), max()); return stored; },
      set: (value: number) => { stored = Math.min(Math.max(0, value), max()); },
    });
    /** The person scrolls to `top`. */
    const scrollTo = (top: number) => { panel.scrollTop = top; fireEvent.scroll(panel); };
    /** The content below the brief gets `by` px taller from the next layout on. */
    const grow = (by: number) => { extra += by; };
    /** The window resizes the panel: the browser clamps scrollTop and fires a scroll if it moved. */
    const resize = (height: number) => {
      const was = stored;
      clientH = height;
      if (panel.scrollTop !== was) fireEvent.scroll(panel);
    };
    return { spacer, spacerH, holding, scrollTo, grow, resize, bottom: () => max() };
  }

  /** Where the brief's text sits on screen: its place in the content (fixed:
   *  the lines are after it) less how far the panel is scrolled. */
  const briefOnScreen = (panel: HTMLElement) => 700 - panel.scrollTop;

  async function analyzeAtTheBottom(opts: { before?: Moodboard; after?: Moodboard; line?: string; gap?: number } = {}) {
    const line = opts.line ?? BRIEF_LINE;
    current = opts.before ?? board(true);
    const after = opts.after ?? board(false);
    api.analyzeMoodboard.mockImplementation(async () => after);
    await open();
    await screen.findByText(line);
    const panel = document.querySelector<HTMLElement>('.moodboard-studio-view__main')!;
    const geo = layout(panel, { gap: opts.gap });
    geo.scrollTo(10_000);
    expect(panel.scrollTop).toBe(CONTENT_H + 2 * LINE_H - CLIENT_H);
    const before = briefOnScreen(panel);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(screen.queryByText(line)).toBeNull());
    expect(screen.queryByText(COLORS_LINE)).toBeNull();
    await screen.findByRole('button', { name: 'Analyze' });
    return { panel, geo, before };
  }

  /** A board with a hand-written brief, analyzed before alpha counted or not. */
  function handWritten(outdated: boolean): Moodboard {
    const base = board(outdated) as unknown as Record<string, unknown>;
    const brief = base.brief as Record<string, unknown>;
    return {
      ...base,
      briefOverride: { text: 'Warm dusk light.', by: 'person', basis: 'b', updatedAt: '' },
      brief: { ...brief, styleBrief: 'Warm dusk light.', override: { active: true, stale: false },
        ...(outdated ? { outdated: OVERRIDE_LINE } : {}) },
    } as unknown as Moodboard;
  }

  it('moves the brief 0 px: a spacer of the removed height takes the lines\' place, with no scroll', async () => {
    const { panel, geo, before } = await analyzeAtTheBottom();
    expect(briefOnScreen(panel) - before).toBe(0);
    expect(panel.scrollTop).toBe(654);
    expect(geo.spacerH()).toBe(2 * LINE_H);
    expect(geo.spacer()!.getAttribute('aria-hidden')).toBe('true');
    // A scroll event that doesn't leave the held place (the browser's own) keeps it.
    fireEvent.scroll(panel);
    await act(async () => { await Promise.resolve(); });
    expect(geo.spacerH()).toBe(2 * LINE_H);
    expect(briefOnScreen(panel) - before).toBe(0);
  });

  it('a 5 px scroll up moves the brief 5 px, not the spacer\'s height (review 4, M1)', async () => {
    const { panel, geo, before } = await analyzeAtTheBottom();
    expect(geo.spacerH()).toBe(2 * LINE_H);
    geo.scrollTo(panel.scrollTop - 5);
    expect(briefOnScreen(panel) - before).toBe(5);
    expect(geo.spacerH()).toBe(2 * LINE_H - 5);
  });

  it('collapses on the person\'s next scroll, moving the brief only by that scroll', async () => {
    const { panel, geo, before } = await analyzeAtTheBottom();
    expect(geo.spacerH()).toBe(2 * LINE_H);
    // Up in steps: the spacer shrinks by each step, and the brief moves by it.
    geo.scrollTo(630);
    expect(briefOnScreen(panel) - before).toBe(24);
    expect(geo.spacerH()).toBe(30);
    geo.scrollTo(600);
    expect(briefOnScreen(panel) - before).toBe(54);
    expect(geo.holding()).toBe(false);
    // Then far away: gone, with nothing left past the content's end.
    geo.scrollTo(500);
    expect(panel.scrollTop).toBe(500);
    expect(briefOnScreen(panel) - before).toBe(154);
    expect(geo.spacerH()).toBe(0);
    expect('holding' in geo.spacer()!.dataset).toBe(false);
    expect(geo.bottom()).toBe(CONTENT_H - CLIENT_H);
  });

  it('collapses in one scroll that passes it, moving the brief exactly by the scroll', async () => {
    const { panel, geo, before } = await analyzeAtTheBottom();
    geo.scrollTo(500);
    expect(panel.scrollTop).toBe(500);
    expect(briefOnScreen(panel) - before).toBe(154);
    expect(geo.holding()).toBe(false);
  });

  it('with the panel\'s 16 px gap, the last 16 px of the scroll up move only by the scroll too', async () => {
    const { panel, geo, before } = await analyzeAtTheBottom({ gap: 16 });
    // The shown spacer brings the gap, so it holds 54 - 16 px.
    expect(geo.spacerH()).toBe(2 * LINE_H - 16);
    expect(briefOnScreen(panel) - before).toBe(0);
    geo.scrollTo(panel.scrollTop - 40); // 614: 14 px short, inside the gap
    expect(briefOnScreen(panel) - before).toBe(40);
    expect(geo.holding()).toBe(true);
    expect(geo.spacerH()).toBe(0);
    geo.scrollTo(panel.scrollTop - 10); // 604: still 4 px short
    expect(briefOnScreen(panel) - before).toBe(50);
    geo.scrollTo(panel.scrollTop - 10); // 594: nothing needed, so it goes
    expect(briefOnScreen(panel) - before).toBe(60);
    expect(geo.holding()).toBe(false);
  });

  it('typing in the brief moves nothing', async () => {
    const { panel, geo, before } = await analyzeAtTheBottom({
      before: handWritten(true), after: handWritten(false), line: OVERRIDE_LINE,
    });
    expect(geo.spacerH()).toBe(2 * LINE_H);
    const field = screen.getByRole('textbox', { name: 'Your brief' });
    field.focus();
    fireEvent.change(field, { target: { value: 'Warm dusk light!' } });
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(field, { target: { value: 'Warm dusk light!!' } });
    fireEvent.blur(field);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(briefOnScreen(panel) - before).toBe(0);
    expect(geo.spacerH()).toBe(2 * LINE_H);
  });

  it('a window resize moves only as much as the browser\'s own clamp', async () => {
    const { panel, geo, before } = await analyzeAtTheBottom();
    // 200 px taller: the browser clamps scrollTop by 200 (654 -> 454) and no more.
    geo.resize(CLIENT_H + 200);
    await act(async () => { await Promise.resolve(); });
    expect(panel.scrollTop).toBe(454);
    expect(briefOnScreen(panel) - before).toBe(200);
    expect(geo.spacerH()).toBe(2 * LINE_H);
  });

  it('shrinks by what the panel\'s content grows, with nothing on screen moving', async () => {
    const { panel, geo, before } = await analyzeAtTheBottom();
    expect(geo.spacerH()).toBe(2 * LINE_H);
    // Mode resets the analysis, which changes what the panel shows; here it adds 20 px below the brief.
    geo.grow(20);
    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'world' } });
    await waitFor(() => expect(geo.spacerH()).toBe(2 * LINE_H - 20));
    expect(briefOnScreen(panel) - before).toBe(0);
  });

  it('collapses when the panel\'s content next grows past it', async () => {
    const { panel, geo, before } = await analyzeAtTheBottom();
    expect(geo.spacerH()).toBe(2 * LINE_H);
    geo.grow(60);
    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'world' } });
    await waitFor(() => expect(geo.holding()).toBe(false));
    expect(briefOnScreen(panel) - before).toBe(0);
  });

  it('adds no spacer when the panel isn\'t scrolled far enough to be shortened', async () => {
    current = board(true);
    api.analyzeMoodboard.mockImplementation(async () => board(false));
    await open();
    await screen.findByText(BRIEF_LINE);
    const panel = document.querySelector<HTMLElement>('.moodboard-studio-view__main')!;
    const geo = layout(panel);
    geo.scrollTo(100);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(screen.queryByText(BRIEF_LINE)).toBeNull());
    expect(panel.scrollTop).toBe(100);
    expect(geo.spacerH()).toBe(0);
    expect('holding' in geo.spacer()!.dataset).toBe(false);
  });
});
