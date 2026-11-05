import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MoodboardImage } from '../../types';
import type { BoardReading, BoardReadingRun, BoardReadingState } from '../../lib/boardReading';

// The Reading pane (GM's board reading design, 2026-10-31): before the first
// read, running, the report with its chips, staleness, the locks and the
// failures, and the read proposal's place. The store's actions are stand-ins.

const strip = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('../../lib/backend', () => ({ apiFetch: vi.fn(), backendAssetUrlSync: (url: string) => url }));
vi.mock('../proposals/AssetProposalStrip', () => ({
  AssetProposalStrip: (props: Record<string, unknown>) => { strip.props.push(props); return <div data-testid="read-proposals" />; },
}));

import BoardReadingPane from './BoardReadingPane';
import { useBoardReadingStore } from '../../store/boardReadingStore';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';

const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, ...extra });

const reading = (extra: Partial<BoardReading> = {}): BoardReading => ({
  id: 'rd_1', model: 'gemini-4-argon', modelName: 'Gemini 4 Argon', route: 'antigravity', at: '2026-11-01T15:40:00',
  by: { kind: 'person' },
  markdown: '### Light\n\nLow sun in `tile-a.png`, echoed by images/tile-c.png. <script>alert(1)</script> [more](https://x.example)',
  imageSet: { fingerprint: 'f', images: ['a', 'b', 'c'].map((id) => ({ id, hash: `h${id}`, url: `/api/outputs/${id}.png` })) },
  citations: ['a', 'b', 'c'].map((id, index) => ({ imageId: id, number: index + 1, file: `tile-${id}.png` })),
  cited: ['a', 'c'], ...extra,
});

const run = (extra: Partial<BoardReadingRun> = {}): BoardReadingRun => ({
  id: 'run1', boardId: 'mb1', status: 'running', route: 'antigravity', count: 3, by: { kind: 'person' },
  startedAt: Date.now(), elapsedMs: 42_000, cause: null, readingId: null, ...extra });

const state = (extra: Partial<BoardReadingState> = {}): BoardReadingState => ({
  reading: null, markdown: null, tiles: [], stale: null, hasPrevious: false, run: null,
  route: { antigravity: { installed: true, signedIn: true }, hasKey: true, route: 'antigravity', count: 3,
    model: { id: 'gemini-4-argon', name: 'Gemini 4 Argon' }, estimate: { low: 0.01, high: 0.05, unpriced: false, unconfirmed: false } },
  ...extra,
});

const actions = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
function setBoard(next: BoardReadingState, runAt = Date.now()) {
  useBoardReadingStore.setState({ boards: { mb1: { state: next, loadError: null, actionError: null, busy: null, runAt } },
    start: actions.start, stop: actions.stop });
}

const images = [image('a'), image('b'), image('c')];
const onShowImage = vi.fn();
const pane = (props: Partial<Parameters<typeof BoardReadingPane>[0]> = {}) => (
  <BoardReadingPane boardId="mb1" boardKey="k1" images={images} selectedImageIds={[]} onShowImage={onShowImage} {...props} />
);

beforeEach(() => {
  strip.props = [];
  actions.start.mockClear();
  actions.stop.mockClear();
  onShowImage.mockClear();
  useBoardCanvasStore.setState({ citeHover: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('before the first read', () => {
  it('shows the heading, the intro, the button and the route line', () => {
    setBoard(state());
    render(pane());
    expect(screen.getByRole('heading', { name: 'Reading' })).toBeTruthy();
    expect(screen.getByText('Gemini looks at every image on this board and writes what the style is, what makes it distinctive and why it works.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read the board' }));
    expect(actions.start).toHaveBeenCalledWith('mb1');
    expect(screen.getByText('Sends 3 images to Google through your Antigravity sign-in. Free with your plan.')).toBeTruthy();
  });

  it('locks the button with the lock line when no route can run', () => {
    setBoard(state({ route: { ...state().route, route: null, hasKey: false, antigravity: { installed: false, signedIn: false } } }));
    render(pane());
    expect((screen.getByRole('button', { name: 'Read the board' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('You can read the board after you install Antigravity and sign in, or add a Gemini API key in Settings.')).toBeTruthy();
  });

  it('locks a board not saved yet with the no-images line', () => {
    render(pane({ boardId: null }));
    expect((screen.getByRole('button', { name: 'Read the board' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('You can read the board after you add images.')).toBeTruthy();
  });

  it('places only the board’s read proposals here', () => {
    setBoard(state());
    render(pane());
    expect(strip.props.at(-1)).toMatchObject({ kind: 'moodboard', targetId: 'mb1', reads: true });
  });
});

describe('running', () => {
  it('turns the button into Stop and counts the time in mono', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-01T15:40:00'));
    setBoard(state({ run: run() }));
    render(pane());
    expect(screen.queryByRole('button', { name: 'Read the board' })).toBeNull();
    expect(screen.queryByText(/Sends 3 images/)).toBeNull();
    const line = screen.getByRole('status');
    expect(line.textContent).toBe('Reading 3 images · 0:42');
    expect(line.querySelector('.board-reading__time')?.textContent).toBe('0:42');
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('status').textContent).toBe('Reading 3 images · 0:45');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(actions.stop).toHaveBeenCalledWith('mb1');
  });

  it('keeps an earlier reading as it was while the next one runs', () => {
    setBoard(state({ reading: reading(), run: run() }));
    render(pane());
    expect(screen.getByRole('heading', { name: 'Light' })).toBeTruthy();
  });
});

describe('the report', () => {
  it('shows the meta line, the actions and Gemini’s markdown, labelled as Gemini’s', () => {
    setBoard(state({ reading: reading(), run: run({ status: 'done', readingId: 'rd_1' }) }));
    render(pane());
    expect(screen.getByText('Gemini 4 Argon’s reading · Nov 1, 3:40 PM · 3 images')).toBeTruthy();
    expect(screen.getByText('Gemini')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    const heading = screen.getByRole('heading', { name: 'Light' });
    expect(heading.tagName).toBe('H3');
  });

  it('never makes HTML, a link or an image from the markdown', () => {
    setBoard(state({ reading: reading() }));
    const { container } = render(pane());
    const body = container.querySelector('.board-reading__body')!;
    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('a')).toBeNull();
    expect(body.textContent).toContain('<script>alert(1)</script>');
    expect(body.textContent).toContain('more');
    expect(body.textContent).not.toContain('x.example');
    // The only images are the chips' own thumbs, from Nebula's files.
    for (const img of body.querySelectorAll('img')) expect(img.getAttribute('src')).toMatch(/^\/api\/outputs\//);
  });

  it('draws each citation as a #N chip; hover rings its tile, click shows it', () => {
    setBoard(state({ reading: reading() }));
    render(pane());
    const chip = screen.getByRole('button', { name: '#1' });
    expect(chip.querySelector('img')).toBeTruthy();
    fireEvent.pointerEnter(chip);
    expect(useBoardCanvasStore.getState().citeHover).toEqual({ boardKey: 'k1', imageId: 'a' });
    fireEvent.pointerLeave(chip);
    expect(useBoardCanvasStore.getState().citeHover).toBeNull();
    fireEvent.focus(screen.getByRole('button', { name: '#3' }));
    expect(useBoardCanvasStore.getState().citeHover).toEqual({ boardKey: 'k1', imageId: 'c' });
    fireEvent.click(chip);
    expect(onShowImage).toHaveBeenCalledWith('a');
  });

  it('numbers chips as the board is now', () => {
    setBoard(state({ reading: reading() }));
    render(pane({ images: [image('c'), image('a'), image('b')] }));
    expect(screen.getByRole('button', { name: '#2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '#1' })).toBeTruthy();
  });

  it('gives a selected tile’s chips the selected style', () => {
    setBoard(state({ reading: reading() }));
    render(pane({ selectedImageIds: ['c'] }));
    expect(screen.getByRole('button', { name: '#3' }).className).toContain('board-reading__chip--selected');
    expect(screen.getByRole('button', { name: '#1' }).className).not.toContain('--selected');
  });

  it('copies the markdown with #N', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setBoard(state({ reading: reading() }));
    render(pane());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Low sun in #1, echoed by #3.'));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('clears a hover ring when the pane goes', () => {
    setBoard(state({ reading: reading() }));
    const { unmount } = render(pane());
    fireEvent.pointerEnter(screen.getByRole('button', { name: '#1' }));
    unmount();
    expect(useBoardCanvasStore.getState().citeHover).toBeNull();
  });
});

describe('staleness', () => {
  it('says what changed, with Read again, and dims a removed image’s chip', () => {
    setBoard(state({ reading: reading() }));
    render(pane({ images: [image('a'), image('b'), image('d'), image('e')] }));
    expect(screen.getByText('The board changed after this reading. 2 images were added and 1 was removed.')).toBeTruthy();
    const stale = screen.getByText(/The board changed/).closest('p')!;
    fireEvent.click(within(stale).getByRole('button', { name: 'Read again' }));
    expect(actions.start).toHaveBeenCalledWith('mb1');
    const removed = screen.getByRole('img', { name: '#3, removed from the board' });
    expect(removed.tagName).toBe('SPAN');
    expect(removed.className).toContain('board-reading__chip--removed');
    fireEvent.click(removed);
    expect(onShowImage).not.toHaveBeenCalled();
  });

  it('counts a file replaced on disk from the server', () => {
    setBoard(state({ reading: reading(), stale: { stale: true, added: [], removed: [], setAside: [], replaced: ['b'] } }));
    render(pane());
    expect(screen.getByText('The board changed after this reading. 1 image was replaced.')).toBeTruthy();
  });

  it('is quiet while the image set is the same', () => {
    setBoard(state({ reading: reading() }));
    render(pane({ images: [image('a', { notes: 'new' }), image('b'), image('c')] }));
    expect(screen.queryByText(/The board changed/)).toBeNull();
  });
});

describe('failures', () => {
  it('says why under GM’s heading, with the earlier reading below', () => {
    setBoard(state({ reading: reading(), run: run({ status: 'failed', cause: 'timeout' }) }));
    render(pane());
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Nebula couldn’t read the board')).toBeTruthy();
    expect(within(alert).getByText('Gemini didn’t answer in time. Try again.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Light' })).toBeTruthy();
  });

  it('offers Use API key on a plan limit when a key exists, and runs on the key', () => {
    setBoard(state({ run: run({ status: 'failed', cause: 'plan_limit' }) }));
    render(pane());
    expect(screen.getByText('Your Antigravity plan has reached its limit for now. Try again later, or use your Gemini API key.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use API key' }));
    expect(actions.start).toHaveBeenCalledWith('mb1', 'gemini_key');
  });

  it('has no Use API key without a key', () => {
    setBoard(state({ run: run({ status: 'failed', cause: 'plan_limit' }),
      route: { ...state().route, hasKey: false } }));
    render(pane());
    expect(screen.queryByRole('button', { name: 'Use API key' })).toBeNull();
  });

  it('uses the shared fallback for anything else, and says nothing for a stop', () => {
    setBoard(state({ run: run({ status: 'failed', cause: 'write_attempt' }) }));
    const { unmount } = render(pane());
    expect(screen.getByText('Try again, or reload if it keeps happening.')).toBeTruthy();
    unmount();
    setBoard(state({ run: run({ status: 'stopped' }) }));
    render(pane());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
