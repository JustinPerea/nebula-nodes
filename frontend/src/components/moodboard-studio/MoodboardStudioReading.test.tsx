import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Moodboard, MoodboardImage, MoodboardPlacement } from '../../types';
import type { BoardReading, BoardReadingRun, BoardReadingState } from '../../lib/boardReading';

// Read the board in Moodboard Studio (GM's surface design, 2026-10-31): the
// side panel's Settings / Reading switch and its activity dot, the List's
// Reading section after Direction, a chip's click on the Board and in the
// List, "Replaced the reading · Undo", and Review opening the Reading part.

const api = vi.hoisted(() => ({
  analyzeMoodboard: vi.fn(), createMoodboard: vi.fn(), editMoodboard: vi.fn(), fetchMoodboard: vi.fn(),
  fetchMoodboards: vi.fn(), keepMoodboardBriefOverride: vi.fn(), lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(), updateMoodboard: vi.fn(),
}));
const reads = vi.hoisted(() => ({
  fetchBoardReading: vi.fn(), startBoardReading: vi.fn(), stopBoardReading: vi.fn(), undoBoardReading: vi.fn(),
}));
const socket = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/boardReading', async (importOriginal) => ({ ...(await importOriginal<object>()), ...reads }));
vi.mock('../../lib/graphFile', () => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('../../lib/backend', () => ({ apiFetch: vi.fn(), backendAssetUrlSync: (url: string) => url }));
vi.mock('../../lib/wsClient', () => ({
  wsClient: {
    subscribe: (handler: (event: unknown) => void) => { socket.handlers.add(handler); return () => socket.handlers.delete(handler); },
    connect: () => {}, send: () => {},
  },
}));
vi.mock('../WorkspaceHeader', () => ({
  WorkspaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../asset-trash/AssetTrash', () => ({ RecentlyDeletedAssets: () => null, UndoDeleteToast: () => null }));
vi.mock('../../hooks/useAssetDelete', () => ({
  useAssetDelete: () => ({ lastDeleted: null, busy: false, error: null, refreshKey: 0, remove: vi.fn(),
    undo: vi.fn(), dismiss: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('./BoardCanvas', () => ({ BoardCanvas: () => <div data-testid="board-canvas" /> }));

import { MoodboardStudioView } from './MoodboardStudioView';
import { NoticeRegion } from '../NoticeRegion';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import { useBoardReadingStore } from '../../store/boardReadingStore';
import { useAssetProposalsStore } from '../../store/assetProposalsStore';

const card = (id: string, x = 0, y = 0): MoodboardPlacement => ({ id: `c-${id}`, frameId: null, x, y, w: 480, h: 270,
  weight: 1, placedBy: 'person', placedAt: '2026-10-20T00:00:00+00:00' });
const image = (id: string): MoodboardImage => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, placements: [card(id)] });

const reading = (id: string): BoardReading => ({
  id, model: 'gemini-4-argon', modelName: 'Gemini 4 Argon', route: 'antigravity', at: '2026-11-01T15:40:00',
  by: { kind: 'person' }, markdown: 'Warm dusk in `tile-i2.png`.',
  imageSet: { fingerprint: 'f', images: ['i1', 'i2'].map((i) => ({ id: i, hash: `h${i}`, url: `/api/outputs/${i}.png` })) },
  citations: ['i1', 'i2'].map((i, index) => ({ imageId: i, number: index + 1, file: `tile-${i}.png` })), cited: ['i2'],
});
const run = (extra: Partial<BoardReadingRun> = {}): BoardReadingRun => ({
  id: 'run1', boardId: 'g1', status: 'running', route: 'antigravity', count: 2, by: { kind: 'person' },
  startedAt: Date.now(), elapsedMs: 0, cause: null, readingId: null, ...extra });
const state = (extra: Partial<BoardReadingState> = {}): BoardReadingState => ({
  reading: null, markdown: null, tiles: [], stale: null, hasPrevious: false, run: null,
  route: { antigravity: { installed: true, signedIn: true }, hasKey: true, route: 'antigravity', count: 2,
    model: { id: 'gemini-4-argon', name: 'Gemini 4 Argon' }, estimate: { low: 0.01, high: 0.02, unpriced: false, unconfirmed: false } },
  ...extra,
});

const say = (event: unknown) => act(() => { for (const handler of socket.handlers) handler(event); });

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  Object.values(reads).forEach((mock) => mock.mockReset());
  socket.handlers.clear();
  const board = {
    id: 'g1', name: 'Desert light', version: 1, notes: '', mode: 'look', strength: 0.7,
    images: [image('i1'), image('i2')], analysis: null, direction: '', avoid: [],
    pinnedColors: { include: [], exclude: [] }, briefOverride: null, thumbnail: '/api/outputs/i1.png', createdAt: '', updatedAt: '',
  } as unknown as Moodboard;
  api.fetchMoodboard.mockImplementation(async (id: string) => (id === 'g1' ? JSON.parse(JSON.stringify(board)) : null));
  api.fetchMoodboards.mockResolvedValue([board]);
  api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
  reads.fetchBoardReading.mockResolvedValue(state());
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  useBoardCanvasStore.setState({ view: 'list', selection: {}, viewports: {}, studioBoard: null, showRequest: null,
    frameRequest: null, citeHover: null, listFocus: null });
  useBoardReadingStore.setState({ boards: {}, replaced: null, tab: 'settings' });
  useAssetProposalsStore.setState({ review: null, proposals: {} });
  setOpenProject(['p1', 'Project']);
});
afterEach(() => cleanup());

async function openStudio(view: 'list' | 'board' = 'list') {
  useBoardCanvasStore.setState({ view });
  act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
  render(
    <ReactFlowProvider>
      <MoodboardStudioView />
      <NoticeRegion screen="studio" />
    </ReactFlowProvider>,
  );
  await screen.findByDisplayValue('Desert light');
  await waitFor(() => expect(reads.fetchBoardReading).toHaveBeenCalledWith('g1'));
}

describe('the Board view’s side panel', () => {
  it('has Settings and Reading at its top; Reading shows the pane, Settings everything else', async () => {
    await openStudio('board');
    const tabs = screen.getByRole('tablist', { name: 'Board panel' });
    expect(within(tabs).getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeTruthy();
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Reading' }));
    expect(await screen.findByRole('button', { name: 'Read the board' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Analyze' })).toBeNull();
    // Arrow keys move between the two.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Reading' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true');
  });

  it('puts the activity dot on Reading while a read runs and Settings shows', async () => {
    await openStudio('board');
    say({ type: 'boardReadingRun', boardId: 'g1', run: run() });
    expect(screen.getByRole('tab', { name: 'Reading, a read is running' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Reading, a read is running' }));
    expect(screen.getByRole('tab', { name: 'Reading' })).toBeTruthy();
    say({ type: 'boardReadingRun', boardId: 'g1', run: run({ status: 'stopped' }) });
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByRole('tab', { name: 'Reading' })).toBeTruthy();
  });

  it('a chip selects its tile and asks the camera to move only if it isn’t in view', async () => {
    reads.fetchBoardReading.mockResolvedValue(state({ reading: reading('rd_1') }));
    await openStudio('board');
    fireEvent.click(screen.getByRole('tab', { name: 'Reading' }));
    fireEvent.click(await screen.findByRole('button', { name: '#2' }));
    const boards = useBoardCanvasStore.getState();
    const key = Object.keys(boards.selection)[0];
    expect(boards.selection[key]).toEqual(['c-i2']);
    expect(boards.frameRequest).toMatchObject({ boardKey: key, placementIds: ['c-i2'], onlyIfOutside: true });
    // The other way: the selected tile's chips take the selected style.
    expect(screen.getByRole('button', { name: '#2' }).className).toContain('board-reading__chip--selected');
  });
});

describe('the List view', () => {
  it('has a Reading section after Direction, before Extraction', async () => {
    await openStudio('list');
    const reading = await screen.findByRole('region', { name: 'Reading' });
    const direction = screen.getByRole('textbox', { name: 'What the board is for' });
    const analyze = screen.getByRole('button', { name: 'Analyze' });
    expect(direction.compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reading.compareDocumentPosition(analyze) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a chip scrolls to its row and highlights it', async () => {
    reads.fetchBoardReading.mockResolvedValue(state({ reading: reading('rd_1') }));
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
    await openStudio('list');
    fireEvent.click(await screen.findByRole('button', { name: '#2' }));
    const row = document.querySelector('[data-list-image-id="i2"]') as HTMLElement;
    expect(scrolled).toContain(row);
    expect(row.dataset.found).toBe('true');
    expect(useBoardCanvasStore.getState().frameRequest).toBeNull();
  });

  it('a chip hovered rings its row', async () => {
    reads.fetchBoardReading.mockResolvedValue(state({ reading: reading('rd_1') }));
    await openStudio('list');
    fireEvent.pointerEnter(await screen.findByRole('button', { name: '#2' }));
    expect(document.querySelector('[data-list-image-id="i2"]')!.className).toContain('moodboard-tile--cited');
  });
});

describe('a read that replaces the reading', () => {
  it('says "Replaced the reading" with Undo, which puts the earlier one back', async () => {
    reads.fetchBoardReading.mockResolvedValueOnce(state({ reading: reading('rd_1') }));
    await openStudio('list');
    await screen.findByRole('button', { name: '#2' });
    reads.fetchBoardReading.mockResolvedValue(state({ reading: reading('rd_2'), hasPrevious: true,
      run: run({ status: 'done', readingId: 'rd_2' }) }));
    reads.undoBoardReading.mockResolvedValue(undefined);
    say({ type: 'boardReadingRun', boardId: 'g1', run: run({ status: 'done', readingId: 'rd_2' }) });
    const toast = await screen.findByRole('status', { name: 'Board undo' });
    expect(within(toast).getByText('Replaced the reading')).toBeTruthy();
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(reads.undoBoardReading).toHaveBeenCalledWith('g1', 'rd_2'));
  });
});

const proposal = (id: string, change: Record<string, unknown>) => ({
  view: { id, status: 'open', agent: { id: 'a1', name: 'Claude Code', color: '#f60' }, note: '', kind: 'moodboard',
    target: { kind: 'moodboard', id: 'g1', name: 'Desert light' }, change, summary: '', decideIn: 'moodboard-studio',
    createdAt: Date.now(), expiresAt: Date.now() + 900_000, reason: null, applied: null },
  acceptKey: 'k', closing: false,
});

describe('Review on a read proposal', () => {
  it('opens the Reading part of the panel', async () => {
    await openStudio('board');
    act(() => {
      useAssetProposalsStore.setState({
        proposals: { ap1: proposal('ap1', { read: { route: 'gemini_key', model: 'gemini-4-argon', modelName: 'Gemini 4 Argon',
          images: 2, provider: 'Google', cost: { low: 0.01, high: 0.02 } } }) } as never,
        review: { kind: 'moodboard', targetId: 'g1', at: Date.now(), proposalId: 'ap1' },
      });
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Reading' }).getAttribute('aria-selected')).toBe('true'));
    // Its card is there, in GM's words.
    const card = await screen.findByRole('group', { name: 'Claude Code proposes' });
    expect(within(card).getByText('Read the board with Gemini 4 Argon')).toBeTruthy();
    expect(within(card).getByText('Sends 2 images to Google · ~$0.02')).toBeTruthy();
    expect(within(card).getByText(/^List prices, not a quote · expires in 1[45]:\d\d$/)).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Accept & run' })).toBeTruthy();
  });

  it('leaves the panel alone for a Send notes proposal', async () => {
    await openStudio('board');
    act(() => {
      useAssetProposalsStore.setState({
        proposals: { ap2: proposal('ap2', { sendNotes: { from: false, to: true } }) } as never,
        review: { kind: 'moodboard', targetId: 'g1', at: Date.now(), proposalId: 'ap2' },
      });
    });
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true');
    // It stays beside Send notes, and the Reading part doesn't show it.
    expect(screen.getByRole('group', { name: 'Claude Code asks to send these notes to generators' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Reading' }));
    await screen.findByRole('button', { name: 'Read the board' });
    expect(screen.queryByRole('group', { name: 'Claude Code asks to send these notes to generators' })).toBeNull();
  });
});
