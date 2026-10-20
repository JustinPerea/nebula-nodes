import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Moodboard, MoodboardImage } from '../../types';

// A board's cover in Moodboard Studio (Justin, 2026-10-20: "Go"): "Use as
// cover" on an image, a clear mark on the cover, and Back to #1. A pick, not
// a reorder: it goes as a `cover` op, no image moves, and a cover set by an
// agent or another tab shows without a reload.

const api = vi.hoisted(() => ({
  analyzeMoodboard: vi.fn(),
  createMoodboard: vi.fn(),
  editMoodboard: vi.fn(),
  fetchMoodboard: vi.fn(),
  fetchMoodboards: vi.fn(),
  keepMoodboardBriefOverride: vi.fn(),
  lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(),
  updateMoodboard: vi.fn(),
}));
const socket = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/backend', () => ({ apiFetch: vi.fn(), backendAssetUrlSync: (url: string) => url }));
vi.mock('../../lib/wsClient', () => ({
  wsClient: {
    subscribe: (handler: (event: unknown) => void) => { socket.handlers.add(handler); return () => socket.handlers.delete(handler); },
    connect: () => {},
    send: () => {},
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

import { MoodboardStudioView } from './MoodboardStudioView';
import { MoodboardVersionConflict, type MoodboardOp } from '../../lib/moodboardEdits';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { assetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { NEW_MOODBOARD_SENTINEL } from '../../lib/studioSentinels';

const analysis = { version: 5, sourceHash: 'h1', summary: 'Warm.', palette: ['#e8593c'], accents: [] };
const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, ...extra });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The backend's cover rule (services/moodboard_store.py): the thumbnail is
 *  the cover image's url, else #1's; a cover whose image left goes. */
function withThumbnail(board: Moodboard): Moodboard {
  const cover = board.images.find((img) => img.id === board.coverImageId);
  const coverImageId = cover ? cover.id : null;
  return { ...board, coverImageId, thumbnail: (cover ?? board.images[0])?.url ?? '' };
}

const server: { board: Moodboard; puts: Record<string, unknown>[]; edits: MoodboardOp[][] } = {
  board: null as unknown as Moodboard, puts: [], edits: [],
};

function serverEdit(board: Moodboard, op: MoodboardOp): Moodboard {
  const next = { ...board };
  if (op.op === 'cover') {
    if (op.image !== null && !next.images.some((img) => img.id === op.image)) throw new Error('no image');
    next.coverImageId = op.image;
  }
  if (op.op === 'remove') {
    next.images = next.images.filter((img) => !op.images.includes(img.id));
    next.analysis = null;
  }
  return withThumbnail(next);
}

function outsideWrite(update: (board: Moodboard) => Moodboard, { announce = true } = {}) {
  server.board = withThumbnail({ ...update(clone(server.board)), version: server.board.version + 1 });
  if (!announce) return;
  act(() => {
    for (const handler of socket.handlers) {
      handler({ type: 'storedAssetChanged', kind: 'moodboard', id: server.board.id, deleted: false,
        version: server.board.version, edit: { actor: { kind: 'agent', name: 'Claude' } },
        touched: { images: [String(server.board.coverImageId ?? '')], frames: [], looks: [] } });
    }
  });
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  socket.handlers.clear();
  server.board = withThumbnail({
    id: 'g1', name: 'Painterly space', version: 1, notes: '', mode: 'look', strength: 0.7,
    images: [image('i1'), image('i2', { notes: 'nebula' }), image('i3', { excluded: true })], analysis,
    direction: '', avoid: [], pinnedColors: { include: [], exclude: [] }, briefOverride: null,
    coverImageId: null, thumbnail: '', createdAt: '', updatedAt: '',
  } as unknown as Moodboard);
  server.puts = [];
  server.edits = [];
  api.fetchMoodboard.mockImplementation(async (id: string) => (id === server.board.id ? clone(server.board) : null));
  api.fetchMoodboards.mockImplementation(async (scope: string) => (scope === 'global' ? [clone(server.board)] : []));
  api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
  api.updateMoodboard.mockImplementation(async (_id: string, body: Record<string, unknown>) => {
    server.puts.push(body);
    const fields = { ...body };
    delete fields.baseVersion;
    server.board = withThumbnail({ ...server.board, ...fields, version: server.board.version + 1 } as Moodboard);
    return clone(server.board);
  });
  api.editMoodboard.mockImplementation(async (_id: string, ops: MoodboardOp[], baseVersion?: number) => {
    server.edits.push(ops);
    if (typeof baseVersion === 'number' && baseVersion !== server.board.version) {
      throw new MoodboardVersionConflict(clone(server.board));
    }
    server.board = { ...ops.reduce(serverEdit, server.board), version: server.board.version + 1 };
    return { board: clone(server.board), version: server.board.version, applied: [], undo: { ops: [] } };
  });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  setOpenProject(['p1', 'Project']);
});

async function openStudio() {
  act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
  render(<MoodboardStudioView />);
  await screen.findByDisplayValue('Painterly space');
}

const preview = () => document.querySelector('.moodboard-def__cover img')?.getAttribute('src');
const tiles = () => Array.from(document.querySelectorAll<HTMLElement>('.moodboard-tile'));
const tileImages = () => tiles().map((tile) => tile.querySelector('.moodboard-tile__image img')?.getAttribute('src'));
const caption = () => document.querySelector('.moodboard-def__cover-caption')?.textContent;
const coverMarks = () => tiles().map((tile) => tile.querySelector('.moodboard-tile__cover')?.textContent ?? null);

describe('choosing the cover in Moodboard Studio', () => {
  it('opens on #1 and says so until a cover is chosen', async () => {
    await openStudio();
    expect(preview()).toBe('/api/outputs/i1.png');
    expect(caption()).toBe('Cover: #1, the first image');
    expect(coverMarks()).toEqual(['Cover', null, null]);
    expect(within(tiles()[0]).queryByRole('button', { name: /as cover/ })).toBeNull();
    expect(within(tiles()[1]).getByRole('button', { name: 'Use #2 as cover' })).toBeTruthy();
  });

  it('"Use as cover" sends one cover op and moves nothing', async () => {
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Use #2 as cover' }));
    // At once, before the save: the preview, the mark and the caption.
    expect(preview()).toBe('/api/outputs/i2.png');
    expect(coverMarks()).toEqual([null, 'Cover', null]);
    expect(caption()).toContain('Cover: #2');

    await waitFor(() => expect(server.edits).toEqual([[{ op: 'cover', image: 'i2' }]]), { timeout: 3000 });
    expect(api.editMoodboard.mock.calls[0][2]).toBe(1);
    expect(server.puts).toEqual([]);
    expect(server.board.coverImageId).toBe('i2');
    // Every image keeps its place and settings, and the analysis stays.
    expect(tileImages()).toEqual(['/api/outputs/i1.png', '/api/outputs/i2.png', '/api/outputs/i3.png']);
    expect(server.board.images.map((img) => img.id)).toEqual(['i1', 'i2', 'i3']);
    expect(server.board.analysis).toEqual(analysis);
    expect(screen.getByText('Warm.')).toBeTruthy();
  });

  it('a set-aside image can be the cover', async () => {
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Use #3 as cover' }));
    expect(preview()).toBe('/api/outputs/i3.png');
    await waitFor(() => expect(server.board.coverImageId).toBe('i3'), { timeout: 3000 });
  });

  it('Back to #1 clears the cover', async () => {
    server.board = withThumbnail({ ...server.board, coverImageId: 'i2' });
    await openStudio();
    expect(preview()).toBe('/api/outputs/i2.png');
    fireEvent.click(within(tiles()[1]).getByRole('button', { name: 'Back to #1' }));
    expect(preview()).toBe('/api/outputs/i1.png');
    expect(coverMarks()).toEqual(['Cover', null, null]);
    await waitFor(() => expect(server.edits).toEqual([[{ op: 'cover', image: null }]]), { timeout: 3000 });
    expect(server.board.coverImageId).toBeNull();
  });

  it('removing the cover image falls back to #1 at once', async () => {
    server.board = withThumbnail({ ...server.board, coverImageId: 'i2' });
    await openStudio();
    fireEvent.click(within(tiles()[1]).getByRole('button', { name: 'x' }));
    expect(preview()).toBe('/api/outputs/i1.png');
    expect(caption()).toBe('Cover: #1, the first image');
    await waitFor(() => expect(server.board.images.map((img) => img.id)).toEqual(['i1', 'i3']), { timeout: 3000 });
    expect(server.board.coverImageId).toBeNull();
  });
});

describe('a cover set elsewhere shows without a reload', () => {
  it("an agent's cover shows in the board, its mark and the rail", async () => {
    await openStudio();
    await screen.findByText('3 images · 1 set aside · look');
    const listed = api.fetchMoodboards.mock.calls.length;
    outsideWrite((board) => ({ ...board, coverImageId: 'i2' }));

    await waitFor(() => expect(preview()).toBe('/api/outputs/i2.png'));
    expect(coverMarks()).toEqual([null, 'Cover', null]);
    await waitFor(() => expect(api.fetchMoodboards.mock.calls.length).toBeGreaterThan(listed));
    await waitFor(() => expect(document.querySelector('.moodboard-rail__thumb img')?.getAttribute('src'))
      .toBe('/api/outputs/i2.png'));
    // Nothing was the person's to save.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(server.edits).toEqual([]);
    expect(server.puts).toEqual([]);
  });

  it('a cover set while the socket was down shows once it comes back', async () => {
    await openStudio();
    outsideWrite((board) => ({ ...board, coverImageId: 'i3' }), { announce: false });
    act(() => { for (const handler of socket.handlers) handler({ type: 'socketReconnected' }); });
    await waitFor(() => expect(preview()).toBe('/api/outputs/i3.png'));
    expect(coverMarks()).toEqual([null, null, 'Cover']);
    await waitFor(() => expect(document.querySelector('.moodboard-rail__thumb img')?.getAttribute('src'))
      .toBe('/api/outputs/i3.png'));
  });

  it("the person's pick queued while an agent picked another wins, and is sent", async () => {
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Use #3 as cover' }));
    outsideWrite((board) => ({ ...board, coverImageId: 'i2' }));
    await waitFor(() => expect(server.board.coverImageId).toBe('i3'), { timeout: 3000 });
    expect(preview()).toBe('/api/outputs/i3.png');
  });
});

describe('a cover set while the Studio was closed', () => {
  it('shows when the Studio opens again on its kept draft', async () => {
    // Review, 2026-10-20: a draft kept from an earlier visit opened as it was
    // left, so the preview and marks showed the old cover while the rail
    // (read fresh) showed the new one; the name was stale the same way.
    await openStudio();
    cleanup();
    outsideWrite((board) => ({ ...board, coverImageId: 'i2', name: 'Renamed outside' }));
    render(<MoodboardStudioView />);
    await waitFor(() => expect(preview()).toBe('/api/outputs/i2.png'), { timeout: 3000 });
    expect(coverMarks()).toEqual([null, 'Cover', null]);
    expect(screen.getByDisplayValue('Renamed outside')).toBeTruthy();
    // Nothing was the person's to save.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(server.edits).toEqual([]);
    expect(server.puts).toEqual([]);
  });

  it("keeps the person's own unsaved pick when it opens again", async () => {
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Use #3 as cover' }));
    api.editMoodboard.mockImplementation(() => new Promise(() => {}));  // the save never lands
    cleanup();
    outsideWrite((board) => ({ ...board, coverImageId: 'i2' }), { announce: false });
    render(<MoodboardStudioView />);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(preview()).toBe('/api/outputs/i3.png');
  });
});

describe('a cover picked on a board not saved yet', () => {
  it('goes with the board when it is made, and is not sent again', async () => {
    // Review, 2026-10-20: the first save makes the board with its cover.
    api.createMoodboard.mockImplementation(async (body: Partial<Moodboard>) => {
      server.board = withThumbnail({ ...server.board, ...body, id: 'made1', version: 1 } as Moodboard);
      return clone(server.board);
    });
    act(() => { useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, 'global'); });
    render(<MoodboardStudioView />);
    await screen.findByDisplayValue('Untitled Moodboard');
    const key = assetStudioDraftKey('moodboard', 'global', NEW_MOODBOARD_SENTINEL, 'p1');
    // No name yet, so nothing saves before the pick.
    act(() => {
      useAssetStudioDraftStore.getState().edit(key, (draft) => ({ ...(draft as object), name: '',
        images: [image('n1'), image('n2')] }));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Use #2 as cover' }));
    expect(preview()).toBe('/api/outputs/n2.png');
    act(() => { useAssetStudioDraftStore.getState().edit(key, (draft) => ({ ...(draft as object), name: 'Fresh' })); });

    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.createMoodboard.mock.calls[0][0].coverImageId).toBe('n2');
    expect(api.createMoodboard.mock.calls[0][0]).not.toHaveProperty('pendingOps');
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(server.edits).toEqual([]);
    expect(server.board.coverImageId).toBe('n2');
    expect(preview()).toBe('/api/outputs/n2.png');
  });
});
