import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Moodboard, MoodboardImage, MoodboardPlacement } from '../../types';

// Cmd+V in Moodboard Studio (Justin decided, 2026-10-31): the clipboard's
// images go through the drop path (same filter, upload, placement and one
// undo step) in Board and List views, a paste meant for a text field stays
// the field's, and a paste with nothing to add says so. The canvas is a
// stand-in (BoardCanvas.test.tsx covers where the pointer puts a paste); it
// hands the Studio a fixed paste target (point and view), as the board does,
// and records the outside-the-view chip it is given.

const api = vi.hoisted(() => ({
  analyzeMoodboard: vi.fn(), createMoodboard: vi.fn(), editMoodboard: vi.fn(), fetchMoodboard: vi.fn(),
  fetchMoodboards: vi.fn(), keepMoodboardBriefOverride: vi.fn(), lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(), updateMoodboard: vi.fn(), SAVE_BOARD: "Couldn't save the board.",
}));
const backend = vi.hoisted(() => ({ apiFetch: vi.fn() }));
const board = vi.hoisted(() => ({
  point: { x: 900, y: 300 } as { x: number; y: number } | null,
  view: { x: -1000, y: -1000, width: 4000, height: 3000 } as { x: number; y: number; width: number; height: number } | null,
  /** The part of the view a tile is seen in (round 6f): null leaves it out, as a target without it. */
  seen: null as { x: number; y: number; width: number; height: number } | null,
  outside: null as null | { id: number; rects: Array<{ x: number; y: number; width: number; height: number }>; thumb: string | null },
  placeholders: [] as Array<{ id: string; x: number; y: number; width: number; height: number; source?: unknown; filled?: { imageId: string; url: string }; listOnly?: boolean }>,
  filledDone: null as null | ((ids: string[]) => void),
  onDropFiles: null as null | ((files: File[], target: { at: { x: number; y: number };
    view: { x: number; y: number; width: number; height: number } | null; aim: boolean }) => void),
  offline: false,
}));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/graphFile', () => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('../../lib/backend', () => ({ apiFetch: backend.apiFetch, backendAssetUrlSync: (url: string) => url }));
vi.mock('../../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));
vi.mock('../WorkspaceHeader', () => ({
  WorkspaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../asset-trash/AssetTrash', () => ({ RecentlyDeletedAssets: () => null, UndoDeleteToast: () => null }));
// The trash's remove: a test can make it put the board in the trash (resolve true).
const removeAsset = vi.hoisted(() => ({ fn: null as null | ((...args: unknown[]) => Promise<unknown>) }));
vi.mock('../../hooks/useAssetDelete', () => ({
  useAssetDelete: () => ({ lastDeleted: null, busy: false, error: null, refreshKey: 0,
    remove: (...args: unknown[]) => (removeAsset.fn ? removeAsset.fn(...args) : Promise.resolve(undefined)),
    undo: vi.fn(), dismiss: vi.fn(), refresh: vi.fn() }),
}));
// jsdom loads no image: each pasted file reads as 3:2 at once (or once
// `aspectGate.wait` settles, for a test that holds the read).
const aspectGate = vi.hoisted(() => ({ wait: null as null | Promise<void> }));
vi.mock('../../lib/boardDrop', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/boardDrop')>(),
  readImageAspect: async () => { if (aspectGate.wait) await aspectGate.wait; return 1.5; },
}));
vi.mock('./BoardCanvas', async () => {
  const { useEffect } = await import('react');
  return {
    BoardCanvas: (props: {
      images: MoodboardImage[];
      onDropFiles: NonNullable<typeof board.onDropFiles>;
      pasteTarget?: { current: (() => { at: { x: number; y: number }; view: typeof board.view; aim: boolean }) | null };
      outside?: typeof board.outside;
      placeholders?: typeof board.placeholders;
      onPlaceholdersFilled?: (ids: string[]) => void;
      offline?: boolean;
    }) => {
      board.onDropFiles = props.onDropFiles;
      board.offline = props.offline ?? false;
      board.filledDone = props.onPlaceholdersFilled ?? null;
      board.outside = props.outside ?? null;
      board.placeholders = props.placeholders ?? [];
      const ref = props.pasteTarget;
      useEffect(() => {
        if (!ref) return undefined;
        const read = () => ({ at: board.point!, view: board.view, ...(board.seen ? { seen: board.seen } : {}), aim: false });
        ref.current = read;
        return () => { ref.current = null; };
      }, [ref]);
      return <div data-testid="board-canvas">{props.images.map((img) => <span key={img.id}>{img.url}</span>)}</div>;
    },
  };
});

import { MoodboardStudioView } from './MoodboardStudioView';
import { dropWaitingSend, keepWaitingSend, resetBoardAdds, useBoardAddStore } from './boardAdds';
import { resetUnsavedDrafts, restoreUnsavedDrafts } from './unsavedDrafts';
import { OfflineRefusal, isBackendOffline, noteBackendConnection, noteProbeAnswer, startHealthProbe,
  subscribeHealthProbeRequests } from '../../lib/backendConnection';
import { ConnectionLostError, RequestFailedError } from '../../lib/errorCopy';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALREADY_BEING_ADDED, LINKS_NOT_ADDED, NOTHING_TO_PASTE, reloadLostLine, uriListLinks, webLinks } from './pasteImages';
import { placeTiles, respot } from '../../lib/boardPlacement';
import { sizeFor } from '../../lib/moodboardLayout';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { emptyAssetStudioEntry, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { MOODBOARD_VIEW_KEY, useBoardCanvasStore } from '../../store/boardCanvasStore';
import { useBoardUndoStore } from '../../lib/boardUndo';
import { MoodboardVersionConflict, type MoodboardOp } from '../../lib/moodboardEdits';

const card = (id: string, x = 0, y = 0): MoodboardPlacement => ({ id: `c-${id}`, frameId: null, x, y, w: 480, h: 270,
  weight: 1, placedBy: 'person', placedAt: '2026-10-20T00:00:00+00:00' });
const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, placements: [card(id)], ...extra });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const server = { board: null as unknown as Moodboard, edits: [] as MoodboardOp[][], puts: [] as Record<string, unknown>[],
  before: new Map<string, MoodboardImage[]>(), uploads: [] as string[] };

/** /api/uploads: each file's name back as its output url; `refuse` answers a status instead. */
let refuse: { status: number; body: unknown } | null = null;
function uploadResponse(path: string, init?: RequestInit) {
  if (path !== '/api/uploads') throw new Error(`unexpected request ${path}`);
  const file = (init?.body as FormData).get('file') as File;
  server.uploads.push(file.name);
  if (refuse) return new Response(JSON.stringify(refuse.body), { status: refuse.status, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ url: `/api/outputs/chat-uploads/${file.name}` }), {
    status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  Object.values(api).forEach((mock) => { if (typeof mock !== 'string') mock.mockReset(); });
  backend.apiFetch.mockReset().mockImplementation(async (path: string, init?: RequestInit) => uploadResponse(path, init));
  refuse = null;
  aspectGate.wait = null;
  removeAsset.fn = null;
  board.point = { x: 900, y: 300 };
  board.view = { x: -1000, y: -1000, width: 4000, height: 3000 };
  board.seen = null;
  board.outside = null;
  board.placeholders = [];
  board.filledDone = null;
  board.onDropFiles = null;
  server.board = {
    id: 'g1', name: 'Global board', version: 1, notes: '', mode: 'look', strength: 0.7,
    images: [image('i1'), image('i2', { placements: [card('i2', 520, 0)] })],
    analysis: null, direction: '', avoid: [], pinnedColors: { include: [], exclude: [] }, briefOverride: null,
    thumbnail: '/api/outputs/i1.png', createdAt: '', updatedAt: '',
  } as unknown as Moodboard;
  server.edits = [];
  server.puts = [];
  server.before.clear();
  server.uploads = [];
  api.fetchMoodboard.mockImplementation(async (id: string) => (id === server.board.id ? clone(server.board) : null));
  api.fetchMoodboards.mockImplementation(async (scope: string) => (scope === 'global' ? [clone(server.board)] : []));
  api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
  api.updateMoodboard.mockImplementation(async (_id: string, body: Record<string, unknown>) => {
    server.puts.push(body);
    const fields = { ...body };
    delete fields.baseVersion;
    server.board = { ...server.board, ...fields, version: server.board.version + 1 } as Moodboard;
    return clone(server.board);
  });
  api.editMoodboard.mockImplementation(async (_id: string, ops: MoodboardOp[]) => {
    server.edits.push(ops);
    const tag = `u${server.edits.length}`;
    server.before.set(tag, clone(server.board.images));
    let images = clone(server.board.images);
    for (const op of ops) {
      if (op.op === 'add') {
        images = [...images, ...op.images.map((img) => image(img.id!, { url: img.url,
          placements: 'at' in op && op.at ? [card(img.id!, op.at.x, op.at.y)] : [card(img.id!)] }))];
      }
      if (op.op === 'remove') images = images.filter((img) => !op.images.includes(img.id));
      if (op.op === 'restore') images = clone(server.before.get(String((op.slices[0] as { tag: string }).tag))!);
    }
    server.board = { ...server.board, images, version: server.board.version + 1 };
    return { board: clone(server.board), version: server.board.version,
      applied: ops.map((op, index) => ({ index, op: op.op, status: 'applied' as const,
        ...(op.op === 'restore' ? { skipped: [], removed: [] } : {}) })),
      undo: { ops: [{ op: 'restore', slices: [{ part: 'tag', tag }] }] } };
  });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  resetBoardAdds();
  useBoardUndoStore.setState({ histories: {} });
  useBoardCanvasStore.setState({ view: 'list', selection: {}, viewports: {}, studioBoard: null, showRequest: null, frameRequest: null });
  try { window.localStorage.removeItem(MOODBOARD_VIEW_KEY); } catch { /* jsdom */ }
  try { window.sessionStorage.removeItem('nebula:moodboard-adds-in-flight'); } catch { /* jsdom */ }
  try { window.sessionStorage.removeItem('nebula:moodboard-sends-waiting'); } catch { /* jsdom */ }
  try { window.sessionStorage.removeItem('nebula:moodboard-unsaved-drafts'); } catch { /* jsdom */ }
  try { window.sessionStorage.removeItem('nebula:moodboard-kept-edits'); } catch { /* jsdom */ }
  resetUnsavedDrafts();
  setOpenProject(['p1', 'Project']);
});
afterEach(() => { cleanup(); noteBackendConnection('online'); });

async function openStudio(view: 'list' | 'board' = 'list') {
  useBoardCanvasStore.setState({ view });
  act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
  render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
  await screen.findByDisplayValue('Global board');
  if (view === 'board') await screen.findByTestId('board-canvas');
}

/** A clipboard as the browser hands it to a paste: files, and text by type. */
function clipboard({ files = [] as File[], text = '', html = '', uriList = '', itemsOnly = false } = {}): DataTransfer {
  const types = [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : []), ...(html ? ['text/html'] : []),
    ...(uriList ? ['text/uri-list'] : [])];
  // `itemsOnly`: Chrome's screenshot path, the image only in `items`, `files` empty.
  const listed = itemsOnly ? [] : files;
  return {
    files: Object.assign([...listed], { item: (index: number) => listed[index] ?? null }) as unknown as FileList,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })) as unknown as DataTransferItemList,
    types,
    getData: (type: string) => ({ 'text/plain': text, 'text/html': html, 'text/uri-list': uriList } as Record<string, string>)[type] ?? '',
  } as unknown as DataTransfer;
}
/** The board's draft as the Studio holds it (what the person sees), before any save. */
const draftUrls = () => {
  const found = Object.values(useAssetStudioDraftStore.getState().entries).find((e) => e.savedId === 'g1');
  return ((found?.draft as { images?: MoodboardImage[] } | undefined)?.images ?? []).map((img) => img.url);
};
const keyV = (type: 'keydown' | 'keyup', init: KeyboardEventInit = {}) => act(() => {
  document.body.dispatchEvent(new KeyboardEvent(type, { key: 'v', metaKey: type === 'keydown', bubbles: true, cancelable: true, ...init }));
});
function paste(data: DataTransfer, target: Element = document.body) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: data });
  act(() => { target.dispatchEvent(event); });
  return event;
}
const png = (name: string, size = 16) => new File([new Uint8Array(size)], name, { type: 'image/png' });
const addOps = () => server.edits.flat().filter((op) => op.op === 'add') as Extract<MoodboardOp, { op: 'add' }>[];
const urls = () => server.board.images.map((img) => img.url);
const press = (key: string, init: KeyboardEventInit = {}) => {
  act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
};

describe('a paste in the Board view', () => {
  it('one file lands at the paste point, through the upload, as one step sent at once', async () => {
    await openStudio('board');
    const event = paste(clipboard({ files: [png('shot.png')] }));
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(server.uploads).toEqual(['shot.png']);
    const [add] = addOps();
    expect(add.images[0].url).toBe('/api/outputs/chat-uploads/shot.png');
    // The shared placement (lib/boardPlacement) with the board's tiles: i2
    // sits under the point, so the tile goes to the nearest free spot.
    const occupied = [{ x: 0, y: 0, width: 480, height: 270 }, { x: 520, y: 0, width: 480, height: 270 }];
    const expected = placeTiles({ at: { x: 900, y: 300 }, sizes: [sizeFor(1, 1.5)], occupied, view: board.view });
    expect(add.at).toEqual(expected.spots[0]);
    const [w, h] = sizeFor(1, 1.5);
    for (const o of occupied) {
      expect(add.at!.x + w + 24 <= o.x || o.x + o.width + 24 <= add.at!.x
        || add.at!.y + h + 24 <= o.y || o.y + o.height + 24 <= add.at!.y).toBe(true);
    }
  });

  it('a drop keeps its aim on a free spot, and slides off a tile it would cover', async () => {
    await openStudio('board');
    const view = board.view;
    act(() => { board.onDropFiles!([png('aimed.png')], { at: { x: 2000, y: 1500 }, view, aim: true }); });
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const [w, h] = sizeFor(1, 1.5);
    expect(addOps()[0].at).toEqual({ x: Math.round(2000 - w / 2), y: Math.round(1500 - h / 2) });
    act(() => { board.onDropFiles!([png('onto.png')], { at: { x: 240, y: 135 }, view, aim: true }); });
    await waitFor(() => expect(addOps()).toHaveLength(2));
    const nudged = addOps()[1].at!;
    expect(nudged).not.toEqual({ x: Math.round(240 - w / 2), y: Math.round(135 - h / 2) });
    expect(nudged.y >= 270 + 24 || nudged.x >= 1000 + 24 || nudged.x + w + 24 <= 0 || nudged.y + h + 24 <= 0).toBe(true);
  });

  it('a tile placed in the view but under the notice band gets the chip (round 6f, GM r14)', async () => {
    await openStudio('board');
    board.view = { x: 0, y: 0, width: 1000, height: 1000 };
    board.seen = { x: 0, y: 0, width: 1000, height: 600 };
    board.point = { x: 500, y: 820 };
    paste(clipboard({ files: [png('low.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const [w, h] = sizeFor(1, 1.5);
    const at = addOps()[0].at!;
    expect(at.y >= 600 && at.y + h <= 1000).toBe(true);
    await waitFor(() => expect(board.outside?.rects).toEqual([{ ...at, width: w, height: h }]));
  });

  it('with no room in view, the tile goes just outside it and the board gets the chip; the next paste takes it away', async () => {
    await openStudio('board');
    // The view holds only the two tiles.
    board.view = { x: 0, y: 0, width: 1000, height: 270 };
    board.point = { x: 500, y: 135 };
    paste(clipboard({ files: [png('nowhere.png')] }));
    await waitFor(() => expect(board.outside).not.toBeNull());
    const [w, h] = sizeFor(1, 1.5);
    expect(board.outside!.rects).toEqual([{ ...addOps()[0].at!, width: w, height: h }]);
    expect(board.outside!.thumb).toBe('/api/outputs/chat-uploads/nowhere.png');
    paste(clipboard({ text: 'words' }));
    expect(board.outside).toBeNull();
  });

  it('three files each take the nearest free spot, overlapping nothing, in one batch', async () => {
    await openStudio('board');
    paste(clipboard({ files: [png('a.png'), png('b.png'), png('c.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(3));
    expect(server.edits).toHaveLength(1);
    const [w, h] = sizeFor(1, 1.5);
    const rects = [{ x: 0, y: 0, width: 480, height: 270 }, { x: 520, y: 0, width: 480, height: 270 },
      ...addOps().map((op) => ({ ...op.at!, width: w, height: h }))];
    rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => {
      expect(a.x + a.width + 24 <= b.x || b.x + b.width + 24 <= a.x || a.y + a.height + 24 <= b.y || b.y + b.height + 24 <= a.y).toBe(true);
    }));
    expect(addOps().map((op) => op.images[0].url)).toEqual(['a.png', 'b.png', 'c.png'].map((n) => `/api/outputs/chat-uploads/${n}`));
  });

  it('lands where the board says: the pointer, or the middle of the view when it isn\'t over the board', async () => {
    await openStudio('board');
    board.point = { x: -2000, y: 4000 };
    board.view = { x: -3000, y: 3000, width: 2000, height: 2000 };
    paste(clipboard({ files: [png('there.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const [w, h] = sizeFor(1, 1.5);
    expect(addOps()[0].at).toEqual({ x: Math.round(-2000 - w / 2), y: Math.round(4000 - h / 2) });
  });

  it('a browser copy (the file and HTML with an <img>) takes the file and ignores the HTML', async () => {
    await openStudio('board');
    paste(clipboard({ files: [png('copied.png')], html: '<img src="https://example.com/other.png">',
      text: 'https://example.com/other.png' }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(addOps()[0].images.map((img) => img.url)).toEqual(['/api/outputs/chat-uploads/copied.png']);
    expect(backend.apiFetch.mock.calls.map(([path]) => path)).toEqual(['/api/uploads']);
  });

  it('Undo takes the whole paste back in one step', async () => {
    await openStudio('board');
    paste(clipboard({ files: [png('a.png'), png('b.png')] }));
    await waitFor(() => expect(urls()).toHaveLength(4));
    await waitFor(() => expect(screen.queryByText('Uploading')).toBeNull());
    press('z', { metaKey: true });
    await waitFor(() => expect(urls()).toEqual(['/api/outputs/i1.png', '/api/outputs/i2.png']));
    expect(server.edits.filter((ops) => ops[0].op === 'restore')).toHaveLength(1);
  });
});

describe('a paste in the List view', () => {
  it('appends the files at the end, in clipboard order, through the same upload', async () => {
    await openStudio('list');
    const event = paste(clipboard({ files: [png('one.png'), png('two.png'), png('three.png')] }));
    expect(event.defaultPrevented).toBe(true);
    // The draft is the state the person sees: it holds the images as soon as
    // the uploads answer, with no wait for the List's save debounce.
    await waitFor(() => expect(draftUrls()).toHaveLength(5));
    expect(draftUrls().slice(2)).toEqual(['one.png', 'two.png', 'three.png'].map((n) => `/api/outputs/chat-uploads/${n}`));
    const found = Object.values(useAssetStudioDraftStore.getState().entries).find((e) => e.savedId === 'g1');
    const added = ((found?.draft as { images: MoodboardImage[] }).images).slice(2);
    expect(added.every((img) => !img.placements?.length)).toBe(true);
  });

  it('one Cmd+Z takes a whole multi-file List paste back', async () => {
    await openStudio('list');
    paste(clipboard({ files: [png('l1.png'), png('l2.png')] }));
    await waitFor(() => expect(draftUrls()).toHaveLength(4));
    press('z', { metaKey: true });
    await waitFor(() => expect(draftUrls()).toEqual(['/api/outputs/i1.png', '/api/outputs/i2.png']), { timeout: 5000 });
    expect(addOps().filter((op) => op.op === 'add').length).toBeLessThanOrEqual(1);
  });

  it('an items-only clipboard (a screenshot in Chrome) uploads its image once', async () => {
    await openStudio('list');
    const event = paste(clipboard({ files: [png('screenshot.png')], itemsOnly: true }));
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(draftUrls()).toHaveLength(3));
    expect(server.uploads).toEqual(['screenshot.png']);
  });

  it('a non-image file is left out, as a drop leaves it out', async () => {
    await openStudio('list');
    paste(clipboard({ files: [new File(['x'], 'notes.txt', { type: 'text/plain' }), png('ok.png')] }));
    await waitFor(() => expect(draftUrls()).toHaveLength(3));
    expect(server.uploads).toEqual(['ok.png']);
  });

  it('an oversized file gives the upload\'s own line, as a drop does', async () => {
    await openStudio('list');
    refuse = { status: 413, body: { detail: 'File exceeds 20 MB limit' } };
    paste(clipboard({ files: [png('huge.png')] }));
    expect(await screen.findByText("Couldn't upload huge.png.")).toBeTruthy();
    expect(server.board.images).toHaveLength(2);
  });

  // /api/uploads never refuses an unconnected tab (it reads the person gate
  // only for create_node): such a tab's paste is written, as its drop and
  // Add Images are. This guards the line, whatever the refusal.
  it('an upload refusal shows the same line as Add Images', async () => {
    refuse = { status: 403, body: { detail: 'Only the person can do this, from a Nebula canvas connected as them.',
      code: 'person_required' } };
    await openStudio('list');
    paste(clipboard({ files: [png('p.png')] }));
    const pasted = await screen.findByText("Couldn't upload p.png.");
    const pastedLines = pasted.closest('.moodboard-studio__notice')!.textContent;
    cleanup();
    useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
    await openStudio('list');
    const input = screen.getAllByLabelText('Add Images').find((el) => el instanceof HTMLInputElement) as HTMLInputElement;
    act(() => {
      Object.defineProperty(input, 'files', { value: [png('p.png')], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const dropped = await screen.findByText("Couldn't upload p.png.");
    expect(dropped.closest('.moodboard-studio__notice')!.textContent).toBe(pastedLines);
    expect(server.edits).toHaveLength(0);
  });
});

describe('what a paste never takes', () => {
  it('a paste into the notes, an Image note, Direction or the name is the field\'s own, image or not', async () => {
    await openStudio('list');
    // GM #210 item 7: the board's notes, an Image note, Direction and the name (and a private note).
    const notes = screen.getByPlaceholderText('Anything about the board, in your words.');
    const imageNote = screen.getAllByPlaceholderText('What to take from this image')[0];
    const direction = screen.getByPlaceholderText(/Say what you want/);
    const privateNote = screen.getAllByPlaceholderText('A label for you, like Liked')[0];
    const name = screen.getByDisplayValue('Global board');
    for (const field of [notes, imageNote, direction, name, privateNote]) {
      const event = paste(clipboard({ files: [png('nope.png')], text: 'words' }), field);
      expect(event.defaultPrevented).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.uploads).toEqual([]);
    expect(screen.queryByText(NOTHING_TO_PASTE)).toBeNull();
  });

  it('data:, file:, blob: and javascript: links are refused, never fetched: the nothing-to-add line', async () => {
    await openStudio('list');
    for (const text of ['data:image/png;base64,iVBORw0KGgo=', 'file:///Users/me/a.png', 'blob:http://x/1', 'javascript:alert(1)']) {
      const event = paste(clipboard({ text }));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(await screen.findByText(NOTHING_TO_PASTE)).toBeTruthy();
    expect(backend.apiFetch).not.toHaveBeenCalled();
    expect(server.edits).toHaveLength(0);
  });

  it('a clipboard with no image and no link says so in the Studio notice', async () => {
    await openStudio('board');
    paste(clipboard({ text: 'just some words' }));
    expect(await screen.findByText(NOTHING_TO_PASTE)).toBeTruthy();
    expect(server.uploads).toEqual([]);
  });

  it('a paste while the Studio is no longer the active view adds nothing', async () => {
    await openStudio('list');
    act(() => { useUIStore.setState({ viewMode: 'canvas' }); });
    const event = paste(clipboard({ files: [png('elsewhere.png')] }));
    expect(event.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.uploads).toEqual([]);
  });

  it('a paste another listener already handled (defaultPrevented) is left alone', async () => {
    await openStudio('board');
    const refuseFirst = (event: Event) => event.preventDefault();
    document.addEventListener('paste', refuseFirst, true);
    try {
      paste(clipboard({ files: [png('refused.png')] }));
      paste(clipboard({ text: 'words' }));
    } finally {
      document.removeEventListener('paste', refuseFirst, true);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.uploads).toEqual([]);
    expect(screen.queryByText(NOTHING_TO_PASTE)).toBeNull();
  });

  it('a paste aimed at a control outside the Studio is neither taken nor prevented', async () => {
    await openStudio('list');
    const outside = document.createElement('button');
    outside.textContent = 'Chat';
    document.body.appendChild(outside);
    try {
      const event = paste(clipboard({ files: [png('dock.png')] }), outside);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      outside.remove();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.uploads).toEqual([]);
  });

  it('a paste with a modal dialog open is left to it, wherever focus is', async () => {
    await openStudio('board');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    try {
      expect(paste(clipboard({ files: [png('behind.png')] })).defaultPrevented).toBe(false);
      expect(paste(clipboard({ text: 'words' })).defaultPrevented).toBe(false);
    } finally {
      dialog.remove();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.uploads).toEqual([]);
    expect(screen.queryByText(NOTHING_TO_PASTE)).toBeNull();
  });

  it('a paste inside a non-modal dialog in the Studio is the dialog\'s', async () => {
    await openStudio('list');
    const studio = document.querySelector('.moodboard-studio-view')!;
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inside = document.createElement('button');
    dialog.appendChild(inside);
    studio.appendChild(dialog);
    try {
      expect(paste(clipboard({ files: [png('in-dialog.png')] }), inside).defaultPrevented).toBe(false);
    } finally {
      dialog.remove();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.uploads).toEqual([]);
  });

  it('a paste while the board is still loading is ignored and not prevented', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    api.fetchMoodboard.mockImplementation(async (id: string) => { await held; return id === server.board.id ? clone(server.board) : null; });
    useBoardCanvasStore.setState({ view: 'list' });
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    const event = paste(clipboard({ files: [png('early.png')] }));
    expect(event.defaultPrevented).toBe(false);
    await act(async () => { release(); await held; });
    await screen.findByDisplayValue('Global board');
    expect(server.uploads).toEqual([]);
  });

  it('no paste handler is left once the Studio is gone: every listener it added is removed', async () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    await openStudio('board');
    const mine = added.mock.calls.filter(([type]) => ['paste', 'keydown', 'keyup'].includes(String(type)));
    expect(mine.some(([type]) => type === 'paste')).toBe(true);
    cleanup();
    for (const [type, listener, options] of mine) {
      expect(removed.mock.calls.some(([t, l, o]) => t === type && l === listener && Boolean(o) === Boolean(options))).toBe(true);
    }
    added.mockRestore();
    removed.mockRestore();
    const event = paste(clipboard({ files: [png('later.png')] }));
    expect(event.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.uploads).toEqual([]);
  });
});

describe('links on the clipboard', () => {
  it('only http(s) links: GM\'s line, nothing fetched or added', async () => {
    await openStudio('board');
    const event = paste(clipboard({ text: 'https://example.com/a.png\nhttps://example.com/b.png' }));
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText(LINKS_NOT_ADDED)).toBeTruthy();
    expect(screen.queryByText(NOTHING_TO_PASTE)).toBeNull();
    expect(backend.apiFetch).not.toHaveBeenCalled();
    expect(server.edits).toHaveLength(0);
  });

  it('the lines read as GM wrote them', () => {
    expect(NOTHING_TO_PASTE).toBe('There’s no image on the clipboard to add.');
    expect(LINKS_NOT_ADDED).toBe('Nebula can’t add images from links. Copy the image itself, then paste it.');
  });

  it('are read only as http and https, one per line, and only when every line is one', () => {
    expect(webLinks('https://a.example/x.png\n http://b.example/y.jpg ')).toEqual(['https://a.example/x.png', 'http://b.example/y.jpg']);
    expect(webLinks('https://a.example/x.png\nnot a link')).toEqual([]);
    expect(webLinks('data:image/png;base64,AAAA')).toEqual([]);
    expect(webLinks('file:///a.png')).toEqual([]);
    expect(webLinks('javascript:alert(1)')).toEqual([]);
    // A hosted scheme that isn't the web, and http(s) with no `//` authority.
    expect(webLinks('ftp://h.example/a.png')).toEqual([]);
    expect(webLinks('ws://h.example/a')).toEqual([]);
    expect(webLinks('http:foo')).toEqual([]);
    expect(webLinks('https:example.com')).toEqual([]);
  });

  it('a uri-list is read the same way, comment lines skipped', () => {
    expect(uriListLinks('# copied\r\nhttps://a.example/x.png\r\nhttp://b.example/y.jpg')).toEqual(['https://a.example/x.png', 'http://b.example/y.jpg']);
    expect(uriListLinks('# only a comment')).toEqual([]);
    expect(uriListLinks('ftp://h.example/a.png')).toEqual([]);
  });

  it('a link that comes only as text/uri-list gets GM\'s links line too', async () => {
    await openStudio('board');
    const event = paste(clipboard({ uriList: '# from an app\r\nhttps://example.com/a.png' }));
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText(LINKS_NOT_ADDED)).toBeTruthy();
    expect(backend.apiFetch).not.toHaveBeenCalled();
  });
});

describe('an info line and an Undo toast (GM, #210 review answer 1)', () => {
  it('a nothing-to-add line never replaces a toast with Undo, and is still announced', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
    await openStudio('list');
    act(() => { (document.querySelector('.moodboard-tile__remove') as HTMLButtonElement).click(); });
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
    paste(clipboard({ text: 'words' }));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(document.querySelector('.board-undo-toast, [data-notice-slot="board"]')?.textContent ?? '').not.toContain(NOTHING_TO_PASTE);
    const spoken = Array.from(document.querySelectorAll('.moodboard-board__sr-only[role="status"]')).map((el) => el.textContent);
    expect(spoken).toContain(NOTHING_TO_PASTE);
    expect(screen.getAllByText(NOTHING_TO_PASTE).every((el) => el.classList.contains('moodboard-board__sr-only'))).toBe(true);
    raf.mockRestore();
  });

  it('with no action toast up, the line shows as the toast', async () => {
    await openStudio('list');
    paste(clipboard({ text: 'https://example.com/a.png' }));
    const shown = await screen.findByText(LINKS_NOT_ADDED);
    expect(shown.classList.contains('moodboard-board__sr-only')).toBe(false);
  });
});

describe('one physical press is one paste (GM, #210 review answer 2)', () => {
  it('a held Cmd+V\'s repeats add nothing; the key up resets it; Edit > Paste (no keydown) always adds', async () => {
    await openStudio('list');
    keyV('keydown');
    paste(clipboard({ files: [png('press.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['press.png']));
    keyV('keydown', { repeat: true });
    const repeat = paste(clipboard({ files: [png('repeat.png')] }));
    expect(repeat.defaultPrevented).toBe(true);
    keyV('keyup');
    // Edit > Paste: a paste event with no keydown before it.
    paste(clipboard({ files: [png('menu.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['press.png', 'menu.png']));
    // A new press (no repeat) adds again.
    keyV('keydown');
    paste(clipboard({ files: [png('again.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['press.png', 'menu.png', 'again.png']));
  });

  it('Ctrl+V repeats count too, and a repeat in a text field stays the field\'s', async () => {
    await openStudio('list');
    keyV('keydown', { ctrlKey: true, metaKey: false, repeat: true });
    expect(paste(clipboard({ files: [png('ctrl.png')] })).defaultPrevented).toBe(true);
    const field = screen.getByPlaceholderText(/Say what you want/);
    expect(paste(clipboard({ text: 'words' }), field).defaultPrevented).toBe(false);
    keyV('keyup', { key: 'Control' });
    paste(clipboard({ files: [png('after.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['after.png']));
  });

  it('the backstop: an identical file still uploading from the last paste is ignored; a different one goes', async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    backend.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => { await gate; return uploadResponse(path, init); });
    await openStudio('list');
    const same = () => new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'same.png', { type: 'image/png' });
    paste(clipboard({ files: [same()] }));
    await waitFor(() => expect(backend.apiFetch).toHaveBeenCalledTimes(1));
    // The same bytes again (a repeat the key events missed): ignored while it uploads.
    paste(clipboard({ files: [same()] }));
    // A different image goes through.
    paste(clipboard({ files: [png('other.png', 32)] }));
    await waitFor(() => expect(backend.apiFetch).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(backend.apiFetch).toHaveBeenCalledTimes(2);
    await act(async () => { open(); await gate; });
    await waitFor(() => expect(draftUrls()).toHaveLength(4));
    // Once it has uploaded, the same image pasted again is added again.
    paste(clipboard({ files: [same()] }));
    await waitFor(() => expect(backend.apiFetch).toHaveBeenCalledTimes(3));
  });
});

/** Uploads held until `open()`; `fail()` answers each held one with a refusal. */
function holdUploads() {
  let release: (ok: boolean) => void = () => {};
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  backend.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const ok = await gate;
    if (!ok) refuse = { status: 500, body: { detail: 'nope' } };
    return uploadResponse(path, init);
  });
  return { open: () => act(async () => { release(true); await gate; }), fail: () => act(async () => { release(false); await gate; }) };
}
const spokenLines = () => Array.from(document.querySelectorAll('.moodboard-board__sr-only[role="status"]')).map((el) => el.textContent);
const immediateFrames = () => vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });

describe('a placeholder holds the spot while the upload runs (GM r4 answer 1)', () => {
  it('lands at once where the view at paste time puts it; the upload fills it there, as one step', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    const at = { ...board.point! };
    const view = { ...board.view! };
    paste(clipboard({ files: [png('slow.png')] }));
    const occupied = [{ x: 0, y: 0, width: 480, height: 270 }, { x: 520, y: 0, width: 480, height: 270 }];
    const [w, h] = sizeFor(1, 1.5);
    const expected = placeTiles({ at, sizes: [[w, h]], occupied, view }).spots[0];
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    expect(board.placeholders[0]).toMatchObject({ ...expected, width: w, height: h });
    expect(server.edits).toHaveLength(0);
    // The person pans away meanwhile: the spot stays where it was chosen, with no chip.
    board.view = { x: 9000, y: 9000, width: 1000, height: 700 };
    board.point = { x: 9500, y: 9300 };
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(addOps()[0].at).toEqual(expected);
    // The spot stays, marked filled with the upload, until the board's spring has shown the image (GM r5).
    const spotId = board.placeholders[0]?.id;
    expect(board.placeholders).toEqual([expect.objectContaining({ id: spotId,
      filled: { imageId: addOps()[0].images[0].id, url: '/api/outputs/chat-uploads/slow.png' } })]);
    act(() => { board.filledDone!([spotId]); });
    expect(board.placeholders).toEqual([]);
    expect(board.outside).toBeNull();
    expect(server.edits).toHaveLength(1);
    const entry = Object.values(useAssetStudioDraftStore.getState().entries).find((e) => e.savedId === 'g1')!;
    const key = Object.keys(useAssetStudioDraftStore.getState().entries).find((k) => useAssetStudioDraftStore.getState().entries[k] === entry)!;
    expect(useBoardUndoStore.getState().history(key, entry.epoch).done).toHaveLength(1);
  });

  it('names the file it holds for (GM r5)', async () => {
    holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river-at-dusk.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    expect(board.placeholders[0].source).toEqual({ kind: 'file', name: 'river-at-dusk.png' });
  });

  it('a filled spot goes after 3 s even when no board ran its fade (List meanwhile)', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('slow.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await uploads.open();
      // Flush the upload's promises without moving the faked clock (vi.waitFor would advance it).
      for (let turn = 0; turn < 50 && !board.placeholders[0]?.filled; turn += 1) {
        await act(async () => { await Promise.resolve(); });
      }
      expect(board.placeholders[0]?.filled).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2999); });
      expect(board.placeholders).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(1); });
      expect(board.placeholders).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a later paste never takes a spot a placeholder holds', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('one.png', 16)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    paste(clipboard({ files: [png('two.png', 24)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(2));
    const [a, b] = board.placeholders;
    expect(a.x + a.width + 24 <= b.x || b.x + b.width + 24 <= a.x || a.y + a.height + 24 <= b.y || b.y + b.height + 24 <= a.y).toBe(true);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(2));
  });

  it('a failed upload takes its placeholder away, and the chip that pointed at it', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    board.view = { x: 0, y: 0, width: 1000, height: 270 };
    board.point = { x: 500, y: 135 };
    paste(clipboard({ files: [png('refused.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    // The chip shows at paste time, before the upload; its thumbnail comes with the upload.
    expect(board.outside?.rects).toEqual([{ x: board.placeholders[0].x, y: board.placeholders[0].y,
      width: board.placeholders[0].width, height: board.placeholders[0].height }]);
    expect(board.outside?.thumb).toBeNull();
    await uploads.fail();
    await waitFor(() => expect(board.placeholders).toEqual([]));
    expect(board.outside).toBeNull();
    expect(addOps()).toHaveLength(0);
  });

  it('the chip\'s thumbnail is the first file outside the view, not the first file', async () => {
    await openStudio('board');
    const [w, h] = sizeFor(1, 1.5);
    // Room in view for exactly one tile, under the two cards.
    board.view = { x: 0, y: 294, width: w, height: h };
    board.point = { x: w / 2, y: 294 + h / 2 };
    paste(clipboard({ files: [png('inside.png'), png('beyond.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(2));
    await waitFor(() => expect(board.outside?.thumb).toBe('/api/outputs/chat-uploads/beyond.png'));
    expect(board.outside!.rects).toHaveLength(1);
  });
});

describe('the chip goes', () => {
  const chipUp = async () => {
    board.view = { x: 0, y: 0, width: 1000, height: 270 };
    board.point = { x: 500, y: 135 };
    paste(clipboard({ files: [png('away.png')] }));
    await waitFor(() => expect(board.outside).not.toBeNull());
    await waitFor(() => expect(addOps()).toHaveLength(1));
  };

  it('when Add images or a drop adds files', async () => {
    await openStudio('board');
    await chipUp();
    act(() => { board.onDropFiles!([png('dropped.png')], { at: { x: 2000, y: 1500 }, view: { x: -1000, y: -1000, width: 4000, height: 3000 }, aim: true }); });
    expect(board.outside).toBeNull();
    // The drop's add lands before the next test (an add outlives its view).
    await waitFor(() => expect(addOps()).toHaveLength(2));
  });

  it('on any view switch, and stays gone back on the Board (GM r4 answer 8)', async () => {
    await openStudio('board');
    await chipUp();
    act(() => { useBoardCanvasStore.getState().setView('list'); });
    act(() => { useBoardCanvasStore.getState().setView('board'); });
    await screen.findByTestId('board-canvas');
    expect(board.outside).toBeNull();
  });

  it('on a board switch', async () => {
    await openStudio('board');
    await chipUp();
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    await screen.findByTestId('board-canvas');
    expect(board.outside).toBeNull();
  });
});

describe('a held key whose keyup went elsewhere (review 2, L1)', () => {
  const held = () => { keyV('keydown'); keyV('keydown', { repeat: true }); };
  it('the window losing focus clears it: Edit > Paste then adds', async () => {
    await openStudio('list');
    held();
    act(() => { window.dispatchEvent(new Event('blur')); });
    paste(clipboard({ files: [png('menu.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['menu.png']));
  });

  it('the page being hidden clears it', async () => {
    await openStudio('list');
    held();
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    paste(clipboard({ files: [png('back.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['back.png']));
  });

  it('any keydown that is not a repeat clears it (Cmd held, V pressed again: no V keyup on macOS)', async () => {
    await openStudio('list');
    held();
    press('Shift');
    paste(clipboard({ files: [png('next.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['next.png']));
  });

  it('a repeat of another key keeps it', async () => {
    await openStudio('list');
    held();
    press('Shift', { repeat: true });
    expect(paste(clipboard({ files: [png('still.png')] })).defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.uploads).toEqual([]);
  });

  it('with no key held, a repeat of another key blocks nothing', async () => {
    await openStudio('list');
    press('Shift', { repeat: true });
    paste(clipboard({ files: [png('free.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['free.png']));
  });

  it('the Cmd key up clears it', async () => {
    await openStudio('list');
    held();
    keyV('keyup', { key: 'Meta' });
    paste(clipboard({ files: [png('meta.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['meta.png']));
  });

  it('a non-Latin layout counts by the key\'s place (KeyV)', async () => {
    await openStudio('list');
    keyV('keydown', { key: 'м', code: 'KeyV', repeat: true });
    expect(paste(clipboard({ files: [png('cyr.png')] })).defaultPrevented).toBe(true);
    keyV('keyup', { key: 'м', code: 'KeyV' });
    paste(clipboard({ files: [png('cyr2.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['cyr2.png']));
  });
});

describe('the backstop takes turns (review 2, the race)', () => {
  const same = () => new File([new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2])], 'same.png', { type: 'image/png' });
  it('two quick presses of the same image add it once, and say so politely, with nothing on screen', async () => {
    const raf = immediateFrames();
    const uploads = holdUploads();
    await openStudio('list');
    // No await between them: the second is checked only after the first has claimed its file.
    paste(clipboard({ files: [same()] }));
    paste(clipboard({ files: [same()] }));
    await waitFor(() => expect(spokenLines()).toContain(ALREADY_BEING_ADDED));
    expect(screen.getAllByText(ALREADY_BEING_ADDED).every((el) => el.classList.contains('moodboard-board__sr-only'))).toBe(true);
    await uploads.open();
    await waitFor(() => expect(draftUrls()).toHaveLength(3));
    expect(server.uploads).toEqual(['same.png']);
    raf.mockRestore();
  });

  it('pastes take their turn: a slow hash never lets a later paste go first', async () => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let calls = 0;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      calls += 1;
      // The first paste's file hashes slowly.
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 40));
      return digest(algorithm as AlgorithmIdentifier, data as BufferSource);
    });
    await openStudio('board');
    paste(clipboard({ files: [png('first.png', 40)] }));
    paste(clipboard({ files: [png('second.png', 48)] }));
    await waitFor(() => expect(addOps()).toHaveLength(2));
    expect(server.uploads).toEqual(['first.png', 'second.png']);
    spy.mockRestore();
  });

  it('a failed upload lets the same image go again', async () => {
    const uploads = holdUploads();
    await openStudio('list');
    paste(clipboard({ files: [same()] }));
    await waitFor(() => expect(server.uploads).toHaveLength(0));
    await uploads.fail();
    await screen.findByText("Couldn't upload same.png.");
    refuse = null;
    backend.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => uploadResponse(path, init));
    paste(clipboard({ files: [same()] }));
    await waitFor(() => expect(draftUrls()).toHaveLength(3));
  });
});

describe('info lines in the toast slot', () => {
  it('a new info line replaces an info line (only an action toast keeps its place)', async () => {
    await openStudio('list');
    paste(clipboard({ text: 'words' }));
    await screen.findByText(NOTHING_TO_PASTE);
    paste(clipboard({ text: 'https://example.com/a.png' }));
    const shown = await screen.findByText(LINKS_NOT_ADDED);
    expect(shown.classList.contains('moodboard-board__sr-only')).toBe(false);
    expect(screen.queryAllByText(NOTHING_TO_PASTE).filter((el) => !el.classList.contains('moodboard-board__sr-only'))).toHaveLength(0);
  });

  it('"Undid…" never replaces a live "Removed · Undo" toast, unless it undid that removal (GM r4 answer 5)', async () => {
    const raf = immediateFrames();
    await openStudio('list');
    act(() => { (document.querySelector('.moodboard-tile__remove') as HTMLButtonElement).click(); });
    await screen.findByRole('button', { name: 'Undo' });
    await waitFor(() => expect(draftUrls()).toHaveLength(1));
    // Another step after the removal: a pasted file.
    paste(clipboard({ files: [png('later.png')] }));
    await waitFor(() => expect(draftUrls()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Uploading')).toBeNull());
    // Cmd+Z takes the paste back: the removal's toast stays, the line is announced.
    press('z', { metaKey: true });
    await waitFor(() => expect(spokenLines()).toContain('Undid: Added #2'));
    expect(screen.getByText('Removed #1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    // Cmd+Z again takes the removal back: its toast's offer is used up, so the line replaces it.
    press('z', { metaKey: true });
    await screen.findByText('Undid: Removed #1');
    expect(screen.queryByText('Removed #1')).toBeNull();
    raf.mockRestore();
  });

  it('the toast\'s own Undo replaces it with its "Undid…" line', async () => {
    await openStudio('list');
    act(() => { (document.querySelector('.moodboard-tile__remove') as HTMLButtonElement).click(); });
    act(() => { screen.getByRole('button', { name: 'Undo' }).click(); });
    await screen.findByText('Undid: Removed #1');
  });
});

/** Each upload held by file name until `settle(name, ok)`: one at a time, in any order. */
function holdEach() {
  const gates = new Map<string, (ok: boolean) => void>();
  backend.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const name = ((init?.body as FormData).get('file') as File).name;
    const ok = await new Promise<boolean>((resolve) => { gates.set(name, resolve); });
    if (!ok) return new Response(JSON.stringify({ detail: 'nope' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    return uploadResponse(path, init);
  });
  return {
    held: (name: string) => gates.has(name),
    settle: (name: string, ok: boolean) => act(async () => { gates.get(name)!(ok); await new Promise((resolve) => setTimeout(resolve, 0)); }),
  };
}
const keepsGap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x + a.width + 24 <= b.x || b.x + b.width + 24 <= a.x || a.y + a.height + 24 <= b.y || b.y + b.height + 24 <= a.y;
/** The board's own view with no room left in it: both cards fill it. */
const fullView = () => {
  board.view = { x: 0, y: 0, width: 1000, height: 270 };
  board.point = { x: 500, y: 135 };
};

describe('a held spot and a board that changes meanwhile (review 3)', () => {
  it('LOW-2: an Undo brings a tile back under the placeholder: the image takes the nearest free spot instead', async () => {
    await openStudio('list');
    act(() => { (document.querySelector('.moodboard-tile__remove') as HTMLButtonElement).click(); });
    await waitFor(() => expect(draftUrls()).toHaveLength(1));
    act(() => { useBoardCanvasStore.getState().setView('board'); });
    await screen.findByTestId('board-canvas');
    const uploads = holdUploads();
    // #1's old spot, now free: the placeholder takes it.
    board.point = { x: 240, y: 135 };
    paste(clipboard({ files: [png('fill.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const [w, h] = sizeFor(1, 1.5);
    const i1 = { x: 0, y: 0, width: 480, height: 270 };
    const i2 = { x: 520, y: 0, width: 480, height: 270 };
    expect(keepsGap({ ...board.placeholders[0], width: w, height: h }, i1)).toBe(false);
    press('z', { metaKey: true });
    await waitFor(() => expect(server.board.images.map((img) => img.id)).toContain('i1'));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const at = addOps()[0].at!;
    const expected = placeTiles({ at: { x: board.placeholders[0].x + w / 2, y: board.placeholders[0].y + h / 2 },
      sizes: [[w, h]], occupied: [i2, i1], view: board.view }).spots[0];
    expect(at).toEqual(expected);
    expect(keepsGap({ ...at, width: w, height: h }, i1)).toBe(true);
    expect(keepsGap({ ...at, width: w, height: h }, i2)).toBe(true);
    // Its placeholder moved with it, so the image fades in where it lands.
    expect(board.placeholders).toEqual([expect.objectContaining({ ...at,
      filled: { imageId: addOps()[0].images[0].id, url: '/api/outputs/chat-uploads/fill.png' } })]);
  });

  it('LOW-2: a spot the board left alone fills where it was held', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('still.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const held = { x: board.placeholders[0].x, y: board.placeholders[0].y };
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(addOps()[0].at).toEqual(held);
  });

  // Review 4 LOW-2: a moved spot never pushes a sibling off a spot the board left alone.
  it('LOW-2 (review 4): only the spot the board took moves; its sibling keeps the spot it held', async () => {
    await openStudio('list');
    act(() => { (document.querySelector('.moodboard-tile__remove') as HTMLButtonElement).click(); });
    await waitFor(() => expect(draftUrls()).toHaveLength(1));
    act(() => { useBoardCanvasStore.getState().setView('board'); });
    await screen.findByTestId('board-canvas');
    const uploads = holdUploads();
    board.point = { x: 240, y: 135 };
    paste(clipboard({ files: [png('first.png'), png('second.png', 20)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(2));
    const [w, h] = sizeFor(1, 1.5);
    const i1 = { x: 0, y: 0, width: 480, height: 270 };
    const i2 = { x: 520, y: 0, width: 480, height: 270 };
    const [first, second] = board.placeholders.map((holder) => ({ x: holder.x, y: holder.y, width: w, height: h }));
    expect(keepsGap(first, i1)).toBe(false);
    expect(keepsGap(second, i1)).toBe(true);
    press('z', { metaKey: true });
    await waitFor(() => expect(server.board.images.map((img) => img.id)).toContain('i1'));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(2));
    const [movedAt, keptAt] = addOps().map((op) => op.at!);
    expect(keptAt).toEqual({ x: second.x, y: second.y });
    const moved = { ...movedAt, width: w, height: h };
    for (const other of [i1, i2, second]) expect(keepsGap(moved, other)).toBe(true);
  });

  // Review 4 LOW-3: the chip follows a spot that moved.
  it('LOW-3 (review 4): a moved spot outside the view takes the chip with it', async () => {
    await openStudio('list');
    act(() => { (document.querySelector('.moodboard-tile__remove') as HTMLButtonElement).click(); });
    await waitFor(() => expect(draftUrls()).toHaveLength(1));
    act(() => { useBoardCanvasStore.getState().setView('board'); });
    await screen.findByTestId('board-canvas');
    const uploads = holdUploads();
    // A view too small for any tile: the file goes to #1's freed spot, outside it, with the chip.
    board.view = { x: 3000, y: 3000, width: 100, height: 100 };
    board.point = { x: 240, y: 135 };
    paste(clipboard({ files: [png('away.png')] }));
    await waitFor(() => expect(board.outside).not.toBeNull());
    const [w, h] = sizeFor(1, 1.5);
    const held = board.outside!.rects[0];
    expect(held).toMatchObject({ width: w, height: h });
    press('z', { metaKey: true });
    await waitFor(() => expect(server.board.images.map((img) => img.id)).toContain('i1'));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const at = addOps()[0].at!;
    expect(at).not.toEqual({ x: held.x, y: held.y });
    await waitFor(() => expect(board.outside?.rects).toEqual([{ ...at, width: w, height: h }]));
    expect(board.outside!.thumb).toBe('/api/outputs/chat-uploads/away.png');
  });
});

// Review 4 (X9-X11, X19, X21): how a spot the board took is moved. Tiles
// reach the board while the files upload (an agent's add, followed into the
// draft), walling off everything but a few free slots.
describe('moving a held spot the board took', () => {
  type Rect = { x: number; y: number; width: number; height: number };
  const G = 24;
  const [w, h] = sizeFor(1, 1.5);
  const slot = (x: number, y: number): Rect => ({ x, y, width: w, height: h });
  /** Rects covering a wide area except `slots` (each with the gap around it). */
  const around = (slots: Rect[]) => {
    const M = { x0: -20000, y0: -20000, x1: 20000, y1: 20000 };
    const holes = slots.map((r) => ({ x0: r.x - G, y0: r.y - G, x1: r.x + r.width + G, y1: r.y + r.height + G }));
    const ys = [...new Set([M.y0, M.y1, ...holes.flatMap((hole) => [hole.y0, hole.y1])])].sort((a, b) => a - b);
    const walls: Rect[] = [];
    for (let i = 0; i + 1 < ys.length; i += 1) {
      const [y0, y1] = [ys[i], ys[i + 1]];
      let x = M.x0;
      for (const hole of holes.filter((it) => it.y0 <= y0 && y1 <= it.y1).sort((a, b) => a.x0 - b.x0)) {
        if (hole.x0 > x) walls.push({ x, y: y0, width: hole.x0 - x, height: y1 - y0 });
        x = Math.max(x, hole.x1);
      }
      if (x < M.x1) walls.push({ x, y: y0, width: M.x1 - x, height: y1 - y0 });
    }
    return walls;
  };
  /** The tiles reach the board: into g1's draft, as a follow writes them. */
  const arrive = (rects: Rect[]) => act(() => {
    useAssetStudioDraftStore.setState((state) => {
      const key = Object.keys(state.entries).find((k) => state.entries[k].savedId === 'g1')!;
      const entry = state.entries[key];
      const draft = entry.draft as { images: MoodboardImage[] };
      const added = rects.map((r, i) => image(`wall${i}`, { placements: [{ ...card(`wall${i}`, r.x, r.y), w: r.width, h: r.height }] }));
      return { entries: { ...state.entries, [key]: { ...entry, draft: { ...draft, images: [...draft.images, ...added] } } } };
    });
  });
  const holdersNow = () => board.placeholders.map((holder) => slot(holder.x, holder.y));
  const landed = () => addOps().map((op) => slot(op.at!.x, op.at!.y));
  /** Two slots, one under the other, below both held spots: the upper one is nearest to each. */
  const twoSlotsFor = (a: Rect, b: Rect) => {
    expect(Math.max(a.y, b.y) + h + G).toBeLessThan(1000);
    return [slot(-900, 1000), slot(-900, 1000 + h + G)];
  };

  // GM r13: the chip only while less than half the tile is in view.
  it.each([
    ['a third in view: it takes the chip (mostly hidden there)', 3, true],
    ['half in view: no chip (the person sees it)', 2, false],
  ] as const)('an aimed drop moved by the board into the toolbar band, %s', async (_name, part, chip) => {
    const uploads = holdUploads();
    await openStudio('board');
    const view = { x: 0, y: 0, width: 2000, height: 1000 };
    act(() => { board.onDropFiles!([png('aimed.png')], { at: { x: 1000, y: 500 }, view, aim: true, band: true } as Parameters<NonNullable<typeof board.onDropFiles>>[1]); });
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    expect(board.outside).toBeNull();
    // The only slot left reaches past the view's bottom edge, into the band.
    const under = slot(500, 1000 - Math.round(h / part));
    arrive(around([under]));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(addOps()[0].at).toEqual({ x: under.x, y: under.y });
    if (chip) {
      await waitFor(() => expect(board.outside?.rects).toEqual([under]));
      // The chip made by the move carries the tile's image (review 9 lines-chip NIT-1).
      expect(board.outside?.thumb).toBe('/api/outputs/chat-uploads/aimed.png');
    } else {
      await new Promise((done) => setTimeout(done, 30));
      expect(board.outside).toBeNull();
    }
  });

  it('X9: two spots of one paste moved together never land on the same slot', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('one.png'), png('two.png', 20)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(2));
    const [a, b] = holdersNow();
    const slots = twoSlotsFor(a, b);
    arrive(around(slots));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(2));
    const [one, two] = landed();
    expect(keepsGap(one, two)).toBe(true);
    expect([one, two].map(({ x, y }) => `${x},${y}`).sort()).toEqual(slots.map(({ x, y }) => `${x},${y}`).sort());
  });

  it('X19: a file the server gave no image for holds no slot: the one that uploaded takes the nearest', async () => {
    // Each upload held by name; `false` answers with no image url.
    const gates = new Map<string, (withUrl: boolean) => void>();
    backend.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      const name = ((init?.body as FormData).get('file') as File).name;
      const withUrl = await new Promise<boolean>((resolve) => { gates.set(name, resolve); });
      if (!withUrl) return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return uploadResponse(path, init);
    });
    await openStudio('board');
    paste(clipboard({ files: [png('empty.png'), png('works.png', 20)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(2));
    const [failed, works] = holdersNow();
    const slots = twoSlotsFor(failed, works);
    const walls = around(slots);
    arrive(walls);
    await waitFor(() => expect(gates.size).toBe(2));
    await act(async () => { gates.get('empty.png')!(false); gates.get('works.png')!(true); await new Promise((done) => setTimeout(done, 0)); });
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const nearest = placeTiles({ at: { x: works.x + w / 2, y: works.y + h / 2 }, sizes: [[w, h]],
      occupied: [{ x: 0, y: 0, width: 480, height: 270 }, { x: 520, y: 0, width: 480, height: 270 }, ...walls], view: board.view }).spots[0];
    expect(addOps()[0].at).toEqual(nearest);
  });

  it('X21: a tile that came within the gap (not over the spot) moves it too', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('near.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const [held] = holdersNow();
    const close = { x: held.x + w + 5, y: held.y, width: 300, height: h };
    arrive([close]);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const [at] = landed();
    expect(at).not.toEqual(held);
    expect(keepsGap(at, close)).toBe(true);
  });

  it('X11: a moved spot counts another add\'s held spot, so it never lands on it', async () => {
    const files = holdEach();
    await openStudio('board');
    paste(clipboard({ files: [png('first.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    paste(clipboard({ files: [png('second.png', 20)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(2));
    const [a, b] = holdersNow();
    // Free: the first add's own spot, and one beyond it on the far side from the second.
    const beyond = b.x !== a.x ? slot(a.x - Math.sign(b.x - a.x) * (w + G), a.y) : slot(a.x, a.y - Math.sign(b.y - a.y) * (h + G));
    arrive(around([a, beyond]));
    await waitFor(() => expect(files.held('second.png')).toBe(true));
    await files.settle('second.png', true);
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const [moved] = landed();
    expect(moved).toEqual(beyond);
    expect(keepsGap(moved, a)).toBe(true);
    await files.settle('first.png', true);
    await waitFor(() => expect(addOps()).toHaveLength(2));
  });

  it('X10: a moved spot stays in the view the person pasted in when a slot there is free', async () => {
    const uploads = holdUploads();
    // Below the board's own cards, so the slot above the view is clear of them.
    board.view = { x: 0, y: 1000, width: 2000, height: 2000 };
    board.point = { x: 900, y: 1500 };
    await openStudio('board');
    paste(clipboard({ files: [png('stay.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const [held] = holdersNow();
    // Nearest free: just above the view. Farther, but in it: lower down.
    const above = slot(held.x, 1000 - h - 1);
    const inside = slot(held.x, 3000 - h - 1);
    expect(Math.abs(above.y - held.y)).toBeLessThan(Math.abs(inside.y - held.y));
    arrive(around([above, inside]));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(landed()[0]).toEqual(inside);
  });
});

// GM on review 4: an add whose person left the board while it uploaded is
// their paste. It finishes and lands on that board, placed as if they had
// stayed, written through the draft store, never to the board open now.
describe('an add that outlives its board', () => {
  const entryKey = (match: (key: string) => boolean) => Object.keys(useAssetStudioDraftStore.getState().entries).find(match)!;
  const imagesOf = (key: string) => ((useAssetStudioDraftStore.getState().entries[key]?.draft as { images?: MoodboardImage[] } | undefined)?.images ?? []);

  it('left for another board mid-upload: it lands on its own board at the spot it held; the open board gets nothing', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const held = { x: board.placeholders[0].x, y: board.placeholders[0].y };
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    await screen.findByTestId('board-canvas');
    expect(board.placeholders).toEqual([]);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    // An edit of g1 with no base version: it lands on the board as it is now.
    expect(api.editMoodboard).toHaveBeenCalledTimes(1);
    expect(api.editMoodboard.mock.calls[0][0]).toBe('g1');
    expect(api.editMoodboard.mock.calls[0][2]).toBeUndefined();
    expect(addOps()[0]).toMatchObject({ images: [{ url: '/api/outputs/chat-uploads/river.png' }], at: held });
    // g1's draft holds it now; the board open now holds nothing new.
    await waitFor(() => expect(draftUrls()).toContain('/api/outputs/chat-uploads/river.png'));
    expect(imagesOf(entryKey((key) => key.includes('"new"')))).toEqual([]);
    // Its spot waits, filled, for the person to come back to g1 (GM r8, review 5 LOW-3).
    expect(useBoardAddStore.getState().held).toEqual([expect.objectContaining({ away: true,
      filled: { imageId: addOps()[0].images[0].id, url: '/api/outputs/chat-uploads/river.png' } })]);
  });

  it('left Moodboard Studio altogether mid-upload: it still lands on its board', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const held = { x: board.placeholders[0].x, y: board.placeholders[0].y };
    act(() => { useUIStore.getState().exitMoodboardEditor(); });
    cleanup();
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(api.editMoodboard.mock.calls[0][0]).toBe('g1');
    expect(addOps()[0]).toMatchObject({ images: [{ url: '/api/outputs/chat-uploads/river.png' }], at: held });
    await waitFor(() => expect(draftUrls()).toContain('/api/outputs/chat-uploads/river.png'));
  });

  it('away and back mid-upload: its placeholder shows again, a new paste keeps clear of it, and both land as steps of the board', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('one.png', 16)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const first = { ...board.placeholders[0] };
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    await screen.findByTestId('board-canvas');
    expect(board.placeholders).toEqual([]);
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    await screen.findByDisplayValue('Global board');
    await screen.findByTestId('board-canvas');
    expect(board.placeholders).toEqual([expect.objectContaining({ id: first.id, x: first.x, y: first.y })]);
    paste(clipboard({ files: [png('two.png', 24)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(2));
    const second = board.placeholders[1];
    const [w, h] = sizeFor(1, 1.5);
    expect(keepsGap({ ...first, width: w, height: h }, { ...second, width: w, height: h })).toBe(true);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(2));
    expect(addOps().map((op) => op.at)).toEqual(expect.arrayContaining([{ x: first.x, y: first.y }, { x: second.x, y: second.y }]));
    const key = entryKey((k) => useAssetStudioDraftStore.getState().entries[k].savedId === 'g1');
    const entry = useAssetStudioDraftStore.getState().entries[key];
    await waitFor(() => expect(useBoardUndoStore.getState().history(key, entry.epoch).done).toHaveLength(2));
  });

  it('a board not saved yet, left mid-upload: the add waits in its draft at the spot it held, saved with it', async () => {
    const uploads = holdUploads();
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await screen.findByTestId('board-canvas');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const held = { x: board.placeholders[0].x, y: board.placeholders[0].y };
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    await screen.findByDisplayValue('Global board');
    await uploads.open();
    const newKey = entryKey((key) => key.includes('"new"'));
    await waitFor(() => expect(imagesOf(newKey).map((img) => img.url)).toEqual(['/api/outputs/chat-uploads/river.png']));
    expect(imagesOf(newKey)[0].placements?.[0]).toMatchObject(held);
    expect(useAssetStudioDraftStore.getState().entries[newKey].dirty).toBe(true);
    // Nothing reached g1, the board open now.
    expect(addOps()).toHaveLength(0);
    expect(draftUrls()).not.toContain('/api/outputs/chat-uploads/river.png');
  });

  it('a failure while away is the board\'s own line, shown when the person is back on it', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    await uploads.fail();
    const key = entryKey((k) => useAssetStudioDraftStore.getState().entries[k].savedId === 'g1');
    await waitFor(() => expect(useAssetStudioDraftStore.getState().entries[key].saveError).toBeTruthy());
    const other = entryKey((k) => k.includes('"new"'));
    expect(useAssetStudioDraftStore.getState().entries[other].saveError).toBeNull();
    expect(useBoardAddStore.getState().held).toEqual([]);
  });
});

// GM (round 5 carry-over): Add images stays live during uploads, with no
// toolbar status; concurrent adds go through placement and the backstop.
describe('adds at once', () => {
  it('a paste and a drop while it uploads hold spots clear of each other, and both land there', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('a.png', 16)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => { board.onDropFiles!([png('b.png', 20)], { at: { ...board.point! }, view: board.view, aim: false }); });
    await waitFor(() => expect(board.placeholders).toHaveLength(2));
    const [w, h] = sizeFor(1, 1.5);
    const [a, b] = board.placeholders.map((holder) => ({ x: holder.x, y: holder.y, width: w, height: h }));
    expect(keepsGap(a, b)).toBe(true);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(2));
    expect(addOps().map((op) => op.at)).toEqual([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
  });

  it('the same file again through Add images while its paste uploads is caught by the backstop', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('a.png', 16)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => { board.onDropFiles!([png('a.png', 16)], { at: { ...board.point! }, view: board.view, aim: false }); });
    await waitFor(() => expect(spokenLines()).toContain(ALREADY_BEING_ADDED));
    expect(board.placeholders).toHaveLength(1);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(server.uploads).toEqual(['a.png']);
  });

  it('in the List: Add Images stays live with no "Uploading", and each file is an uploading row of its own', async () => {
    const uploads = holdUploads();
    await openStudio('list');
    paste(clipboard({ files: [png('river-at-dusk.png'), png('two.png', 20)] }));
    const rows = await screen.findAllByRole('status', { name: /uploading$/ });
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['river-at-dusk.png, uploading', 'two.png, uploading']);
    expect(rows.every((row) => row.getAttribute('aria-busy') === 'true' && row.classList.contains('moodboard-tile--uploading'))).toBe(true);
    expect(rows[0].querySelector('.moodboard-tile__upload-name')!.textContent).toBe('river-at-dusk.png');
    const input = screen.getByLabelText('Add Images') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(document.querySelector('.moodboard-dropzone__file-button')!.textContent).toBe('Add Images');
    expect(document.querySelector('.moodboard-dropzone--busy')).toBeNull();
    await uploads.open();
    await waitFor(() => expect(screen.queryAllByRole('status', { name: /uploading$/ })).toHaveLength(0));
    await waitFor(() => expect(draftUrls()).toHaveLength(4));
  });

  it('a Board paste shows as an uploading row in the List too', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => { useBoardCanvasStore.getState().setView('list'); });
    expect(await screen.findByRole('status', { name: 'river.png, uploading' })).toBeTruthy();
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
  });
});

describe('review 3 test gaps', () => {
  it('an upload refused before the image\'s shape is read is handled: its line, no placeholder, nothing added', async () => {
    let open: () => void = () => {};
    aspectGate.wait = new Promise<void>((resolve) => { open = resolve; });
    refuse = { status: 500, body: { detail: 'nope' } };
    await openStudio('board');
    paste(clipboard({ files: [png('early.png')] }));
    await waitFor(() => expect(server.uploads).toEqual(['early.png']));
    // The refusal has come back; the shape read is still out.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => { open(); await Promise.resolve(); });
    await screen.findByText("Couldn't upload early.png.");
    expect(board.placeholders).toEqual([]);
    expect(addOps()).toHaveLength(0);
  });

  it('a paste with one file already on its way and one new says so, and adds the new one', async () => {
    const raf = immediateFrames();
    const uploads = holdUploads();
    await openStudio('list');
    const same = () => new File([new Uint8Array([4, 4, 4, 4, 4, 4, 4, 4])], 'same.png', { type: 'image/png' });
    paste(clipboard({ files: [same()] }));
    await waitFor(() => expect(backend.apiFetch).toHaveBeenCalledTimes(1));
    paste(clipboard({ files: [same(), png('fresh.png', 40)] }));
    await waitFor(() => expect(spokenLines()).toContain(ALREADY_BEING_ADDED));
    await waitFor(() => expect(backend.apiFetch).toHaveBeenCalledTimes(2));
    await uploads.open();
    await waitFor(() => expect(draftUrls()).toHaveLength(4));
    expect(server.uploads.sort()).toEqual(['fresh.png', 'same.png']);
    raf.mockRestore();
  });

  it('another board\'s "Removed · Undo" toast never holds this board\'s line back', async () => {
    await openStudio('list');
    act(() => { (document.querySelector('.moodboard-tile__remove') as HTMLButtonElement).click(); });
    await screen.findByRole('button', { name: 'Undo' });
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
    paste(clipboard({ text: 'words' }));
    const shown = await screen.findAllByText(NOTHING_TO_PASTE);
    expect(shown.some((el) => !el.classList.contains('moodboard-board__sr-only'))).toBe(true);
  });

  it('once the removal\'s toast is dismissed, a later "Undid…" shows on screen', async () => {
    const raf = immediateFrames();
    await openStudio('list');
    act(() => { (document.querySelector('.moodboard-tile__remove') as HTMLButtonElement).click(); });
    const undo = await screen.findByRole('button', { name: 'Undo' });
    act(() => { undo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
    paste(clipboard({ files: [png('later.png')] }));
    await waitFor(() => expect(draftUrls()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Uploading')).toBeNull());
    press('z', { metaKey: true });
    const lines = await screen.findAllByText('Undid: Added #2');
    expect(lines.some((el) => !el.classList.contains('moodboard-board__sr-only'))).toBe(true);
    raf.mockRestore();
  });

  it('an earlier add\'s thumbnail never lands on a later add\'s chip', async () => {
    const uploads = holdEach();
    await openStudio('board');
    fullView();
    paste(clipboard({ files: [png('first.png', 16)] }));
    await waitFor(() => expect(uploads.held('first.png')).toBe(true));
    await waitFor(() => expect(board.outside).not.toBeNull());
    const firstChip = board.outside!.id;
    paste(clipboard({ files: [png('second.png', 24)] }));
    await waitFor(() => expect(uploads.held('second.png')).toBe(true));
    await waitFor(() => expect(board.outside?.id).not.toBe(firstChip));
    await waitFor(() => expect(board.outside).not.toBeNull());
    await uploads.settle('first.png', true);
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(board.outside?.thumb).toBeNull();
    await uploads.settle('second.png', true);
    await waitFor(() => expect(board.outside?.thumb).toBe('/api/outputs/chat-uploads/second.png'));
  });

  it('an earlier add\'s failure never takes a later add\'s chip away', async () => {
    const uploads = holdEach();
    await openStudio('board');
    fullView();
    paste(clipboard({ files: [png('first.png', 16)] }));
    await waitFor(() => expect(uploads.held('first.png')).toBe(true));
    await waitFor(() => expect(board.outside).not.toBeNull());
    const firstChip = board.outside!.id;
    paste(clipboard({ files: [png('second.png', 24)] }));
    await waitFor(() => expect(uploads.held('second.png')).toBe(true));
    await waitFor(() => expect(board.outside?.id).not.toBe(firstChip));
    await waitFor(() => expect(board.outside).not.toBeNull());
    const secondChip = board.outside!.id;
    await uploads.settle('first.png', false);
    await screen.findByText("Couldn't upload first.png.");
    expect(board.outside?.id).toBe(secondChip);
    await uploads.settle('second.png', true);
    await waitFor(() => expect(addOps()).toHaveLength(1));
  });
});

// Review 5 and GM r8: a board is its draft instance, not its draft key, and a
// paste the person made is never lost silently.
describe('an add and the board it belongs to (review 5, GM r8)', () => {
  const store = () => useAssetStudioDraftStore.getState();
  const newKey = JSON.stringify(['moodboard', 'global', 'new']);
  const madeKey = JSON.stringify(['moodboard', 'global', 'made1']);
  const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
  const urlsOf = (key: string) => ((store().entries[key]?.draft as { images?: MoodboardImage[] } | undefined)?.images ?? []).map((img) => img.url);
  const river = '/api/outputs/chat-uploads/river.png';
  /** A server that also creates boards: the first create is made1, whose edits are kept apart from g1's. */
  const madeServer = () => {
    const made = { board: null as Moodboard | null, edits: [] as MoodboardOp[][] };
    api.createMoodboard.mockImplementation(async (body: Partial<Moodboard>) => {
      made.board = { ...clone(server.board), id: 'made1', name: body.name ?? '', version: 1, projectId: undefined, thumbnail: '',
        images: (body.images ?? []).map((img) => image(img.id, { url: img.url, placements: img.placements ?? [card(img.id)] })) } as Moodboard;
      return clone(made.board);
    });
    const g1Edit = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementation(async (id: string, ops: MoodboardOp[], base?: number) => {
      if (id !== 'made1') return g1Edit(id, ops, base);
      made.edits.push(ops);
      for (const op of ops) {
        if (op.op === 'add') made.board!.images = [...made.board!.images, ...op.images.map((img) => image(img.id!, { url: img.url,
          placements: 'at' in op && op.at ? [card(img.id!, op.at.x, op.at.y)] : [card(img.id!)] }))];
      }
      made.board = { ...made.board!, version: made.board!.version + 1 };
      return { board: clone(made.board), version: made.board.version, applied: [], undo: { ops: [] } };
    });
    api.fetchMoodboard.mockImplementation(async (id: string) => (id === 'made1' ? clone(made.board) : id === server.board.id ? clone(server.board) : null));
    return made;
  };
  const openNew = async () => {
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await screen.findByTestId('board-canvas');
    await waitFor(() => expect(store().entries[newKey]?.loaded).toBe(true));
  };
  const toBoard = async (id: string) => {
    act(() => { useUIStore.getState().enterMoodboardEditor(id, 'global'); });
    await screen.findByTestId('board-canvas');
  };

  it('R5-A: an unsaved draft discarded mid-upload: nothing shows or lands on the fresh draft at that key, and nothing is created', async () => {
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const epoch = store().entries[newKey].epoch;
    act(() => {
      store().reset(newKey, { name: '', notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
      useUIStore.getState().enterMoodboardEditor('new', 'global');
    });
    await waitFor(() => expect(store().entries[newKey].loaded).toBe(true));
    expect(store().entries[newKey].epoch).toBe(epoch + 1);
    expect(board.placeholders).toEqual([]);
    await uploads.open();
    await new Promise((done) => setTimeout(done, 30));
    expect(urlsOf(newKey)).toEqual([]);
    expect(api.createMoodboard).not.toHaveBeenCalled();
    expect(useBoardAddStore.getState().held).toEqual([]);
  });

  it('R5-E: a new board saved mid-upload, then New: the add reaches the saved board, not the fresh one', async () => {
    const made = madeServer();
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    // What persist does when the first save lands: the entry moves to the saved key, the Studio follows it.
    act(() => {
      store().patch(newKey, { savedId: 'made1', saveState: 'saved' });
      store().copyTo(newKey, madeKey);
      useUIStore.getState().enterMoodboardEditor('made1', 'global');
    });
    await screen.findByTestId('board-canvas');
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => {
      store().reset(newKey, { name: '', notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
      useUIStore.getState().enterMoodboardEditor('new', 'global');
    });
    await waitFor(() => expect(store().entries[newKey].loaded).toBe(true));
    expect(board.placeholders).toEqual([]);
    made.board = { ...clone(server.board), id: 'made1', images: [], version: 1 } as Moodboard;
    await uploads.open();
    await waitFor(() => expect(made.edits).toHaveLength(1));
    expect(made.edits[0]).toEqual([expect.objectContaining({ op: 'add', images: [expect.objectContaining({ url: river })] })]);
    expect(urlsOf(newKey)).toEqual([]);
  });

  it('New with an add in flight saves the unsaved board first; the add lands there, the fresh board stays empty', async () => {
    const made = madeServer();
    const uploads = holdUploads();
    await openNew();
    act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: '' })); });
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => { screen.getByRole('button', { name: '+ New Moodboard' }).click(); });
    // Saved under the default name (it had none), so it shows in the rail.
    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalledTimes(1));
    expect(api.createMoodboard.mock.calls[0][0]).toMatchObject({ name: 'Untitled Moodboard' });
    await waitFor(() => expect(store().entries[madeKey]?.savedId).toBe('made1'));
    await waitFor(() => expect(store().entries[newKey]?.epoch).toBeGreaterThan(0));
    await waitFor(() => expect(store().entries[newKey].loaded).toBe(true));
    expect(board.placeholders).toEqual([]);
    await uploads.open();
    await waitFor(() => expect(made.edits).toHaveLength(1));
    expect(made.edits[0][0]).toMatchObject({ op: 'add', images: [expect.objectContaining({ url: river })] });
    expect(urlsOf(newKey)).toEqual([]);
  });

  it('MEDIUM-2: an unsaved board left mid-upload is saved when its add lands, shows in the rail, and survives the next New', async () => {
    madeServer();
    api.fetchMoodboards.mockImplementation(async (scope: string) => (scope === 'global'
      ? [clone(server.board), ...(api.createMoodboard.mock.results.length ? [await api.createMoodboard.mock.results[0].value] : [])] : []));
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('g1');
    await uploads.open();
    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalledTimes(1));
    // The add went in the board's first save (review 5, M8).
    expect(api.createMoodboard.mock.calls[0][0].images.map((img: MoodboardImage) => img.url)).toEqual([river]);
    await waitFor(() => expect(store().entries[madeKey]?.savedId).toBe('made1'));
    expect(urlsOf(madeKey)).toEqual([river]);
    act(() => { screen.getByRole('button', { name: '+ New Moodboard' }).click(); });
    await waitFor(() => expect(store().entries[newKey]?.loaded).toBe(true));
    expect(urlsOf(newKey)).toEqual([]);
    expect(urlsOf(madeKey)).toEqual([river]);
    await waitFor(() => expect(document.querySelectorAll('.moodboard-rail__name').length).toBe(2));
    expect(api.createMoodboard).toHaveBeenCalledTimes(1);
  });

  it('delete: a board deleted mid-upload cancels its add silently', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    // What deleteBoard does once the board is in the trash.
    act(() => {
      store().reset(g1Key, { name: 'Untitled Moodboard', notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
      store().reset(newKey, { name: 'Untitled Moodboard', notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
      useUIStore.getState().enterMoodboardEditor('new', 'global');
    });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    expect(board.placeholders).toEqual([]);
    const trashed = Object.assign(new Error("Couldn't save the board."), { status: 404 });
    api.editMoodboard.mockRejectedValue(trashed);
    await uploads.open();
    await waitFor(() => expect(api.editMoodboard).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 30));
    expect(useBoardAddStore.getState().held).toEqual([]);
    expect(store().entries[newKey].saveError).toBeNull();
    expect(store().entries[g1Key].saveError ?? null).toBeNull();
    expect(urlsOf(newKey)).toEqual([]);
  });

  it('delete undone before the upload finishes: the add carries on and lands on the restored board', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const held = { x: board.placeholders[0].x, y: board.placeholders[0].y };
    act(() => {
      store().reset(g1Key, { name: 'Untitled Moodboard', notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
      store().reset(newKey, { name: 'Untitled Moodboard', notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
      useUIStore.getState().enterMoodboardEditor('new', 'global');
    });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    // Undo: the board is restored with its id, and opened again (openRestored).
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(addOps()[0]).toMatchObject({ images: [{ url: river }], at: held });
    expect(api.editMoodboard.mock.calls[0][0]).toBe('g1');
  });

  it('M18: an add landing while its board is still loading goes to the server, not into the loading draft', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => {
      store().reset(g1Key, { name: 'Untitled Moodboard', notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
      useUIStore.getState().enterMoodboardEditor('new', 'global');
    });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    // Back on g1, whose read is held: the board is loading when the upload lands.
    let read: () => void = () => {};
    const gate = new Promise<void>((done) => { read = done; });
    let reads = 0;
    api.fetchMoodboard.mockImplementation(async (id: string) => {
      // The Studio's own read waits; the add's own read of the board (LOW-5) doesn't.
      if (reads++ === 0) await gate;
      return id === server.board.id ? clone(server.board) : null;
    });
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    await waitFor(() => expect(api.fetchMoodboard).toHaveBeenCalled());
    expect(store().entries[g1Key].loaded).toBe(false);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(api.editMoodboard.mock.calls[0][2]).toBeUndefined();
    // The loading draft took nothing (its load would overwrite it): no step, nothing queued.
    expect(urlsOf(g1Key)).toEqual([]);
    expect((store().entries[g1Key].draft as { pendingOps?: MoodboardOp[] }).pendingOps ?? []).toEqual([]);
    expect(useBoardUndoStore.getState().histories[g1Key]?.done ?? []).toEqual([]);
    await act(async () => { read(); await gate; });
    await screen.findByDisplayValue('Global board');
    await waitFor(() => expect(urlsOf(g1Key).filter((url) => url === river)).toHaveLength(1));
  });

  it('M17: a Studio still drawn but no longer current takes no step; the add lands on its board through the server', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const held = { x: board.placeholders[0].x, y: board.placeholders[0].y };
    // The person left the Studio; this one hasn't unmounted yet, so its board is still registered as open.
    act(() => { useUIStore.setState({ viewMode: 'canvas' }); });
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    // The away write (no base version), at the spot it held: not a step of a Studio that isn't current.
    expect(api.editMoodboard.mock.calls[0][0]).toBe('g1');
    expect(api.editMoodboard.mock.calls[0][2]).toBeUndefined();
    expect(addOps()[0]).toMatchObject({ images: [{ url: '/api/outputs/chat-uploads/river.png' }], at: held });
    expect(useBoardUndoStore.getState().histories[g1Key]?.done ?? []).toEqual([]);
  });

  it('GM 3: the same image on another board goes; on the same board, after the Studio closed and opened again, it is caught', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => { useUIStore.getState().exitMoodboardEditor(); });
    cleanup();
    await openStudio('board');
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(spokenLines()).toContain(ALREADY_BEING_ADDED));
    expect(board.placeholders).toHaveLength(1);
    await toBoard('new');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(server.uploads).toEqual(['river.png', 'river.png']));
  });

  it('GM 5: a reload mid-upload is said once on the board\'s next open; an add on its way is recorded until it lands', async () => {
    window.sessionStorage.setItem('nebula:moodboard-adds-in-flight', JSON.stringify([
      { id: 'placeholder-9', board: 'g1', name: 'river.png', page: 'an earlier page', at: Date.now() },
      { id: 'placeholder-10', board: 'g1', name: 'lake.png', page: 'an earlier page', at: Date.now() },
      { id: 'placeholder-11', board: 'other', name: 'sea.png', page: 'an earlier page', at: Date.now() }]));
    const uploads = holdUploads();
    await openStudio('board');
    await screen.findByText('“river.png” and “lake.png” weren’t added because the page reloaded while they uploaded. Paste them again.');
    paste(clipboard({ files: [png('now.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const kept = () => JSON.parse(window.sessionStorage.getItem('nebula:moodboard-adds-in-flight') ?? '[]') as Array<{ name: string; board: string }>;
    expect(kept().map((it) => `${it.board}:${it.name}`)).toEqual(['other:sea.png', 'g1:now.png']);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    await waitFor(() => expect(kept().map((it) => it.name)).toEqual(['sea.png']));
    window.sessionStorage.removeItem('nebula:moodboard-adds-in-flight');
  });

  it('GM 5: a reload cuts the upload short and the browser runs its failure on the way out: the record stays for the next load', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const kept = () => JSON.parse(window.sessionStorage.getItem('nebula:moodboard-adds-in-flight') ?? '[]') as Array<{ name: string }>;
    try {
      window.dispatchEvent(new Event('pagehide'));
      await uploads.fail();
      await new Promise((done) => setTimeout(done, 30));
      expect(kept().map((it) => it.name)).toEqual(['river.png']);
    } finally {
      window.dispatchEvent(new Event('pageshow'));
      window.sessionStorage.removeItem('nebula:moodboard-adds-in-flight');
    }
  });

  it('GM 5\'s line: one file or two or three named, from four a count', () => {
    expect(reloadLostLine(['river.png'])).toBe('“river.png” wasn’t added because the page reloaded while it uploaded. Paste it again.');
    expect(reloadLostLine(['a.png', 'b.png'])).toBe('“a.png” and “b.png” weren’t added because the page reloaded while they uploaded. Paste them again.');
    expect(reloadLostLine(['a.png', 'b.png', 'c.png']))
      .toBe('“a.png”, “b.png” and “c.png” weren’t added because the page reloaded while they uploaded. Paste them again.');
    expect(reloadLostLine(['a', 'b', 'c', 'd'])).toBe('4 images weren’t added because the page reloaded while they uploaded. Paste them again.');
  });

  it('LOW-3: back on a board an add landed on while away, it fades in over its spot, with the chip when outside the view', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const spot = board.placeholders[0];
    await toBoard('new');
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    board.view = { x: 5000, y: 5000, width: 400, height: 300 };
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    await waitFor(() => expect(board.placeholders).toEqual([expect.objectContaining({ id: spot.id, away: false,
      filled: { imageId: addOps()[0].images[0].id, url: river } })]));
    await waitFor(() => expect(board.outside?.rects).toEqual([{ x: spot.x, y: spot.y, width: spot.width, height: spot.height }]));
    expect(board.outside!.thumb).toBe(river);
    // The fade's end (the board's) lets the spot go.
    act(() => { board.filledDone!([spot.id]); });
    await waitFor(() => expect(board.placeholders).toEqual([]));
  });

  // GM r13: the chip only while less than half the tile is in view, here too.
  it.each([[0.49, true], [0.5, false]] as const)('back on the board, its spot %s in view: chip %s', async (inView, chip) => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const spot = board.placeholders[0];
    await toBoard('new');
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    // The view's left edge cuts the spot, leaving `inView` of its width in view.
    board.view = { x: spot.x + spot.width * (1 - inView), y: spot.y - 1000, width: 4000, height: 3000 };
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    await waitFor(() => expect(board.placeholders).toEqual([expect.objectContaining({ id: spot.id, away: false })]));
    if (chip) await waitFor(() => expect(board.outside?.rects).toEqual([{ x: spot.x, y: spot.y, width: spot.width, height: spot.height }]));
    else {
      await new Promise((done) => setTimeout(done, 40));
      expect(board.outside).toBeNull();
    }
  });

  // Round 6f (GM r14): "in view" leaves out what the notice band covers, the chip's own floor.
  it('back on the board, its spot in the view but under the notice band: chip', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const spot = board.placeholders[0];
    await toBoard('new');
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    // The whole view holds the spot; what of it is seen stops above it.
    board.view = { x: spot.x - 500, y: spot.y - 500, width: 2000, height: 1500 };
    board.seen = { ...board.view, height: 500 };
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    await waitFor(() => expect(board.placeholders).toEqual([expect.objectContaining({ id: spot.id, away: false })]));
    await waitFor(() => expect(board.outside?.rects).toEqual([{ x: spot.x, y: spot.y, width: spot.width, height: spot.height }]));
  });

  it('LOW-3: a landing the board\'s draft couldn\'t take (edits unsent) is read again on return; the draft keeps its own edit', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    act(() => { store().patch(g1Key, { dirty: true }); });
    const before = urlsOf(g1Key);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(urlsOf(g1Key)).toEqual(before);
    api.fetchMoodboard.mockClear();
    await toBoard('g1');
    await waitFor(() => expect(api.fetchMoodboard).toHaveBeenCalledWith('g1'));
  });

  it('LOW-4: a failed write while away keeps the image in the board\'s draft and says the save failed', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    api.editMoodboard.mockRejectedValue(Object.assign(new Error('offline'), { status: 0 }));
    await uploads.open();
    await waitFor(() => expect(store().entries[g1Key].saveError).toBeTruthy());
    // Nothing is lost (the image stays in the draft): the neutral save line (round 6f, GM r14).
    expect(store().entries[g1Key].saveError).toEqual({ heading: '', reason: 'Nebula couldn’t save the board because the server didn’t accept this save. Try again.' });
    expect(store().entries[g1Key].retry).toBe('save');
    expect(urlsOf(g1Key)).toContain(river);
    expect(((store().entries[g1Key].draft as { pendingOps?: MoodboardOp[] }).pendingOps ?? []).some((op) => op.op === 'add')).toBe(true);
  });

  it('a failed write while away, signed out: its line says Reload and the board offers no Retry (GM r16 7a)', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    api.editMoodboard.mockRejectedValue(new RequestFailedError("Couldn't save the board.", 403, { detail: 'Not yours', code: 'person_required' }));
    await uploads.open();
    await waitFor(() => expect(store().entries[g1Key].saveError).toBeTruthy());
    expect(store().entries[g1Key]).toMatchObject({ retry: 'reload',
      saveError: { heading: '', reason: 'Nebula couldn’t save the board because you’re signed out. Open the link Nebula printed when it started.' } });
    expect(urlsOf(g1Key)).toContain(river);
  });

  it('a failed write while away for a saved board whose draft isn\'t loaded: the add is in no draft, so GM r16\'s red line naming it, no Retry (review 9 NIT-2)', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    // Its draft let go of the board (as a draft not loaded yet holds it).
    act(() => { store().patch(g1Key, { loaded: false }); });
    api.editMoodboard.mockRejectedValue(new RequestFailedError("Couldn't save the board.", 500, { reason: 'boom' }));
    await uploads.open();
    await waitFor(() => expect(store().entries[g1Key].saveError).toBeTruthy());
    expect(store().entries[g1Key]).toMatchObject({ retry: null,
      saveError: { heading: '', reason: 'Nebula couldn’t add “river.png” because the board hadn’t loaded. Add it again.' } });
    // The board saved fine: only the add was lost, so its state isn't an error (GM r17).
    expect(store().entries[g1Key].saveState).not.toBe('error');
    expect(urlsOf(g1Key)).not.toContain(river);
    // The person sees it when they open the board: its load keeps the red line, with no Retry (round 6h, live).
    await toBoard('g1');
    const line = await screen.findByText('Nebula couldn’t add “river.png” because the board hadn’t loaded. Add it again.');
    expect(line.closest('.moodboard-studio__notice')!.className).toContain('moodboard-studio__notice--error');
    expect(store().entries[g1Key]).toMatchObject({ loaded: true, saveState: 'saved', retry: null });
    // The chip stays "Saved"; the red line carries the loss (GM r17).
    expect(document.querySelector('.moodboard-studio-toolbar__state')!.textContent).toBe('Saved');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('LOW-5: away, the spot check reads the board from the server, so a tile added meanwhile moves the add off it', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const spot = board.placeholders[0];
    await toBoard('new');
    // Someone else's tile lands on the spot, on the server only.
    server.board = { ...server.board, version: server.board.version + 1,
      images: [...server.board.images, image('x9', { placements: [{ ...card('x9', spot.x, spot.y), w: spot.width, h: spot.height }] })] };
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const at = addOps()[0].at!;
    expect(keepsGap({ ...at, width: spot.width, height: spot.height }, { x: spot.x, y: spot.y, width: spot.width, height: spot.height })).toBe(true);
  });
  it('A save of the board out when an away add lands: the draft isn\'t written mid-save, and takes the board once the save ends behind it', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    // A save of g1 still out from the visit the person left.
    let attempt: ReturnType<ReturnType<typeof store>['beginSave']> = null;
    act(() => { attempt = store().beginSave(g1Key); });
    expect(attempt).not.toBeNull();
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 30));
    expect(urlsOf(g1Key)).not.toContain(river);
    // The save ends on a version before the add's: the draft takes the board with the add.
    act(() => { store().finishSave(g1Key, attempt!.id, attempt!.revision, 'g1', ''); });
    await waitFor(() => expect(urlsOf(g1Key)).toContain(river));
  });

  it('an away landing never takes a draft back to an older board: a draft already past the add\'s version keeps its own', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    // The draft followed a later version meanwhile (someone else's save, read through the socket).
    act(() => { store().edit(g1Key, (draft) => ({ ...(draft as object), version: 50 })); store().patch(g1Key, { dirty: false }); });
    const before = urlsOf(g1Key);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 30));
    expect((store().entries[g1Key].draft as { version?: number }).version).toBe(50);
    expect(urlsOf(g1Key)).toEqual(before);
  });

  it('a board deleted by someone else while the person is away: its add is cancelled silently, its draft untouched', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    const before = urlsOf(g1Key);
    api.editMoodboard.mockRejectedValue(Object.assign(new Error("Couldn't save the board."), { status: 404 }));
    await uploads.open();
    await waitFor(() => expect(api.editMoodboard).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 30));
    expect(store().entries[g1Key].saveError ?? null).toBeNull();
    expect(urlsOf(g1Key)).toEqual(before);
    expect(useBoardAddStore.getState().held).toEqual([]);
  });

  it('an upload that fails after its unsaved draft was discarded says nothing on the fresh draft at that key', async () => {
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => {
      store().reset(newKey, { name: '', notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
      useUIStore.getState().enterMoodboardEditor('new', 'global');
    });
    await waitFor(() => expect(store().entries[newKey].loaded).toBe(true));
    await uploads.fail();
    await new Promise((done) => setTimeout(done, 30));
    expect(store().entries[newKey].saveError ?? null).toBeNull();
  });

  it('New when saving the unsaved board fails: the board stays open with its line, and its add still lands there', async () => {
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const epoch = store().entries[newKey].epoch;
    api.createMoodboard.mockRejectedValue(Object.assign(new Error('offline'), { status: 0 }));
    act(() => { screen.getByRole('button', { name: '+ New Moodboard' }).click(); });
    await waitFor(() => expect(store().entries[newKey].saveError).toBeTruthy());
    expect(store().entries[newKey].epoch).toBe(epoch);
    expect(board.placeholders).toHaveLength(1);
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toContain(river));
  });

  it('a delete with an unsaved board that has content saves that board first, as New does', async () => {
    const made = madeServer();
    removeAsset.fn = async () => true;
    await openStudio('board');
    act(() => {
      store().reset(newKey, { name: 'Kept', notes: '', mode: 'look', strength: 0.7, analysis: null,
        images: [image('k1', { url: '/api/outputs/kept.png', placements: [card('k1')] })] });
      store().patch(newKey, { loaded: true });
    });
    act(() => { screen.getByRole('button', { name: 'Delete' }).click(); });
    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalledTimes(1));
    expect(api.createMoodboard.mock.calls[0][0]).toMatchObject({ name: 'Kept' });
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual(['/api/outputs/kept.png']));
    await waitFor(() => expect(urlsOf(madeKey)).toEqual(['/api/outputs/kept.png']));
  });

  it('back on its board while its add still uploads: no reload line, and the record stays until it lands', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    await new Promise((done) => setTimeout(done, 30));
    expect(document.body.textContent).not.toContain('page reloaded');
    const kept = JSON.parse(window.sessionStorage.getItem('nebula:moodboard-adds-in-flight') ?? '[]') as Array<{ name: string }>;
    expect(kept.map((it) => it.name)).toEqual(['river.png']);
    await uploads.open();
    await waitFor(() => expect(window.sessionStorage.getItem('nebula:moodboard-adds-in-flight')).toBeNull());
  });

  it('GM 3: the same file on the same board after a delete undone is still caught (the board, not its draft)', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => {
      store().reset(g1Key, { name: 'Untitled Moodboard', notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
      useUIStore.getState().enterMoodboardEditor('new', 'global');
    });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(spokenLines()).toContain(ALREADY_BEING_ADDED));
    expect(board.placeholders).toHaveLength(1);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(server.uploads).toEqual(['river.png']);
  });

  it('an away spot waiting for its board follows the board\'s draft when it moves to another key (a move to a project)', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    await uploads.open();
    await waitFor(() => expect(useBoardAddStore.getState().held).toEqual([expect.objectContaining({ away: true })]));
    const projectKey = JSON.stringify(['moodboard', 'project', 'g1', 'p1']);
    act(() => { store().copyTo(g1Key, projectKey); });
    expect(useBoardAddStore.getState().held[0].board?.key).toBe(projectKey);
  });

  it('back on the board in the List: the away spots go (the List has no fade)', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    await uploads.open();
    await waitFor(() => expect(useBoardAddStore.getState().held).toEqual([expect.objectContaining({ away: true })]));
    act(() => { useBoardCanvasStore.setState({ view: 'list' }); });
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    await screen.findByDisplayValue('Global board');
    await waitFor(() => expect(useBoardAddStore.getState().held).toEqual([]));
    expect(draftUrls()).toContain(river);
  });
});

describe('review 6 (round 6b): the open board\'s commit, reload records per tab and per board', () => {
  const store = () => useAssetStudioDraftStore.getState();
  const newKey = JSON.stringify(['moodboard', 'global', 'new']);
  const madeKey = JSON.stringify(['moodboard', 'global', 'made1']);
  const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
  const river = '/api/outputs/chat-uploads/river.png';
  const PENDING = 'nebula:moodboard-adds-in-flight';
  type PendingRecord = { id: string; board: string; name: string; page: string; at: number };
  const records = () => JSON.parse(window.sessionStorage.getItem(PENDING) ?? '[]') as PendingRecord[];
  const urlsOf = (key: string) => ((store().entries[key]?.draft as { images?: MoodboardImage[] } | undefined)?.images ?? []).map((img) => img.url);
  const fresh = (name = 'Untitled Moodboard') => ({ name, notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
  const clickNew = () => act(() => { screen.getByRole('button', { name: '+ New Moodboard' }).click(); });
  /** A held promise and its release. */
  const gate = () => {
    let open: () => void = () => {};
    const held = new Promise<void>((done) => { open = done; });
    return { held, open: () => act(async () => { open(); await held; }) };
  };
  /** A server that also creates boards (made1), its creates and edits kept apart from g1's; `hold` holds each create. */
  const madeServer = (hold?: Promise<void>) => {
    const made = { board: null as Moodboard | null, edits: [] as MoodboardOp[][], creates: [] as Partial<Moodboard>[] };
    api.createMoodboard.mockImplementation(async (body: Partial<Moodboard>) => {
      made.creates.push(clone(body));
      if (hold) await hold;
      made.board = { ...clone(server.board), id: 'made1', name: body.name ?? '', version: 1, projectId: undefined, thumbnail: '',
        images: (body.images ?? []).map((img) => image(img.id, { url: img.url, placements: img.placements ?? [card(img.id)] })) } as Moodboard;
      return clone(made.board);
    });
    const g1Edit = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementation(async (id: string, ops: MoodboardOp[], base?: number) => {
      if (id !== 'made1') return g1Edit(id, ops, base);
      made.edits.push(ops);
      for (const op of ops) {
        if (op.op === 'add') made.board!.images = [...made.board!.images, ...op.images.map((img) => image(img.id!, { url: img.url,
          placements: 'at' in op && op.at ? [card(img.id!, op.at.x, op.at.y)] : [card(img.id!)] }))];
      }
      made.board = { ...made.board!, version: made.board!.version + 1 };
      return { board: clone(made.board), version: made.board.version, applied: [], undo: { ops: [] } };
    });
    const g1Put = api.updateMoodboard.getMockImplementation()!;
    api.updateMoodboard.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      if (id !== 'made1') return g1Put(id, body);
      const fields = { ...body };
      delete fields.baseVersion;
      made.board = { ...made.board!, ...fields, version: made.board!.version + 1 } as Moodboard;
      return clone(made.board);
    });
    api.fetchMoodboard.mockImplementation(async (id: string) => (id === 'made1' ? clone(made.board) : id === server.board.id ? clone(server.board) : null));
    return made;
  };
  const openNew = async () => {
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await screen.findByTestId('board-canvas');
    await waitFor(() => expect(store().entries[newKey]?.loaded).toBe(true));
  };
  const toBoard = async (id: string) => {
    act(() => { useUIStore.getState().enterMoodboardEditor(id, 'global'); });
    await screen.findByTestId('board-canvas');
  };

  it('MEDIUM-1 (R6-D): a Board paste on an unsaved board the person stays on is that board\'s own add: one create, no away edit, nothing marked away', async () => {
    const made = madeServer();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await waitFor(() => expect(urlsOf(madeKey)).toEqual([river]));
    await new Promise((done) => setTimeout(done, 300));
    expect(made.creates).toHaveLength(1);
    expect(made.edits).toEqual([]);
    expect(made.board?.images.map((img) => img.url)).toEqual([river]);
    expect(useBoardAddStore.getState().held.some((holder) => holder.away)).toBe(false);
    expect(store().entries[madeKey].dirty).toBe(false);
  });

  it('MEDIUM-1 (R6-A): New with an add in flight whose upload ends while New\'s save is out: the saved board holds the image, and its draft is clean', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    // The upload ends while the create is out: the open (unsaved) board takes it.
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    expect(made.creates[0].images).toEqual([]);
    await create.open();
    // Sent as an edit of the new board, on the version its create answered.
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
    expect(made.edits).toHaveLength(1);
    expect(api.editMoodboard.mock.calls.at(-1)?.[0]).toBe('made1');
    expect(api.editMoodboard.mock.calls.at(-1)?.[2]).toBe(1);
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveState: 'saved', pendingSaveId: null }));
    expect((store().entries[madeKey].draft as { pendingOps?: MoodboardOp[] }).pendingOps ?? []).toEqual([]);
    expect(urlsOf(madeKey)).toEqual([river]);
    // The fresh board stays empty, and the person is on it.
    expect(urlsOf(newKey)).toEqual([]);
    expect(useUIStore.getState().moodboardEditorId).toBe('new');
    // Back on made1: nothing is sent again.
    await toBoard('made1');
    await new Promise((done) => setTimeout(done, 300));
    expect(made.edits).toHaveLength(1);
    expect(made.board?.images.filter((img) => img.url === river)).toHaveLength(1);
  });

  it('MEDIUM-1: a board field changed while New\'s save was out is sent too, on a PUT after the image edit', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), notes: 'warm light' })); });
    await create.open();
    await waitFor(() => expect(made.board?.notes).toBe('warm light'));
    expect(made.board?.images.map((img) => img.url)).toEqual([river]);
    expect(api.updateMoodboard.mock.calls.at(-1)?.[1]).toMatchObject({ notes: 'warm light', baseVersion: 2 });
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveState: 'saved' }));
  });

  it('MEDIUM-1: someone else saved the new board meanwhile (409): the queued send reads the board, replays, and sends again', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    const send = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementationOnce(async () => {
      // An agent's add reached made1 first.
      made.board = { ...made.board!, version: 2, images: [...made.board!.images, image('agent', { url: '/api/outputs/agent.png' })] };
      throw new MoodboardVersionConflict(clone(made.board));
    }).mockImplementation(send);
    await create.open();
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual(['/api/outputs/agent.png', river]));
    expect(api.editMoodboard.mock.calls.at(-1)?.[2]).toBe(2);
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveState: 'saved' }));
    expect(urlsOf(madeKey)).toEqual(['/api/outputs/agent.png', river]);
  });

  it('MEDIUM-1: a change made while the queued send is out goes the same way once it lands', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    const edit = gate();
    const send = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementation(async (...args: Parameters<typeof send>) => { await edit.held; return send(...args); });
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.pendingSaveId).toBeTruthy());
    act(() => { store().edit(madeKey, (draft) => ({ ...(draft as object), notes: 'warm light' })); });
    await edit.open();
    await waitFor(() => expect(made.board?.notes).toBe('warm light'));
    expect(made.board?.images.map((img) => img.url)).toEqual([river]);
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveState: 'saved' }));
  });

  it('MEDIUM-1: the queued send failing is the saved board\'s own line, with Retry, and keeps the image', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    api.editMoodboard.mockRejectedValue(Object.assign(new Error('offline'), { status: 0 }));
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.saveError).toBeTruthy());
    expect(store().entries[madeKey].saveError).toEqual({ heading: '', reason: 'Nebula couldn’t save the board because the server didn’t accept this save. Try again.' });
    expect(store().entries[madeKey]).toMatchObject({ retry: 'save', dirty: true, pendingSaveId: null });
    expect(urlsOf(madeKey)).toEqual([river]);
    expect(store().entries[newKey].saveError ?? null).toBeNull();
  });

  it('MEDIUM-1 (R6-E): a List paste on an unsaved board the person stays on: one create, the Studio follows the saved board, nothing sent twice', async () => {
    const made = madeServer();
    await openNew();
    act(() => { useBoardCanvasStore.setState({ view: 'list' }); });
    paste(clipboard({ files: [png('river.png')] }));
    // A List add waits for the List's usual save (600 ms after the last change).
    await waitFor(() => expect(made.creates).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(useUIStore.getState().moodboardEditorId).toBe('made1'));
    await new Promise((done) => setTimeout(done, 300));
    expect(made.creates).toHaveLength(1);
    expect(made.edits).toEqual([]);
  });

  it('the autosave\'s 600 ms wait runs from the draft\'s last change, not the Studio\'s last render', async () => {
    const made = madeServer();
    await openNew();
    act(() => { useBoardCanvasStore.setState({ view: 'list' }); });
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    // The Studio draws again every 200 ms (held spots changing), with the draft unchanged.
    for (let i = 0; i < 8 && made.creates.length === 0; i += 1) {
      act(() => { useBoardAddStore.setState((current) => ({ held: [...current.held] })); });
      await new Promise((done) => setTimeout(done, 200));
    }
    expect(made.creates).toHaveLength(1);
  });

  it('MEDIUM-2: reload records are this tab\'s: one in storage other tabs share is neither said nor taken, and this tab\'s go to its session storage', async () => {
    window.localStorage.setItem(PENDING, JSON.stringify([
      { id: 'placeholder-1', board: 'g1', name: 'tab-a.png', page: 'tab A, still open', at: Date.now() }]));
    try {
      const uploads = holdUploads();
      await openStudio('board');
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(board.placeholders).toHaveLength(1));
      await new Promise((done) => setTimeout(done, 30));
      expect(document.body.textContent).not.toContain('page reloaded');
      expect(records().map((it) => `${it.board}:${it.name}`)).toEqual(['g1:river.png']);
      await uploads.open();
      await waitFor(() => expect(addOps()).toHaveLength(1));
      await waitFor(() => expect(records()).toEqual([]));
      expect(JSON.parse(window.localStorage.getItem(PENDING) ?? '[]')).toHaveLength(1);
    } finally { window.localStorage.removeItem(PENDING); }
  });

  it('R8: an add that ends clears only this page load\'s record, never an earlier load\'s with the same holder id', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(records()).toHaveLength(1));
    const [mine] = records();
    // The page before a reload counted its holders from 1 too: the same id, on another board.
    window.sessionStorage.setItem(PENDING, JSON.stringify([...records(),
      { id: mine.id, board: 'other', name: 'sea.png', page: 'an earlier page', at: Date.now() }]));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    await waitFor(() => expect(records().map((it) => it.name)).toEqual(['sea.png']));
  });

  it('NIT-6: a record older than a day is dropped unsaid, and the list keeps only the newest 50', async () => {
    const now = Date.now();
    window.sessionStorage.setItem(PENDING, JSON.stringify([
      { id: 'placeholder-900', board: 'g1', name: 'old.png', page: 'an earlier page', at: now - 25 * 60 * 60 * 1000 },
      ...Array.from({ length: 60 }, (_, index) => ({ id: `placeholder-${1000 + index}`, board: 'other', name: `f${index}.png`,
        page: 'an earlier page', at: now - 1000 + index }))]));
    const uploads = holdUploads();
    await openStudio('board');
    await new Promise((done) => setTimeout(done, 30));
    expect(document.body.textContent).not.toContain('page reloaded');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const kept = records();
    expect(kept).toHaveLength(50);
    expect(kept.some((it) => it.name === 'old.png')).toBe(false);
    expect(kept[0].name).toBe('f11.png');
    expect(kept.at(-1)).toMatchObject({ board: 'g1', name: 'river.png' });
    await uploads.open();
  });

  it('LOW-3 (GM r10 1): New with an add in flight, then a reload: the line shows on the board New saved, and only there', async () => {
    madeServer();
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    // Not saved yet: nothing to name it by.
    expect(records()).toEqual([]);
    clickNew();
    await waitFor(() => expect(store().entries[madeKey]?.savedId).toBe('made1'));
    await waitFor(() => expect(records().map((it) => `${it.board}:${it.name}`)).toEqual(['made1:river.png']));
    // The reload: this page's records are an earlier page's now.
    window.sessionStorage.setItem(PENDING, JSON.stringify(records().map((it) => ({ ...it, page: 'the page before the reload' }))));
    cleanup();
    await openStudio('board');
    await new Promise((done) => setTimeout(done, 30));
    expect(document.body.textContent).not.toContain('page reloaded');
    expect(records()).toHaveLength(1);
    await toBoard('made1');
    await screen.findByText('“river.png” wasn’t added because the page reloaded while it uploaded. Paste it again.');
    expect(records()).toEqual([]);
    await uploads.open();
  });

  it('LOW-3: an unsaved board an away landing saves: another add still on its way is recorded under the saved id, until it ends', async () => {
    madeServer();
    const uploads = holdEach();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    paste(clipboard({ files: [png('lake.png', 20)] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(2));
    await waitFor(() => expect(uploads.held('lake.png') && uploads.held('river.png')).toBe(true));
    expect(records()).toEqual([]);
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    // river lands away: its board is saved for it (made1), while lake still uploads.
    await uploads.settle('river.png', true);
    await waitFor(() => expect(store().entries[madeKey]?.savedId).toBe('made1'));
    await waitFor(() => expect(records().map((it) => `${it.board}:${it.name}`)).toEqual(['made1:lake.png']));
    await uploads.settle('lake.png', false);
    await waitFor(() => expect(records()).toEqual([]));
  });

  it('NIT-5: New whose save of the unsaved board is out when the person picks another board: the fresh draft is made, and they stay where they went', async () => {
    const create = gate();
    madeServer(create.held);
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const epoch = store().entries[newKey].epoch;
    clickNew();
    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalledTimes(1));
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    await create.open();
    await waitFor(() => expect(store().entries[newKey]?.epoch).toBe(epoch + 1));
    await new Promise((done) => setTimeout(done, 30));
    expect(useUIStore.getState().moodboardEditorId).toBe('g1');
    expect(screen.getByDisplayValue('Global board')).toBeTruthy();
    await uploads.open();
  });

  it('NIT-5: a delete whose save of an unsaved board is out when the person leaves the Studio doesn\'t pull them back', async () => {
    const create = gate();
    madeServer(create.held);
    removeAsset.fn = async () => true;
    await openStudio('board');
    act(() => {
      store().reset(newKey, { ...fresh('Kept'), images: [image('k1', { url: '/api/outputs/kept.png', placements: [card('k1')] })] });
      store().patch(newKey, { loaded: true });
    });
    act(() => { screen.getByRole('button', { name: 'Delete' }).click(); });
    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalledTimes(1));
    act(() => { useUIStore.setState({ viewMode: 'canvas' }); });
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.savedId).toBe('made1'));
    await waitFor(() => expect(store().aliases[newKey]).toBeUndefined());
    expect(urlsOf(newKey)).toEqual([]);
    await new Promise((done) => setTimeout(done, 30));
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });

  it('NIT-5: a delete whose trash move is out when the person picks another board leaves them there', async () => {
    const removal = gate();
    removeAsset.fn = async () => { await removal.held; return true; };
    await openStudio('board');
    act(() => { screen.getByRole('button', { name: 'Delete' }).click(); });
    await new Promise((done) => setTimeout(done, 30));
    act(() => { useUIStore.getState().enterMoodboardEditor('g2', 'global'); });
    await removal.open();
    await new Promise((done) => setTimeout(done, 50));
    expect(useUIStore.getState().moodboardEditorId).toBe('g2');
  });

  it('R12/R13: New while the open new board\'s own first save is out waits for it and keeps that board: one create, and a fresh draft', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(made.creates).toHaveLength(1));
    clickNew();
    await new Promise((done) => setTimeout(done, 30));
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.savedId).toBe('made1'));
    await waitFor(() => expect(store().aliases[newKey]).toBeUndefined());
    await waitFor(() => expect(useUIStore.getState().moodboardEditorId).toBe('new'));
    expect(urlsOf(newKey)).toEqual([]);
    expect(urlsOf(madeKey)).toEqual([river]);
    await new Promise((done) => setTimeout(done, 30));
    expect(made.creates).toHaveLength(1);
  });

  it('R3/R5: after an unsaved draft is discarded mid-upload, the same image pasted on the fresh draft (a later epoch) is its own add, and lands there', async () => {
    const made = madeServer();
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    act(() => {
      store().reset(newKey, fresh('Fresh'));
      useUIStore.getState().enterMoodboardEditor('new', 'global');
    });
    await waitFor(() => expect(store().entries[newKey].loaded).toBe(true));
    expect(store().entries[newKey].epoch).toBeGreaterThan(0);
    await waitFor(() => expect(board.placeholders).toEqual([]));
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    expect(spokenLines()).not.toContain(ALREADY_BEING_ADDED);
    await uploads.open();
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
    expect(made.creates).toHaveLength(1);
  });

  it('R14: a failed away write for a board whose draft was reset meanwhile writes nothing into the fresh draft at its key', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    act(() => { store().reset(g1Key, fresh()); });
    api.editMoodboard.mockRejectedValue(Object.assign(new Error('offline'), { status: 0 }));
    await uploads.open();
    await waitFor(() => expect(api.editMoodboard).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 30));
    expect(store().entries[g1Key].saveError ?? null).toBeNull();
    expect(urlsOf(g1Key)).toEqual([]);
  });

  it('R16: away spots on a board read again (its draft loading) wait for the load before they fade in', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    await uploads.open();
    await waitFor(() => expect(useBoardAddStore.getState().held).toEqual([expect.objectContaining({ away: true })]));
    const load = gate();
    const read = api.fetchMoodboard.getMockImplementation()!;
    api.fetchMoodboard.mockImplementation(async (id: string) => { await load.held; return read(id); });
    // As a reconnect reads a kept board again.
    act(() => { store().patch(g1Key, { loaded: false }); });
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    await new Promise((done) => setTimeout(done, 50));
    expect(useBoardAddStore.getState().held).toEqual([expect.objectContaining({ away: true })]);
    await load.open();
    await screen.findByDisplayValue('Global board');
    await waitFor(() => expect(useBoardAddStore.getState().held).toEqual([expect.objectContaining({ away: false })]));
  });

  it('R17: the reload line waits for its board to load: a board read again says it once it is drawn', async () => {
    window.sessionStorage.setItem(PENDING, JSON.stringify([
      { id: 'placeholder-9', board: 'g1', name: 'river.png', page: 'an earlier page', at: Date.now() }]));
    const load = gate();
    const read = api.fetchMoodboard.getMockImplementation()!;
    api.fetchMoodboard.mockImplementation(async (id: string) => { await load.held; return read(id); });
    // A kept draft of g1 with its id, being read again.
    act(() => { store().ensure(g1Key, { ...emptyAssetStudioEntry(fresh('Global board')), savedId: 'g1' }); });
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await screen.findByText('Loading Moodboard...');
    await new Promise((done) => setTimeout(done, 50));
    expect(records()).toHaveLength(1);
    await load.open();
    await screen.findByText('“river.png” wasn’t added because the page reloaded while it uploaded. Paste it again.');
    expect(records()).toEqual([]);
  });

  // Review 7 (round 6c), GM r11 1: a board New just saved keeps Undo like any saved board.
  const undoServer = (made: ReturnType<typeof madeServer>, holdMade: { on: boolean; gate: Promise<void> }) => {
    const madeEdit = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementation(async (id: string, ops: MoodboardOp[], base?: number) => {
      if (id === 'made1' && holdMade.on) await holdMade.gate;
      if (id === 'made1') {
        for (const op of ops) {
          if (op.op === 'remove') {
            made.edits.push(ops);
            made.board = { ...made.board!, images: made.board!.images.filter((img) => !op.images.includes(img.id)), version: made.board!.version + 1 };
            return { board: clone(made.board), version: made.board.version, applied: [], undo: { ops: [] } };
          }
        }
      }
      const result = await madeEdit(id, ops, base);
      if (id !== 'made1') return result;
      const added = ops.flatMap((op) => (op.op === 'add' ? op.images.map((img) => img.id!) : []));
      return { ...result, undo: { ops: added.length ? [{ op: 'remove', images: added }] : [] } };
    });
  };

  it('R7-U1: an add on the saved board while the queued send is out keeps its Undo', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const editGate = gate();
    const holdMade = { on: false, gate: editGate.held };
    undoServer(made, holdMade);
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    holdMade.on = true;
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.pendingSaveId).toBeTruthy());
    // The person opens the board New just saved, from the rail, and pastes on it.
    await toBoard('made1');
    paste(clipboard({ files: [png('lake.png', 20)] }));
    await waitFor(() => expect(urlsOf(madeKey)).toHaveLength(2));
    holdMade.on = false;
    await editGate.open();
    await waitFor(() => expect(made.board?.images).toHaveLength(2));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
    const epoch = store().entries[madeKey].epoch;
    const steps = useBoardUndoStore.getState().history(madeKey, epoch).done;
    expect(steps).toHaveLength(1);
    expect(steps[0].state).toBe('saved');
    press('z', { metaKey: true });
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]), { timeout: 2000 });
  });

  it('R7-U1 control: the same paste after the queued send has landed keeps its Undo (persist sends it)', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const editGate = gate();
    undoServer(made, { on: false, gate: editGate.held });
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
    await toBoard('made1');
    paste(clipboard({ files: [png('lake.png', 20)] }));
    await waitFor(() => expect(made.board?.images).toHaveLength(2));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
    press('z', { metaKey: true });
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]), { timeout: 2000 });
  });

  it('R7-U1 conflict: a paste on the saved board while the queued send replays a 409 is still its own step, with its Undo', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const editGate = gate();
    const holdMade = { on: false, gate: editGate.held };
    undoServer(made, holdMade);
    const undoing = api.editMoodboard.getMockImplementation()!;
    let conflicted = false;
    api.editMoodboard.mockImplementation(async (id: string, ops: MoodboardOp[], base?: number) => {
      if (id === 'made1' && !conflicted && ops.some((op) => op.op === 'add')) {
        await editGate.held;
        conflicted = true;
        made.board = { ...made.board!, version: made.board!.version + 1 };
        throw new MoodboardVersionConflict(clone(made.board));
      }
      return undoing(id, ops, base);
    });
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.pendingSaveId).toBeTruthy());
    await toBoard('made1');
    paste(clipboard({ files: [png('lake.png', 20)] }));
    await waitFor(() => expect(urlsOf(madeKey)).toHaveLength(2));
    await editGate.open();
    await waitFor(() => expect(made.board?.images).toHaveLength(2));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
    // The replay sent river alone; lake went on its own, with its Undo.
    expect(made.edits.filter((ops) => ops.some((op) => op.op === 'add')).map((ops) => ops.length)).toEqual([1, 1]);
    press('z', { metaKey: true });
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]), { timeout: 2000 });
  });

  it('R7-U1 a field the send owns, changed again on the saved board: the send takes its own value, the change is its own step', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const editGate = gate();
    const holdMade = { on: false, gate: editGate.held };
    undoServer(made, holdMade);
    const madePut = api.updateMoodboard.getMockImplementation()!;
    const puts: Record<string, unknown>[] = [];
    api.updateMoodboard.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      const before = made.board?.notes;
      const saved = await madePut(id, body);
      if (id !== 'made1') return saved;
      puts.push(body);
      return { ...saved, undo: { ops: [{ op: 'restore', slices: [{ part: 'fields', notes: before }] }] } };
    });
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), notes: 'warm light' })); });
    holdMade.on = true;
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.pendingSaveId).toBeTruthy());
    await toBoard('made1');
    const notes = screen.getByDisplayValue('warm light');
    fireEvent.focus(notes);
    fireEvent.change(notes, { target: { value: 'warmer' } });
    fireEvent.blur(notes);
    holdMade.on = false;
    await editGate.open();
    await waitFor(() => expect(made.board?.notes).toBe('warmer'));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
    expect(puts.map((body) => body.notes)).toEqual(['warm light', 'warmer']);
    const steps = useBoardUndoStore.getState().history(madeKey, store().entries[madeKey].epoch).done;
    expect(steps.map((step) => step.state)).toEqual(['saved']);
  });

  it('R7-U1 fields: a rename on the saved board while the queued send is out keeps its Undo', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const editGate = gate();
    const holdMade = { on: false, gate: editGate.held };
    undoServer(made, holdMade);
    const madePut = api.updateMoodboard.getMockImplementation()!;
    const puts: Record<string, unknown>[] = [];
    api.updateMoodboard.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      const before = made.board?.name;
      const saved = await madePut(id, body);
      if (id !== 'made1') return saved;
      puts.push(body);
      return { ...saved, undo: { ops: [{ op: 'restore', slices: [{ part: 'fields', name: before }] }] } };
    });
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    holdMade.on = true;
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.pendingSaveId).toBeTruthy());
    await toBoard('made1');
    const name = screen.getByDisplayValue(made.board!.name);
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'Rivers' } });
    fireEvent.blur(name);
    holdMade.on = false;
    await editGate.open();
    await waitFor(() => expect(made.board?.name).toBe('Rivers'));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
    // Sent by the Studio's autosave, on its own PUT, with its Undo kept.
    expect(puts).toHaveLength(1);
    const steps = useBoardUndoStore.getState().history(madeKey, store().entries[madeKey].epoch).done;
    expect(steps).toHaveLength(1);
    expect(steps[0].state).toBe('saved');
    expect(steps[0].undo).toEqual([{ op: 'restore', slices: [{ part: 'fields', name: 'Untitled Moodboard' }] }]);
  });

  it('R7 LOW-1: the queued send\'s 409 replay moves the add off a tile another tab put at its spot (GM r11 3)', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    const send = api.editMoodboard.getMockImplementation()!;
    const spots: Array<{ x: number; y: number }> = [];
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      const at = (ops.find((op) => op.op === 'add') as Extract<MoodboardOp, { op: 'add' }>).at!;
      spots.push(at);
      // Tab 2 pasted lake.png on made1 first, exactly there.
      made.board = { ...made.board!, version: 2, images: [...made.board!.images,
        image('lake', { url: '/api/outputs/lake.png', placements: [{ ...card('lake', at.x, at.y), w: 294, h: 441 }] })] };
      throw new MoodboardVersionConflict(clone(made.board));
    }).mockImplementation(send);
    await create.open();
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual(['/api/outputs/lake.png', river]));
    const [w, h] = sizeFor(1, 1.5);
    const sent = (made.edits.at(-1)!.find((op) => op.op === 'add') as Extract<MoodboardOp, { op: 'add' }>).at!;
    expect(sent).not.toEqual(spots[0]);
    expect(sent).toEqual(respot({ ...spots[0], width: w, height: h }, [{ ...spots[0], width: 294, height: 441 }], board.view));
    expect(keepsGap({ ...sent, width: w, height: h }, { ...spots[0], width: 294, height: 441 })).toBe(true);
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveState: 'saved' }));
  });

  it('R7-U1 away: a change on the saved board while no Studio has it open goes by the queued send', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const editGate = gate();
    const holdMade = { on: false, gate: editGate.held };
    undoServer(made, holdMade);
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    holdMade.on = true;
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.pendingSaveId).toBeTruthy());
    // A change lands on made1's draft while the person stays on the fresh board.
    act(() => { store().edit(madeKey, (draft) => ({ ...(draft as object), name: 'Elsewhere' })); });
    holdMade.on = false;
    await editGate.open();
    await waitFor(() => expect(made.board?.name).toBe('Elsewhere'));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
  });
});

describe('round 6c: offline background sends, review 7\'s surviving mutants, the record cap, the reload line (GM r11 4)', () => {
  const store = () => useAssetStudioDraftStore.getState();
  const newKey = JSON.stringify(['moodboard', 'global', 'new']);
  const madeKey = JSON.stringify(['moodboard', 'global', 'made1']);
  const river = '/api/outputs/chat-uploads/river.png';
  const PENDING = 'nebula:moodboard-adds-in-flight';
  const WAITING = 'nebula:moodboard-sends-waiting';
  type Waiting = { board: string; ops: MoodboardOp[]; fields: Record<string, unknown>; page: string; at: number };
  const waiting = () => JSON.parse(window.sessionStorage.getItem(WAITING) ?? '[]') as Waiting[];
  const records = () => JSON.parse(window.sessionStorage.getItem(PENDING) ?? '[]') as Array<{ id: string; board: string; name: string; page: string; at: number }>;
  const urlsOf = (key: string) => ((store().entries[key]?.draft as { images?: MoodboardImage[] } | undefined)?.images ?? []).map((img) => img.url);
  const fresh = (name = 'Untitled Moodboard') => ({ name, notes: '', mode: 'look', strength: 0.7, images: [], analysis: null });
  const clickNew = () => act(() => { screen.getByRole('button', { name: '+ New Moodboard' }).click(); });
  const gate = () => {
    let open: () => void = () => {};
    const held = new Promise<void>((done) => { open = done; });
    return { held, open: () => act(async () => { open(); await held; }) };
  };
  /** made1, created by New; its edits refused while Nebula is offline, as apiFetch refuses a write then. */
  const madeServer = (hold?: Promise<void>, projectId?: string) => {
    const made = { board: null as Moodboard | null, edits: [] as MoodboardOp[][], creates: [] as Partial<Moodboard>[],
      puts: [] as Record<string, unknown>[], fail: null as unknown, editsTried: 0 };
    api.createMoodboard.mockImplementation(async (body: Partial<Moodboard>) => {
      if (isBackendOffline()) throw new OfflineRefusal('POST', '/api/moodboards');
      made.creates.push(clone(body));
      if (hold) await hold;
      made.board = { ...clone(server.board), id: 'made1', name: body.name ?? '', version: 1, projectId: projectId ?? undefined, thumbnail: '',
        images: (body.images ?? []).map((img) => image(img.id, { url: img.url, placements: img.placements ?? [card(img.id)] })) } as Moodboard;
      return clone(made.board);
    });
    const g1Edit = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementation(async (id: string, ops: MoodboardOp[], base?: number) => {
      if (id !== 'made1') return g1Edit(id, ops, base);
      if (isBackendOffline()) throw new OfflineRefusal('POST', '/api/moodboards/made1/edit');
      made.editsTried += 1;
      if (made.fail) throw made.fail;
      made.edits.push(ops);
      for (const op of ops) {
        if (op.op === 'add') made.board!.images = [...made.board!.images, ...op.images.map((img) => image(img.id!, { url: img.url,
          placements: 'at' in op && op.at ? [card(img.id!, op.at.x, op.at.y)] : [card(img.id!)] }))];
      }
      made.board = { ...made.board!, version: made.board!.version + 1, thumbnail: `/api/outputs/made1-v${made.board!.version + 1}.png` };
      return { board: clone(made.board), version: made.board.version, applied: [], undo: { ops: [] } };
    });
    const g1Put = api.updateMoodboard.getMockImplementation()!;
    api.updateMoodboard.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      if (id !== 'made1') return g1Put(id, body);
      if (isBackendOffline()) throw new OfflineRefusal('PUT', '/api/moodboards/made1');
      made.puts.push(clone(body));
      const fields = { ...body };
      delete fields.baseVersion;
      // The server cleans what it's sent: a direction is trimmed.
      if (typeof fields.direction === 'string') fields.direction = fields.direction.trim();
      made.board = { ...made.board!, ...fields, version: made.board!.version + 1 } as Moodboard;
      return clone(made.board);
    });
    api.fetchMoodboard.mockImplementation(async (id: string) => (id === 'made1' ? clone(made.board) : id === server.board.id ? clone(server.board) : null));
    return made;
  };
  const openNew = async (scope: 'global' | 'project' = 'global') => {
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('new', scope); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await screen.findByTestId('board-canvas');
  };
  const toBoard = async (id: string) => {
    act(() => { useUIStore.getState().enterMoodboardEditor(id, 'global'); });
    await screen.findByTestId('board-canvas');
  };
  /** New with an add that lands in the unsaved board while New's create is out. */
  const newWithAdd = async (made: ReturnType<typeof madeServer>) => {
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
  };
  const offline = () => act(() => { noteBackendConnection('offline'); });
  const online = () => act(async () => { noteBackendConnection('online'); await Promise.resolve(); });

  it('New\'s save (saveAway) of a board whose image went in the create: the add counts as sent, nothing replays it (review 9 R27)', async () => {
    const made = madeServer();
    await openNew();
    // No name, so the autosave can't save it: New's own save (saveAway) sends the create, under the default name.
    act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: '' })); });
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    await new Promise((done) => setTimeout(done, 700));
    expect(made.creates).toEqual([]);
    clickNew();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ savedId: 'made1', pendingSaveId: null }));
    await new Promise((done) => setTimeout(done, 300));
    expect(made.creates).toHaveLength(1);
    expect(made.creates[0].images).toHaveLength(1);
    expect(api.editMoodboard.mock.calls.filter((call) => call[0] === 'made1')).toEqual([]);
    expect(made.board?.images.map((img) => img.url)).toEqual([river]);
  });

  it('a queued send whose owned name landed from another window before it was refused: the record keeps no field, and the resend PUTs none (review 9 R23, R24)', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    // Renamed while the create was out: the queued send owns the name.
    act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: 'Dusk' })); });
    const edit = api.editMoodboard.getMockImplementation()!;
    let first = true;
    api.editMoodboard.mockImplementation(async (id: string, ops: MoodboardOp[], base?: number) => {
      if (id === 'made1' && first) {
        // Another window renamed it the same way; then Nebula went: the rebased send is refused unsent.
        first = false;
        made.board = { ...made.board!, name: 'Dusk', version: made.board!.version + 1 };
        act(() => { noteBackendConnection('offline'); });
        throw new MoodboardVersionConflict(clone(made.board));
      }
      return edit(id, ops, base);
    });
    await create.open();
    await waitFor(() => expect(waiting()).toHaveLength(1));
    expect(waiting()[0]).toMatchObject({ board: 'made1' });
    expect(waiting()[0].fields).toEqual({});
    expect(waiting()[0].ops).toEqual([expect.objectContaining({ op: 'add' })]);
    await online();
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null, saveError: null }));
    expect(made.puts).toEqual([]);
    expect(made.board?.name).toBe('Dusk');
  });

  it('offline: the queued send is refused, nothing shows, it is kept for a reload; back online it is sent once and the record goes', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    offline();
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true, saveState: 'draft', saveError: null }));
    expect(made.edits).toEqual([]);
    expect(waiting()).toEqual([expect.objectContaining({ board: 'made1', fields: {},
      ops: [expect.objectContaining({ op: 'add', images: [expect.objectContaining({ url: river })] })] })]);
    await new Promise((done) => setTimeout(done, 50));
    expect(made.editsTried).toBe(0);
    await online();
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveState: 'saved', saveError: null }));
    expect(made.edits).toHaveLength(1);
    expect(waiting()).toEqual([]);
  });

  it('offline, then back online, and the resend fails: the board says why, verbatim, and Retry sends it again', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    offline();
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true }));
    made.fail = new RequestFailedError("Couldn't save the board.", 429, { reason: "Nebula didn't respond. Try again." });
    await online();
    await waitFor(() => expect(made.editsTried).toBe(1));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ saveState: 'error', retry: 'save',
      saveError: { heading: '', reason: 'Nebula couldn’t save the board because the server is busy. Try again.' } }));
    // Sent again once, not more.
    await new Promise((done) => setTimeout(done, 50));
    expect(made.editsTried).toBe(1);
    // The line on that board: neutral, colour included (GM r12 1), with the
    // header's Retry its one retry and the chip "Not saved", not "Error".
    await toBoard('made1');
    const sentence = await screen.findByText('Nebula couldn’t save the board because the server is busy. Try again.');
    const notice = sentence.closest('.moodboard-studio__notice')!;
    expect(notice.className).toContain('moodboard-studio__notice--neutral');
    expect(notice.className).not.toContain('--error');
    expect(notice.hasAttribute('data-line-neutral')).toBe(true);
    expect(notice.querySelector('button')).toBeNull();
    expect(notice.textContent).toBe('Nebula couldn’t save the board because the server is busy. Try again.');
    const chip = document.querySelector('.moodboard-studio-toolbar__state')!;
    expect(chip.textContent).toBe('Not saved');
    expect(chip.className).toContain('moodboard-studio-toolbar__state--not-saved');
    expect(chip.className).not.toContain('--error');
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    made.fail = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveError: null }));
    expect(screen.queryByText(/couldn’t save the board/)).toBeNull();
    expect(waiting()).toEqual([]);
  });

  it('a reload with a send waiting: the board\'s next open in this tab takes it back and sends it; nothing is said for what was kept', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    offline();
    await create.open();
    await waitFor(() => expect(waiting()).toHaveLength(1));
    // The reload: an earlier page's record, and nothing in memory.
    window.sessionStorage.setItem(WAITING, JSON.stringify(waiting().map((it) => ({ ...it, page: 'the page before the reload' }))));
    cleanup();
    useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
    resetBoardAdds();
    await online();
    expect(made.editsTried).toBe(0);
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('made1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
    expect(made.edits).toHaveLength(1);
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveError: null }));
    expect(waiting()).toEqual([]);
    expect(document.body.textContent).not.toContain('page reloaded');
    // Opened again: nothing sent twice.
    await toBoard('g1');
    await toBoard('made1');
    await new Promise((done) => setTimeout(done, 50));
    expect(made.edits).toHaveLength(1);
  });

  it('a reload with a send waiting whose image only that page held: the reload line names it; the rest is sent', async () => {
    const made = madeServer();
    made.board = { ...clone(server.board), id: 'made1', images: [], version: 1 } as Moodboard;
    keepWaitingSend('made1', [
      { op: 'add', images: [{ id: 'kept', url: '/api/outputs/kept.png' }], at: { x: 2000, y: 0 } },
      { op: 'add', images: [{ id: 'only', url: 'blob:http://localhost/only-here.png' }], at: { x: 2600, y: 0 } },
    ], { notes: 'warm light' });
    expect(waiting()[0].ops).toHaveLength(1);
    window.sessionStorage.setItem(WAITING, JSON.stringify(waiting().map((it) => ({ ...it, page: 'before' }))));
    window.sessionStorage.setItem(PENDING, JSON.stringify(records().map((it) => ({ ...it, page: 'before' }))));
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('made1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await screen.findByText('“only-here.png” wasn’t added because the page reloaded while it uploaded. Paste it again.');
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual(['/api/outputs/kept.png']));
    await waitFor(() => expect(made.board?.notes).toBe('warm light'));
    expect(records()).toEqual([]);
  });

  it('an add that couldn\'t reach the board the person left while offline: no line; back online it goes once', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
    const send = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementation(async (...args: Parameters<typeof send>) => {
      if (isBackendOffline()) throw new OfflineRefusal('POST', '/api/moodboards/g1/edit');
      return send(...args);
    });
    offline();
    await uploads.open();
    await waitFor(() => expect(urlsOf(g1Key)).toContain(river));
    expect(store().entries[g1Key]).toMatchObject({ saveError: null, dirty: true });
    expect(waiting()).toEqual([expect.objectContaining({ board: 'g1' })]);
    expect(server.edits).toEqual([]);
    await online();
    await waitFor(() => expect(server.board.images.map((img) => img.url)).toContain(river));
    await waitFor(() => expect(store().entries[g1Key]).toMatchObject({ dirty: false, saveError: null }));
    expect(addOps()).toHaveLength(1);
    expect(waiting()).toEqual([]);
  });

  it('an open board\'s own save refused offline: no empty error box; it waits, and goes on reconnect', async () => {
    await openStudio('board');
    const send = api.editMoodboard.getMockImplementation()!;
    let refused = 0;
    api.editMoodboard.mockImplementation(async (...args: Parameters<typeof send>) => {
      if (isBackendOffline()) { refused += 1; throw new OfflineRefusal('POST', '/api/moodboards/g1/edit'); }
      return send(...args);
    });
    offline();
    paste(clipboard({ files: [png('river.png')] }));
    const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
    await waitFor(() => expect(urlsOf(g1Key)).toContain(river));
    await new Promise((done) => setTimeout(done, 700));
    expect(store().entries[g1Key]).toMatchObject({ saveError: null, dirty: true, pendingSaveId: null });
    expect(document.querySelector('.moodboard-studio__notice--error')).toBeNull();
    // Refused once; the autosave doesn't try again while offline.
    expect(refused).toBe(1);
    await online();
    await waitFor(() => expect(server.board.images.map((img) => img.url)).toContain(river));
    await waitFor(() => expect(store().entries[g1Key]).toMatchObject({ dirty: false }));
  });

  it('an add that saves an unsaved board the person left, refused offline: no line; back online the board is saved once, with it', async () => {
    const made = madeServer();
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    offline();
    await uploads.open();
    await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
    await new Promise((done) => setTimeout(done, 30));
    expect(store().entries[newKey]).toMatchObject({ saveError: null, pendingSaveId: null, savedId: null });
    expect(made.creates).toEqual([]);
    await online();
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
    expect(made.creates).toHaveLength(1);
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ saveError: null }));
  });

  it('a waiting send whose add the board already holds (it landed as the tab reloaded): nothing is sent twice', async () => {
    const made = madeServer();
    made.board = { ...clone(server.board), id: 'made1', version: 2,
      images: [image('r1', { url: river, placements: [card('r1')] })] } as Moodboard;
    keepWaitingSend('made1', [{ op: 'add', images: [{ id: 'r1', url: river }], at: { x: 0, y: 0 } }], {});
    window.sessionStorage.setItem(WAITING, JSON.stringify(waiting().map((it) => ({ ...it, page: 'before' }))));
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('made1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await waitFor(() => expect(store().entries[madeKey]?.loaded).toBe(true));
    await new Promise((done) => setTimeout(done, 700));
    expect(made.editsTried).toBe(0);
    expect(made.board?.images).toHaveLength(1);
    expect(waiting()).toEqual([]);
  });

  it('a waiting send older than a day isn\'t taken back', async () => {
    const made = madeServer();
    made.board = { ...clone(server.board), id: 'made1', images: [], version: 1 } as Moodboard;
    keepWaitingSend('made1', [{ op: 'add', images: [{ id: 'old', url: '/api/outputs/old.png' }], at: { x: 0, y: 0 } }], {});
    window.sessionStorage.setItem(WAITING, JSON.stringify(waiting().map((it) => ({ ...it, page: 'before', at: Date.now() - 25 * 60 * 60 * 1000 }))));
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('made1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await waitFor(() => expect(store().entries[madeKey]?.loaded).toBe(true));
    await new Promise((done) => setTimeout(done, 700));
    expect(made.editsTried).toBe(0);
    expect(urlsOf(madeKey)).toEqual([]);
  });

  it('R8-A: offline queued send, the saved board opened and renamed while offline, then reconnect: the rename keeps its Undo', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const madePut = api.updateMoodboard.getMockImplementation()!;
    const puts: Record<string, unknown>[] = [];
    api.updateMoodboard.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      const before = made.board?.name;
      const saved = await madePut(id, body);
      if (id !== 'made1') return saved;
      puts.push(body);
      return { ...saved, undo: { ops: [{ op: 'restore', slices: [{ part: 'fields', name: before }] }] } };
    });
    await newWithAdd(made);
    offline();
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true, saveError: null }));
    // Still offline: the person opens the board New saved and renames it (a field step).
    await toBoard('made1');
    const name = screen.getByDisplayValue(made.board!.name);
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'Rivers' } });
    fireEvent.blur(name);
    await new Promise((done) => setTimeout(done, 30));
    expect(puts).toEqual([]);
    await online();
    await waitFor(() => expect(made.board?.name).toBe('Rivers'));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
    await new Promise((done) => setTimeout(done, 700));
    const steps = useBoardUndoStore.getState().history(madeKey, store().entries[madeKey].epoch).done;
    expect(steps).toHaveLength(1);
    expect(steps[0].state).toBe('saved');
  });

  it('U4: a queued PUT that conflicts sends only the fields it was for: an outside change of another field stays', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), notes: 'warm light' })); });
    const put = api.updateMoodboard.getMockImplementation()!;
    api.updateMoodboard.mockImplementationOnce(async () => {
      // Someone set made1's direction first.
      made.board = { ...made.board!, direction: 'cool', version: made.board!.version + 1 } as Moodboard;
      throw new MoodboardVersionConflict(clone(made.board));
    }).mockImplementation(put);
    await create.open();
    await waitFor(() => expect(made.board?.notes).toBe('warm light'));
    expect(made.board?.direction).toBe('cool');
    expect(made.puts.at(-1)).not.toHaveProperty('direction');
  });

  // Review 7, LOW-3: the queued send's and New's and a delete's mutants that survived.
  it('X3: a queued send that keeps conflicting stops after three tries, with the board\'s line', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    let tries = 0;
    api.editMoodboard.mockImplementation(async (id: string) => {
      if (id !== 'made1') throw new Error('unexpected');
      tries += 1;
      made.board = { ...made.board!, version: made.board!.version + 1 };
      throw new MoodboardVersionConflict(clone(made.board));
    });
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ saveState: 'error' }));
    expect(tries).toBe(3);
  });

  it('X6: a field the server cleans (a trimmed direction) is the person\'s as sent: the draft doesn\'t read it as a change', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), direction: 'warm dusk ' })); });
    await create.open();
    await waitFor(() => expect(made.puts).toHaveLength(1));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveState: 'saved' }));
    const draft = store().entries[madeKey].draft as { direction: string; base: { direction: string } };
    expect(made.board?.direction).toBe('warm dusk');
    expect(draft.base.direction).toBe(draft.direction);
  });

  it('X7: a project board\'s queued PUT names its project', async () => {
    const create = gate();
    const made = madeServer(create.held, 'p1');
    const uploads = holdUploads();
    await openNew('project');
    const projectNew = JSON.stringify(['moodboard', 'project', 'p1', 'new']);
    await waitFor(() => expect(store().entries[projectNew]?.loaded).toBe(true));
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    clickNew();
    await waitFor(() => expect(made.creates).toHaveLength(1));
    await uploads.open();
    act(() => { store().edit(projectNew, (draft) => ({ ...(draft as object), notes: 'warm light' })); });
    await create.open();
    await waitFor(() => expect(made.puts).toHaveLength(1));
    expect(made.puts[0]).toMatchObject({ notes: 'warm light', projectId: 'p1' });
  });

  it('X8: the queued send keeps the thumbnail its edit answered', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveState: 'saved' }));
    expect(store().entries[madeKey].thumbnail).toBe('/api/outputs/made1-v2.png');
  });

  it('X2: a board deleted while its queued send is out: the send stops, and nothing lands in the draft that replaced it', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    const edit = gate();
    const send = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementation(async (...args: Parameters<typeof send>) => { await edit.held; return send(...args); });
    act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), notes: 'warm light' })); });
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.pendingSaveId).toBeTruthy());
    // made1 goes; its key holds a fresh draft now.
    act(() => { store().reset(madeKey, fresh()); store().patch(madeKey, { loaded: true }); });
    await edit.open();
    await new Promise((done) => setTimeout(done, 30));
    expect(urlsOf(madeKey)).toEqual([]);
    expect(made.puts).toEqual([]);
  });

  it('X9: a delete whose save of an unsaved board fails keeps that board\'s draft', async () => {
    madeServer();
    removeAsset.fn = async () => true;
    await openStudio('board');
    act(() => {
      store().reset(newKey, { ...fresh('Kept'), images: [image('k1', { url: '/api/outputs/kept.png', placements: [card('k1')] })] });
      store().patch(newKey, { loaded: true });
    });
    api.createMoodboard.mockRejectedValue(new RequestFailedError("Couldn't save the board.", 500, { reason: "Nebula didn't respond. Try again." }));
    act(() => { screen.getByRole('button', { name: 'Delete' }).click(); });
    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 30));
    expect(urlsOf(newKey)).toEqual(['/api/outputs/kept.png']);
  });

  it('X10: New\'s save out while the person opens the new board of another scope: they stay there', async () => {
    const create = gate();
    madeServer(create.held);
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(store().entries[newKey]?.dirty || (store().entries[madeKey]?.savedId ?? null) !== null).toBe(true));
    clickNew();
    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalled());
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'project'); });
    await create.open();
    await new Promise((done) => setTimeout(done, 30));
    expect(useUIStore.getState()).toMatchObject({ moodboardEditorId: 'new', moodboardEditorScope: 'project' });
  });

  it('NIT-4: the cap drops earlier page loads\' records first, never this page\'s adds still on their way', async () => {
    const earlier = Array.from({ length: 60 }, (_, i) => ({ id: `old-${i}`, board: 'g9', name: `old-${i}.png`, page: 'before', at: Date.now() }));
    window.sessionStorage.setItem(PENDING, JSON.stringify(earlier));
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(records().some((it) => it.name === 'river.png')).toBe(true));
    expect(records()).toHaveLength(50);
    expect(records().filter((it) => it.page === 'before').map((it) => it.id)).toEqual(earlier.slice(11).map((it) => it.id));
    await uploads.open();
  });

  it('NIT-4: past the cap with this page\'s own adds, every one of them is kept', async () => {
    window.sessionStorage.setItem(PENDING, JSON.stringify([{ id: 'old', board: 'g9', name: 'old.png', page: 'before', at: Date.now() }]));
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: Array.from({ length: 52 }, (_, i) => png(`f${i}.png`)) }));
    await waitFor(() => expect(records().filter((it) => it.page !== 'before')).toHaveLength(52));
    expect(records().some((it) => it.page === 'before')).toBe(false);
    await uploads.open();
  });

  // Round 6d (review 8, MEDIUM-1): a resend owns what the refused send owned.
  it('R8-O1: a rename on the saved board while its queued send waits offline: the resend sends only the add, the rename goes as its own step', async () => {
    const create = gate();
    const made = madeServer(create.held);
    const madePut = api.updateMoodboard.getMockImplementation()!;
    const puts: Record<string, unknown>[] = [];
    api.updateMoodboard.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      const before = made.board?.name;
      const saved = await madePut(id, body);
      if (id !== 'made1') return saved;
      puts.push(body);
      return { ...saved, undo: { ops: [{ op: 'restore', slices: [{ part: 'fields', name: before }] }] } };
    });
    await newWithAdd(made);
    offline();
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true }));
    // The record kept for a reload is what the refused send owned: the add.
    expect(waiting()).toEqual([expect.objectContaining({ board: 'made1', fields: {}, ops: [expect.objectContaining({ op: 'add' })] })]);
    await toBoard('made1');
    const name = screen.getByDisplayValue(made.board!.name);
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'Rivers' } });
    fireEvent.blur(name);
    await new Promise((done) => setTimeout(done, 50));
    await online();
    await waitFor(() => expect(made.board?.name).toBe('Rivers'));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
    await new Promise((done) => setTimeout(done, 800));
    expect(made.edits.map((ops) => ops.map((op) => op.op))).toEqual([['add']]);
    expect(puts).toEqual([expect.objectContaining({ name: 'Rivers' })]);
    const steps = useBoardUndoStore.getState().history(madeKey, store().entries[madeKey].epoch).done;
    expect(steps.map((step) => [step.label, step.state])).toEqual([['Name', 'saved']]);
    expect(waiting()).toEqual([]);
  });

  it('R8-B: an away add refused offline, the person back on that board renames it offline, then reconnect: the resend sends only the add; the rename keeps its Undo', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
    const send = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementation(async (...args: Parameters<typeof send>) => {
      if (isBackendOffline()) throw new OfflineRefusal('POST', '/api/moodboards/g1/edit');
      return send(...args);
    });
    const put = api.updateMoodboard.getMockImplementation()!;
    api.updateMoodboard.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      if (isBackendOffline()) throw new OfflineRefusal('PUT', '/api/moodboards/g1');
      const before = server.board.name;
      const saved = await put(id, body);
      return { ...saved, undo: { ops: [{ op: 'restore', slices: [{ part: 'fields', name: before }] }] } };
    });
    offline();
    await uploads.open();
    await waitFor(() => expect(urlsOf(g1Key)).toContain(river));
    await toBoard('g1');
    const name = screen.getByDisplayValue('Global board');
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'Rivers' } });
    fireEvent.blur(name);
    // The board's own save of the rename is refused while still offline,
    // so on reconnect the away add's resend goes first (deterministic).
    await new Promise((done) => setTimeout(done, 50));
    expect(store().entries[g1Key]).toMatchObject({ pendingSaveId: null, dirty: true });
    await online();
    await waitFor(() => expect(server.board.name).toBe('Rivers'));
    await waitFor(() => expect(store().entries[g1Key]).toMatchObject({ dirty: false, pendingSaveId: null }));
    await new Promise((done) => setTimeout(done, 700));
    expect(server.edits.map((ops) => ops.map((op) => op.op))).toEqual([['add']]);
    expect(server.puts).toEqual([expect.objectContaining({ name: 'Rivers' })]);
    const steps = useBoardUndoStore.getState().history(g1Key, store().entries[g1Key].epoch).done;
    expect(steps.map((step) => [step.label, step.state])).toEqual([['Name', 'saved']]);
  });

  // Round 6d (review 8, MEDIUM-2): a background send cut off by a network drop.
  /** The banner's health probe, as BackendConnectionStatus answers one asked for: `answer`. */
  const probes = { active: 0 };
  const probeAnswers = (answer: 'online' | 'offline') => {
    const asked = { count: 0 };
    probes.active += 1;
    const unsubscribe = subscribeHealthProbeRequests(() => {
      asked.count += 1;
      act(() => { noteProbeAnswer(startHealthProbe(), answer); });
    });
    return { asked, stop: () => { probes.active -= 1; unsubscribe(); } };
  };
  /** A banner that finds Nebula online whenever a test hasn't said what its probe answers (round 6g: a cut-off
   *  create probes before it says the line), so the test doesn't sit out probeOffline's 5 s timeout. */
  const probesOnline = () => subscribeHealthProbeRequests(() => {
    if (!probes.active) act(() => { noteProbeAnswer(startHealthProbe(), 'online'); });
  });
  /** What apiFetch throws for a request that got no answer (lib/backend). */
  const dropped = () => new ConnectionLostError(new TypeError('Failed to fetch'));

  it('a queued send cut off by a network drop, and the probe finds Nebula offline: no line, it waits, and goes once on reconnect', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    made.fail = dropped();
    const probe = probeAnswers('offline');
    try {
      await create.open();
      await waitFor(() => expect(made.editsTried).toBe(1));
      await waitFor(() => expect(isBackendOffline()).toBe(true));
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true, saveState: 'draft', saveError: null }));
      expect(probe.asked.count).toBe(1);
      expect(waiting()).toEqual([expect.objectContaining({ board: 'made1', ops: [expect.objectContaining({ op: 'add' })] })]);
      made.fail = null;
    } finally { probe.stop(); }
    await online();
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, saveState: 'saved', saveError: null }));
    expect(made.editsTried).toBe(2);
    expect(made.edits).toHaveLength(1);
    expect(waiting()).toEqual([]);
  });

  it('a queued send cut off while the probe finds Nebula online: the board\'s neutral line (round 6f), and nothing kept', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    made.fail = dropped();
    const probe = probeAnswers('online');
    try {
      await create.open();
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ saveState: 'error', retry: 'save' }));
      expect(probe.asked.count).toBe(1);
    } finally { probe.stop(); }
    expect(store().entries[madeKey].saveError).toEqual({ heading: '', reason: 'Nebula couldn’t save the board because the server isn’t answering. Try again.' });
    expect(waiting()).toEqual([]);
    await new Promise((done) => setTimeout(done, 50));
    expect(made.editsTried).toBe(1);
    await toBoard('made1');
    await screen.findByText('Nebula couldn’t save the board because the server isn’t answering. Try again.');
    expect(document.querySelector('.moodboard-studio__notice--neutral')).not.toBeNull();
    expect(document.querySelector('.moodboard-studio__notice--error')).toBeNull();
    expect(document.querySelector('.moodboard-studio-toolbar__state')!.textContent).toBe('Not saved');
  });

  it('a resend on reconnect cut off by a drop is a failure: the board\'s neutral line says why, without waiting on a probe', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    offline();
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true }));
    made.fail = dropped();
    const probe = probeAnswers('offline');
    try {
      await online();
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ saveState: 'error',
        saveError: { heading: '', reason: 'Nebula couldn’t save the board because the server isn’t answering. Try again.' } }));
      expect(probe.asked.count).toBe(0);
    } finally { probe.stop(); }
  });

  it('an add that couldn\'t reach the board the person left, cut off by a drop with Nebula then offline: no line; back online it goes once', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
    const send = api.editMoodboard.getMockImplementation()!;
    let cut = true;
    api.editMoodboard.mockImplementation(async (...args: Parameters<typeof send>) => {
      if (isBackendOffline()) throw new OfflineRefusal('POST', '/api/moodboards/g1/edit');
      if (cut) { cut = false; throw dropped(); }
      return send(...args);
    });
    const probe = probeAnswers('offline');
    try {
      await uploads.open();
      await waitFor(() => expect(urlsOf(g1Key)).toContain(river));
      await waitFor(() => expect(isBackendOffline()).toBe(true));
      await waitFor(() => expect(waiting()).toEqual([expect.objectContaining({ board: 'g1', fields: {} })]));
      expect(store().entries[g1Key]).toMatchObject({ saveError: null, dirty: true });
    } finally { probe.stop(); }
    expect(server.edits).toEqual([]);
    await online();
    await waitFor(() => expect(server.board.images.map((img) => img.url)).toContain(river));
    await waitFor(() => expect(store().entries[g1Key]).toMatchObject({ dirty: false, saveError: null }));
    expect(addOps()).toHaveLength(1);
    expect(waiting()).toEqual([]);
  });

  it('an add that couldn\'t reach the board the person left, cut off with Nebula still online: that board says why', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
    api.editMoodboard.mockImplementation(async () => { throw dropped(); });
    const probe = probeAnswers('online');
    try {
      await uploads.open();
      await waitFor(() => expect(store().entries[g1Key]).toMatchObject({ saveState: 'error', retry: 'save',
        saveError: { heading: '', reason: 'Nebula couldn’t save the board because the server isn’t answering. Try again.' } }));
      expect(probe.asked.count).toBe(1);
    } finally { probe.stop(); }
    expect(waiting()).toEqual([]);
  });

  it('an add that saves an unsaved board the person left, its create cut off with Nebula then offline: no line; back online the board is saved once', async () => {
    const made = madeServer();
    const create = api.createMoodboard.getMockImplementation()!;
    let cut = true;
    api.createMoodboard.mockImplementation(async (body: Partial<Moodboard>) => {
      if (!isBackendOffline() && cut) { cut = false; throw dropped(); }
      return create(body);
    });
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    const probe = probeAnswers('offline');
    try {
      await uploads.open();
      await waitFor(() => expect(isBackendOffline()).toBe(true));
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveError: null, pendingSaveId: null, savedId: null, dirty: true }));
    } finally { probe.stop(); }
    expect(made.creates).toEqual([]);
    await online();
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
    expect(made.creates).toHaveLength(1);
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ saveError: null }));
  });

  it('a queued send the dev proxy answers 502 (the backend gone), with the probe then offline: no line, it waits', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    made.fail = new RequestFailedError("Couldn't save the board.", 502, {});
    const probe = probeAnswers('offline');
    try {
      await create.open();
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true, saveState: 'draft', saveError: null }));
      expect(probe.asked.count).toBe(1);
    } finally { probe.stop(); }
    expect(waiting()).toHaveLength(1);
  });

  it('New\'s own save cut off by a drop, the probe finding Nebula online: the neutral save line (round 6g: a create probes as a background send)', async () => {
    madeServer();
    api.createMoodboard.mockImplementation(async () => { throw dropped(); });
    const probe = probeAnswers('online');
    try {
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', retry: 'save',
        saveError: { heading: '', reason: 'Nebula couldn’t save the board because the server isn’t answering. Try again.' } }));
      // Each cut-off create (the autosave's, then New's own) asked the banner once.
      expect(probe.asked.count).toBe(api.createMoodboard.mock.calls.length);
      expect(probe.asked.count).toBeGreaterThanOrEqual(1);
    } finally { probe.stop(); }
  });

  // Round 6g (GM r15 4): a create that loses the network is a background send.
  describe('round 6g: a create cut off by a network drop', () => {

    /** made1's server behind the real fetch's offline check: a create while offline is refused unsent; `cut`
     *  creates lose their answer (the first `cut.made` of them made the board); the rest are answered. */
    const cutServer = (cut: { count: number }) => {
      const made = madeServer();
      const create = api.createMoodboard.getMockImplementation()!;
      const sent: Array<{ requestId?: string; attempt?: number }> = [];
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string; attempt?: number }) => {
        if (isBackendOffline()) throw new OfflineRefusal('POST', '/api/moodboards');
        sent.push({ requestId: body.requestId, attempt: body.attempt });
        if (cut.count > 0) { cut.count -= 1; throw dropped(); }
        return create(body);
      });
      return { made, sent };
    };

    it('the probe finds Nebula offline: no line, it waits, and on reconnect goes once more with the same id, as a later attempt', async () => {
      const { made, sent } = cutServer({ count: 1 });
      const probe = probeAnswers('offline');
      try {
        await openNew();
        paste(clipboard({ files: [png('river.png')] }));
        await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
        clickNew();
        await waitFor(() => expect(isBackendOffline()).toBe(true));
        await waitFor(() => expect(store().entries[newKey]).toMatchObject({ pendingSaveId: null, dirty: true, saveState: 'draft', saveError: null }));
        expect(probe.asked.count).toBe(1);
        expect(document.querySelector('.moodboard-studio__notice')).toBeNull();
      } finally { probe.stop(); }
      expect(sent).toHaveLength(1);
      await online();
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ savedId: 'made1', saveError: null }));
      // Sent once more on reconnect: the same id, a later attempt, one board.
      expect(sent).toHaveLength(2);
      expect(sent[1].requestId).toBe(sent[0].requestId);
      expect(sent[1].attempt).toBeGreaterThan(sent[0].attempt!);
      expect(made.creates).toHaveLength(1);
    });

    it('the resend on reconnect cut off too: the neutral line and "Not saved", without waiting a second time', async () => {
      const { sent } = cutServer({ count: 2 });
      const probe = probeAnswers('offline');
      try {
        await openNew();
        paste(clipboard({ files: [png('river.png')] }));
        await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
        await waitFor(() => expect(isBackendOffline()).toBe(true));
        await waitFor(() => expect(store().entries[newKey]).toMatchObject({ pendingSaveId: null, dirty: true, saveState: 'draft', saveError: null }));
        expect(probe.asked.count).toBe(1);
        await online();
        await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', retry: 'save',
          saveError: { heading: '', reason: 'Nebula couldn’t save the board because the server isn’t answering. Try again.' } }));
        // The resend's loss is a failure: no second probe, no second wait.
        expect(probe.asked.count).toBe(1);
        expect(sent).toHaveLength(2);
        expect(document.querySelector('.moodboard-studio-toolbar__state')!.textContent).toBe('Not saved');
      } finally { probe.stop(); }
    });

    it('a 5xx is not a lost answer: it says the line at once, with no probe', async () => {
      madeServer();
      api.createMoodboard.mockRejectedValue(new RequestFailedError("Couldn't save the board.", 500, { reason: 'boom' }));
      const probe = probeAnswers('offline');
      try {
        await openNew();
        paste(clipboard({ files: [png('river.png')] }));
        await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
        clickNew();
        await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error',
          saveError: { heading: '', reason: 'Nebula couldn’t save the board because the server hit an error. Try again.' } }));
        expect(probe.asked.count).toBe(0);
      } finally { probe.stop(); }
    });
  });

  it('an away add cut off while the probe is slow, sent meanwhile by the board\'s own save (the person came back): no line after all', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('new');
    const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
    const send = api.editMoodboard.getMockImplementation()!;
    let cut = true;
    api.editMoodboard.mockImplementation(async (...args: Parameters<typeof send>) => {
      if (cut) { cut = false; throw dropped(); }
      return send(...args);
    });
    let answer: () => void = () => {};
    const stop = subscribeHealthProbeRequests(() => { answer = () => act(() => { noteProbeAnswer(startHealthProbe(), 'online'); }); });
    try {
      await uploads.open();
      await waitFor(() => expect(urlsOf(g1Key)).toContain(river));
      await toBoard('g1');
      await waitFor(() => expect(server.board.images.map((img) => img.url)).toContain(river));
      await waitFor(() => expect(store().entries[g1Key]).toMatchObject({ dirty: false, pendingSaveId: null }));
      answer();
      await new Promise((done) => setTimeout(done, 30));
      expect(store().entries[g1Key]).toMatchObject({ saveError: null, saveState: 'saved' });
    } finally { stop(); }
  });

  // Round 6d (review 8, LOW-2): the attempt guards, the fields-only record, the lost records.
  it('Y10: a refusal that comes back after the board was deleted (its key reset) leaves the fresh draft alone', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    const edit = gate();
    api.editMoodboard.mockImplementation(async () => { await edit.held; throw new OfflineRefusal('POST', '/api/moodboards/made1/edit'); });
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.pendingSaveId).toBeTruthy());
    act(() => { store().reset(madeKey, fresh()); store().patch(madeKey, { loaded: true }); });
    offline();
    await edit.open();
    await new Promise((done) => setTimeout(done, 30));
    expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null });
    expect(waiting()).toEqual([]);
  });

  it('Y27: a refused create that comes back after its draft was reset leaves the fresh draft alone', async () => {
    madeServer();
    const create = gate();
    api.createMoodboard.mockImplementation(async () => { await create.held; throw new OfflineRefusal('POST', '/api/moodboards'); });
    const uploads = holdUploads();
    await openNew();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    await uploads.open();
    await waitFor(() => expect(store().entries[newKey]?.pendingSaveId).toBeTruthy());
    act(() => { store().reset(newKey, fresh()); store().patch(newKey, { loaded: true }); });
    offline();
    await create.open();
    await new Promise((done) => setTimeout(done, 30));
    expect(store().entries[newKey]).toMatchObject({ dirty: false, pendingSaveId: null });
  });

  it('Y19: the open board\'s refused save coming back after its draft was reset leaves the fresh draft alone', async () => {
    await openStudio('board');
    const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
    const edit = gate();
    api.editMoodboard.mockImplementation(async () => { await edit.held; throw new OfflineRefusal('POST', '/api/moodboards/g1/edit'); });
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(store().entries[g1Key]?.pendingSaveId).toBeTruthy());
    act(() => { store().reset(g1Key, fresh()); store().patch(g1Key, { loaded: true }); });
    offline();
    await edit.open();
    await new Promise((done) => setTimeout(done, 30));
    expect(store().entries[g1Key]).toMatchObject({ dirty: false, pendingSaveId: null });
  });

  it('Y11: a queued send left with only a field to send when Nebula went offline keeps it for a reload', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), notes: 'warm light' })); });
    // The edit lands; Nebula goes offline before the PUT.
    const edit = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementation(async (...args: Parameters<typeof edit>) => {
      const answer = await edit(...args);
      noteBackendConnection('offline');
      return answer;
    });
    await create.open();
    await waitFor(() => expect(made.edits).toHaveLength(1));
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true, saveError: null }));
    expect(waiting()).toEqual([expect.objectContaining({ board: 'made1', ops: [], fields: { notes: 'warm light' } })]);
    await online();
    await waitFor(() => expect(made.board?.notes).toBe('warm light'));
    expect(waiting()).toEqual([]);
  });

  it('D5: the record kept for a reload is what the refused send owned, not what the draft gained while it was out', async () => {
    const create = gate();
    const made = madeServer(create.held);
    await newWithAdd(made);
    const edit = gate();
    api.editMoodboard.mockImplementation(async () => { await edit.held; throw new OfflineRefusal('POST', '/api/moodboards/made1/edit'); });
    await create.open();
    await waitFor(() => expect(store().entries[madeKey]?.pendingSaveId).toBeTruthy());
    // A change while the send is out: not the send's.
    act(() => { store().edit(madeKey, (draft) => ({ ...(draft as object), notes: 'later' })); });
    offline();
    await edit.open();
    await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true }));
    expect(waiting()).toEqual([expect.objectContaining({ board: 'made1', fields: {}, ops: [expect.objectContaining({ op: 'add' })] })]);
  });

  it('NIT-4: a record left with nothing once its malformed ops are dropped isn\'t written back', () => {
    window.sessionStorage.setItem(WAITING, JSON.stringify([{ board: 'x', page: 'before', at: Date.now(), fields: {}, ops: [{}] }]));
    keepWaitingSend('made1', [{ op: 'add', images: [{ id: 'k', url: '/api/outputs/k.png' }], at: { x: 0, y: 0 } }], {});
    expect(waiting().map((it) => it.board)).toEqual(['made1']);
  });

  it('Y13: a send that landed takes its unstorable images\' reload records with it', () => {
    keepWaitingSend('made1', [{ op: 'add', images: [{ id: 'b', url: 'blob:http://localhost/only-here.png' }], at: { x: 0, y: 0 } }], {});
    expect(records()).toEqual([expect.objectContaining({ board: 'made1', name: 'only-here.png' })]);
    dropWaitingSend('made1');
    expect(records()).toEqual([]);
    expect(waiting()).toEqual([]);
  });

  it('Y23: a data: image is no image a reload can add: it isn\'t stored, and the reload line names it', () => {
    keepWaitingSend('made1', [{ op: 'add', images: [{ id: 'd', url: 'data:image/png;base64,iVBORw0KGgo=' }], at: { x: 0, y: 0 } }], {});
    expect(waiting()).toEqual([]);
    expect(records()).toHaveLength(1);
    expect(window.sessionStorage.getItem(WAITING) ?? '').not.toContain('data:image');
  });

  it('Y15: a waiting add the board holds under another id (same image) isn\'t sent again', async () => {
    const made = madeServer();
    made.board = { ...clone(server.board), id: 'made1', version: 2,
      images: [image('server-id', { url: river, placements: [card('server-id')] })] } as Moodboard;
    keepWaitingSend('made1', [{ op: 'add', images: [{ id: 'client-id', url: river }], at: { x: 0, y: 0 } }], {});
    window.sessionStorage.setItem(WAITING, JSON.stringify(waiting().map((it) => ({ ...it, page: 'before' }))));
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('made1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await waitFor(() => expect(store().entries[madeKey]?.loaded).toBe(true));
    await new Promise((done) => setTimeout(done, 700));
    expect(made.editsTried).toBe(0);
    expect(made.board?.images).toHaveLength(1);
  });

  it('NIT-4 (review 8): a waiting record\'s op that isn\'t an op Nebula makes is dropped; the rest is sent', async () => {
    const made = madeServer();
    made.board = { ...clone(server.board), id: 'made1', images: [], version: 1 } as Moodboard;
    const good = { op: 'add', images: [{ id: 'kept', url: '/api/outputs/kept.png' }], at: { x: 0, y: 0 } };
    window.sessionStorage.setItem(WAITING, JSON.stringify([{ board: 'made1', page: 'before', at: Date.now(), fields: {},
      ops: [{}, { op: 'add' }, { op: 'add', images: [{ id: 'x' }] }, { op: 'place', placement: 'p', x: 'far', y: 0 },
        { op: 'drop-table' }, null, good] },
    { board: 'made1', page: 'before', at: Date.now(), fields: {}, ops: [{ op: 'weight', image: 'kept' }] }]));
    expect(waiting()).toHaveLength(2);
    useBoardCanvasStore.setState({ view: 'board' });
    act(() => { useUIStore.getState().enterMoodboardEditor('made1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual(['/api/outputs/kept.png']));
    expect(made.edits).toEqual([[expect.objectContaining({ op: 'add', images: [expect.objectContaining({ url: '/api/outputs/kept.png' })] })]]);
    expect(waiting()).toEqual([]);
  });

  it('NIT-1: the reload line goes when the person leaves its board; a quick return doesn\'t show it again', async () => {
    window.sessionStorage.setItem(PENDING, JSON.stringify([{ id: 'r', board: 'g1', name: 'river.png', page: 'before', at: Date.now() }]));
    await openStudio('board');
    const line = '“river.png” wasn’t added because the page reloaded while it uploaded. Paste it again.';
    await screen.findByText(line);
    await toBoard('new');
    await toBoard('g1');
    await screen.findByDisplayValue('Global board');
    await new Promise((done) => setTimeout(done, 30));
    expect(screen.queryByText(line)).toBeNull();
  });

  // Round 6e: a create carries the unsaved board's id, so one sent again after
  // its answer was lost returns the board the first one made.
  describe('round 6e: a create sent again makes one board', () => {
    let quiet: () => void = () => {};
    beforeEach(() => { quiet = probesOnline(); });
    afterEach(() => { quiet(); });
    const lake = '/api/outputs/chat-uploads/lake.png';
    const requestIds = () => api.createMoodboard.mock.calls.map((call) => (call[0] as { requestId?: string }).requestId);
    /** made1's server, answering a create it has seen (by requestId) with that board as it is now, marked
     *  `repeated`; the next create that makes a board has its answer lost (`cut`); an add of an image the
     *  board has is skipped, as the server skips it. */
    const onceServer = (made: ReturnType<typeof madeServer>, cut: { next: boolean; hold?: Promise<void> }) => {
      const create = api.createMoodboard.getMockImplementation()!;
      // Each id's record: the attempt that made the board and its version then (round 6g).
      const seen = new Map<string, { attempt: number | null; version: number }>();
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string; attempt?: number }) => {
        if (isBackendOffline()) throw new OfflineRefusal('POST', '/api/moodboards');
        const record = body.requestId ? seen.get(body.requestId) : undefined;
        if (record) return { ...clone(made.board!), repeated: true, madeAttempt: record.attempt, madeVersion: record.version };
        const answer = await create(body);
        if (body.requestId) seen.set(body.requestId, { attempt: body.attempt ?? null, version: answer.version });
        if (cut.next) { cut.next = false; if (cut.hold) await cut.hold; throw dropped(); }
        return answer;
      });
      const edit = api.editMoodboard.getMockImplementation()!;
      api.editMoodboard.mockImplementation(async (id: string, ops: MoodboardOp[], base?: number) => edit(id, id !== 'made1' ? ops
        : ops.map((op) => (op.op === 'add' ? { ...op, images: op.images.filter((img) => !made.board!.images.some((have) => have.id === img.id)) } : op))
          .filter((op) => op.op !== 'add' || op.images.length > 0), base));
    };

    it('an add that saves a board the person left, the create made on the server but its answer lost: sent again on reconnect, one board', async () => {
      const made = madeServer();
      onceServer(made, { next: true });
      const uploads = holdUploads();
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(board.placeholders).toHaveLength(1));
      await toBoard('g1');
      await screen.findByDisplayValue('Global board');
      const probe = probeAnswers('offline');
      try {
        await uploads.open();
        await waitFor(() => expect(isBackendOffline()).toBe(true));
        await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveError: null, pendingSaveId: null, savedId: null, dirty: true }));
      } finally { probe.stop(); }
      // The first send made the board; its answer never came back.
      expect(made.creates).toHaveLength(1);
      await online();
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ savedId: 'made1', saveError: null }));
      expect(api.createMoodboard).toHaveBeenCalledTimes(2);
      const [first, again] = requestIds();
      expect(first).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      expect(again).toBe(first);
      expect(made.creates).toHaveLength(1);
      expect(made.board?.images.map((img) => img.url)).toEqual([river]);
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
    });

    it('New\'s save whose answer was lost, an image added while it was out: sent again, the same board, and the new image goes on it', async () => {
      const made = madeServer();
      const held = gate();
      onceServer(made, { next: true, hold: held.held });
      await newWithAdd(made);
      await held.open();
      // The first send went with no image (river was still uploading) and made the board.
      expect(made.creates).toEqual([expect.objectContaining({ images: [] })]);
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error',
        saveError: { heading: '', reason: 'Nebula couldn’t save the board because the server isn’t answering. Try again.' } }));
      // The person's Retry sends it again.
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river]));
      expect(made.creates).toHaveLength(1);
      expect(api.createMoodboard.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(new Set(requestIds()).size).toBe(1);
      // The repeat's board lacked the second image: it went as an edit, not lost in the rebase.
      expect(made.edits.flat().filter((op) => op.op === 'add').flatMap((op) => (op as Extract<MoodboardOp, { op: 'add' }>).images.map((img) => img.url)))
        .toEqual([river]);
      await waitFor(() => expect(urlsOf(madeKey)).toEqual([river]));
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null, saveError: null }));
    });

    it('a repeat whose name differs from the draft\'s (renamed while the create was out) sends the name next', async () => {
      const made = madeServer();
      const held = gate();
      onceServer(made, { next: true, hold: held.held });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(made.creates).toHaveLength(1));
      act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: 'Dusk' })); });
      await held.open();
      await waitFor(() => expect(made.board?.name).toBe('Dusk'));
      expect(made.creates).toHaveLength(1);
      expect(made.creates[0]).toMatchObject({ name: 'Untitled Moodboard' });
      expect(made.puts).toEqual([expect.objectContaining({ name: 'Dusk' })]);
      expect(api.createMoodboard.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(new Set(requestIds()).size).toBe(1);
    });

    it('a repeat naming no attempt of this draft\'s (an older Nebula, or an agent\'s create): it takes the board as it is and replays all (round 6g)', async () => {
      const made = madeServer();
      const held = gate();
      onceServer(made, { next: true, hold: held.held });
      const repeat = api.createMoodboard.getMockImplementation()!;
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string; attempt?: number }) => {
        const answer = await repeat(body);
        return (answer as { repeated?: boolean }).repeated ? { ...answer, madeAttempt: null, madeVersion: undefined } : answer;
      });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(made.creates).toHaveLength(1));
      act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: 'Dusk' })); });
      // An agent adds an image to the board the lost create made.
      made.board = { ...made.board!, version: made.board!.version + 1,
        images: [...made.board!.images, image('agent1', { url: '/api/outputs/agent1.png', placements: [card('agent1', 2000, 0)] })] } as Moodboard;
      await held.open();
      await waitFor(() => expect(made.board?.name).toBe('Dusk'));
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ savedId: 'made1', dirty: false, pendingSaveId: null, saveError: null }));
      expect(made.creates).toHaveLength(1);
      // Every edit of it is checked against the version the repeat answered, never sent unchecked.
      const madeEdits = api.editMoodboard.mock.calls.filter((call) => call[0] === 'made1');
      expect(madeEdits.length).toBeGreaterThan(0);
      expect(madeEdits.every((call) => typeof call[2] === 'number')).toBe(true);
      // The board as it is: the agent's image is in the Studio's draft too.
      expect(urlsOf(madeKey)).toEqual(expect.arrayContaining([river, '/api/outputs/agent1.png']));
      // Rebased on the board: the rename goes alone, checked against the board's version, not every field unchecked.
      expect(made.puts).toHaveLength(1);
      expect(Object.keys(made.puts[0]).sort()).toEqual(['baseVersion', 'name']);
      expect(made.puts[0]).toMatchObject({ name: 'Dusk', baseVersion: expect.any(Number) });
      // On the board: its version and base are the board's, so the next save is checked against it.
      const draft = store().entries[madeKey].draft as { version?: number; base?: { name?: string } };
      expect(draft.version).toBe(made.board!.version);
      expect(draft.base?.name).toBe('Dusk');
    });

    it('every send of one draft carries the same id; a fresh draft gets its own', async () => {
      madeServer();
      api.createMoodboard.mockRejectedValue(new RequestFailedError("Couldn't save the board.", 500, { reason: "Nebula didn't respond. Try again." }));
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(store().entries[newKey]?.saveState).toBe('error'));
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(api.createMoodboard.mock.calls.length).toBeGreaterThanOrEqual(2));
      await waitFor(() => expect(store().entries[newKey]?.saveState).toBe('error'));
      const before = requestIds();
      expect(before[0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      expect(new Set(before)).toEqual(new Set([before[0]]));
      act(() => { store().reset(newKey, fresh()); store().patch(newKey, { loaded: true }); });
      expect(store().entries[newKey].createRequestId).toBeUndefined();
      paste(clipboard({ files: [png('lake.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([lake]));
      clickNew();
      await waitFor(() => expect(api.createMoodboard.mock.calls.length).toBeGreaterThan(before.length));
      const after = requestIds().slice(before.length);
      expect(after[0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      expect(after[0]).not.toBe(before[0]);
      expect(new Set(after)).toEqual(new Set([after[0]]));
    });

    // Round 6g (review 9 MEDIUM-1, GM r15 1): a repeat rebases on the attempt that made the board.
    it('R9-A: the board renamed and its image taken off before the resend: the board\'s changes stay, nothing is replayed over them', async () => {
      const made = madeServer();
      onceServer(made, { next: true });
      const answer = api.createMoodboard.getMockImplementation()!;
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string }) => {
        // Between the lost answer and the resend, someone (the person on the rail, an agent) works on made1.
        if (made.creates.length === 1 && made.board) {
          made.board = { ...made.board, name: 'Rivers', images: [], version: made.board.version + 2 } as Moodboard;
        }
        return answer(body);
      });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(api.createMoodboard.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ savedId: 'made1', pendingSaveId: null, dirty: false }), { timeout: 4000 });
      await new Promise((done) => setTimeout(done, 100));
      expect(made.board?.name).toBe('Rivers');
      expect(made.board?.images).toEqual([]);
      expect(made.edits).toEqual([]);
      expect(made.puts).toEqual([]);
      expect(urlsOf(madeKey)).toEqual([]);
      expect((store().entries[madeKey].draft as { name: string }).name).toBe('Rivers');
      // Nothing of the draft's was dropped (it made no edit after the attempt): no line.
      expect(store().entries[madeKey].notice ?? null).toBeNull();
      // Both sends carried the same id, each its own attempt.
      expect(api.createMoodboard.mock.calls.map((call) => (call[0] as { attempt?: number }).attempt)).toEqual([1, 2]);
    });

    it('R9-B: renamed on the rail while the unsaved board said Not saved; Retry keeps the rename and the open board\'s own draft', async () => {
      const made = madeServer();
      onceServer(made, { next: true });
      const answer = api.createMoodboard.getMockImplementation()!;
      let busy = true;
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string }) => {
        if (made.creates.length === 1 && busy) throw new RequestFailedError("Couldn't save the board.", 503, { detail: 'Busy' });
        return answer(body);
      });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', savedId: null }), { timeout: 4000 });
      expect(made.creates).toHaveLength(1);
      await toBoard('made1');
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ loaded: true }));
      act(() => { store().edit(madeKey, (draft) => ({ ...(draft as object), name: 'Rivers' })); });
      await waitFor(() => expect(made.board?.name).toBe('Rivers'), { timeout: 4000 });
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
      const epoch = store().entries[madeKey].epoch;
      busy = false;
      await toBoard('new');
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(api.createMoodboard.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 4000 });
      await new Promise((done) => setTimeout(done, 1200));
      expect(made.board?.name).toBe('Rivers');
      expect(made.puts).toEqual([expect.objectContaining({ name: 'Rivers' })]);
      expect((store().entries[madeKey].draft as { name: string }).name).toBe('Rivers');
      // made1's own draft stayed (its epoch, so its Undo): the unsaved one was folded in, not put over it.
      expect(store().entries[madeKey].epoch).toBe(epoch);
      expect(urlsOf(madeKey)).toEqual([river]);
    });

    it('R9-B with what the unsaved board still had to send (an image, its notes): folded into the open board\'s draft and sent from it', async () => {
      const made = madeServer();
      onceServer(made, { next: true });
      const answer = api.createMoodboard.getMockImplementation()!;
      let busy = true;
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string }) => {
        if (made.creates.length === 1 && busy) throw new RequestFailedError("Couldn't save the board.", 503, { detail: 'Busy' });
        return answer(body);
      });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', savedId: null }), { timeout: 4000 });
      await toBoard('made1');
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ loaded: true }));
      act(() => { store().edit(madeKey, (draft) => ({ ...(draft as object), name: 'Rivers' })); });
      await waitFor(() => expect(made.board?.name).toBe('Rivers'), { timeout: 4000 });
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null }));
      const epoch = store().entries[madeKey].epoch;
      await toBoard('new');
      // Still unsaved: an image and notes added to it.
      paste(clipboard({ files: [png('lake.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river, lake]));
      act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), notes: 'from the unsaved board' })); });
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error' }), { timeout: 4000 });
      busy = false;
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river, lake]), { timeout: 4000 });
      await waitFor(() => expect(made.board?.notes).toBe('from the unsaved board'), { timeout: 4000 });
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null, saveError: null }));
      expect(made.board?.name).toBe('Rivers');
      expect(made.creates).toHaveLength(1);
      expect(store().entries[madeKey].epoch).toBe(epoch);
      expect(urlsOf(madeKey)).toEqual([river, lake]);
      expect((store().entries[madeKey].draft as { notes: string; name: string })).toMatchObject({ notes: 'from the unsaved board', name: 'Rivers' });
    });

    it('R9-B with the open board\'s own rename still out when the repeat lands: its draft keeps it, never put over (review 9 R9-B)', async () => {
      const made = madeServer();
      onceServer(made, { next: true });
      const answer = api.createMoodboard.getMockImplementation()!;
      let busy = true;
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string }) => {
        if (made.creates.length === 1 && busy) throw new RequestFailedError("Couldn't save the board.", 503, { detail: 'Busy' });
        return answer(body);
      });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', savedId: null }), { timeout: 4000 });
      await toBoard('made1');
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ loaded: true }));
      // made1's rename goes out and its answer is held.
      const put = api.updateMoodboard.getMockImplementation()!;
      const held = gate();
      api.updateMoodboard.mockImplementation(async (id: string, body: Record<string, unknown>) => {
        if (id === 'made1') await held.held;
        return put(id, body);
      });
      act(() => { store().edit(madeKey, (draft) => ({ ...(draft as object), name: 'Rivers' })); });
      await waitFor(() => expect(store().entries[madeKey].pendingSaveId).not.toBeNull(), { timeout: 4000 });
      busy = false;
      await toBoard('new');
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(api.createMoodboard.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 4000 });
      await new Promise((done) => setTimeout(done, 300));
      // The repeat landed while the rename was out: made1's draft still has it.
      expect((store().entries[madeKey].draft as { name: string }).name).toBe('Rivers');
      await held.open();
      await waitFor(() => expect(made.board?.name).toBe('Rivers'));
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ dirty: false, pendingSaveId: null, saveError: null }), { timeout: 4000 });
      expect((store().entries[madeKey].draft as { name: string }).name).toBe('Rivers');
      expect(made.creates).toHaveLength(1);
    });

    /** New with river; its create made on the server and the answer lost; the next creates refused (503) while `busy`. */
    const lostThenBusy = async (made: ReturnType<typeof madeServer>, before?: () => void) => {
      onceServer(made, { next: true });
      const answer = api.createMoodboard.getMockImplementation()!;
      const state = { busy: true };
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string }) => {
        if (made.creates.length === 1 && state.busy && (body as { attempt?: number }).attempt !== 1) {
          throw new RequestFailedError("Couldn't save the board.", 503, { detail: 'Busy' });
        }
        return answer(body);
      });
      await openNew();
      if (before) act(before);
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', savedId: null }), { timeout: 4000 });
      expect(made.creates).toHaveLength(1);
      return state;
    };

    it('both renamed, the board later: the board\'s name stays and one neutral line says so', async () => {
      const made = madeServer();
      const state = await lostThenBusy(made);
      act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: 'Dusk' })); });
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error' }), { timeout: 4000 });
      made.board = { ...made.board!, name: 'Rivers', version: made.board!.version + 1, updatedAt: new Date(Date.now() + 60_000).toISOString() } as Moodboard;
      state.busy = false;
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ savedId: 'made1', pendingSaveId: null }), { timeout: 4000 });
      await new Promise((done) => setTimeout(done, 700));
      expect(made.board?.name).toBe('Rivers');
      expect(made.puts.some((put) => put.name === 'Dusk')).toBe(false);
      expect((store().entries[madeKey].draft as { name: string }).name).toBe('Rivers');
      const line = await screen.findByText('Kept the name “Rivers” from the board.');
      const notice = line.closest('.moodboard-studio__notice')!;
      expect(notice.className).toContain('moodboard-studio__notice--neutral');
      expect(notice.getAttribute('role')).toBe('status');
      // The next edit takes the line away.
      act(() => { store().edit(madeKey, (draft) => ({ ...(draft as object), notes: 'river light' })); });
      await waitFor(() => expect(screen.queryByText('Kept the name “Rivers” from the board.')).toBeNull());
    });

    it('name and notes changed on both, the board later: one line names both, joined with "and" (GM r16)', async () => {
      const made = madeServer();
      const state = await lostThenBusy(made);
      act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: 'Dusk', notes: 'draft light' })); });
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error' }), { timeout: 4000 });
      made.board = { ...made.board!, name: 'Rivers', notes: 'board light', version: made.board!.version + 1,
        updatedAt: new Date(Date.now() + 60_000).toISOString() } as Moodboard;
      state.busy = false;
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ savedId: 'made1', pendingSaveId: null }), { timeout: 4000 });
      const line = await screen.findByText('Kept the name and notes from the board.');
      expect(line.closest('.moodboard-studio__notice')!.className).toContain('moodboard-studio__notice--neutral');
      expect(made.board).toMatchObject({ name: 'Rivers', notes: 'board light' });
    });

    it('both renamed, the draft later: the draft\'s name goes on and nothing is said', async () => {
      const made = madeServer();
      const state = await lostThenBusy(made);
      made.board = { ...made.board!, name: 'Rivers', version: made.board!.version + 1, updatedAt: new Date(Date.now() - 60_000).toISOString() } as Moodboard;
      act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: 'Dusk' })); });
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error' }), { timeout: 4000 });
      state.busy = false;
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(made.board?.name).toBe('Dusk'), { timeout: 4000 });
      expect(made.puts).toEqual([expect.objectContaining({ name: 'Dusk' })]);
      expect(store().entries[madeKey].notice ?? null).toBeNull();
    });

    it('the board unchanged since it was made: the draft\'s later edits all go, whatever the clock says', async () => {
      const made = madeServer();
      const state = await lostThenBusy(made);
      made.board = { ...made.board!, updatedAt: new Date(Date.now() + 60_000).toISOString() } as Moodboard;
      act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: 'Dusk' })); });
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error' }), { timeout: 4000 });
      state.busy = false;
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(made.board?.name).toBe('Dusk'), { timeout: 4000 });
      expect(store().entries[madeKey].notice ?? null).toBeNull();
    });

    it('a field the server keeps differently from what was sent, the board unchanged since: no conflict, the draft\'s later edit goes (round 6g)', async () => {
      const made = madeServer();
      // Sent with notes the made board doesn't keep (this server makes the board with its own).
      const state = await lostThenBusy(made, () => { store().edit(newKey, (draft) => ({ ...(draft as object), notes: 'river light' })); });
      expect(made.creates[0]).toMatchObject({ notes: 'river light' });
      expect(made.board?.notes).not.toBe('river light');
      made.board = { ...made.board!, updatedAt: new Date(Date.now() + 60_000).toISOString() } as Moodboard;
      act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), notes: 'river dusk' })); });
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error' }), { timeout: 4000 });
      state.busy = false;
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(made.board?.notes).toBe('river dusk'), { timeout: 4000 });
      expect(store().entries[madeKey].notice ?? null).toBeNull();
    });

    it('a name sent with a space the server trims is no change of the board\'s: the draft\'s later rename goes, nothing is kept (round 6g)', async () => {
      const made = madeServer();
      const state = await lostThenBusy(made, () => { store().edit(newKey, (draft) => ({ ...(draft as object), name: 'Rivers ' })); });
      expect(made.board?.name).toBe('Rivers');
      // The board moved on since (an agent's notes, stamped later than any edit here), so the repeat checks each field it sent.
      made.board = { ...made.board!, notes: 'from an agent', version: made.board!.version + 1, updatedAt: new Date(Date.now() + 60_000).toISOString() } as Moodboard;
      act(() => { store().edit(newKey, (draft) => ({ ...(draft as object), name: 'Dusk' })); });
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error' }), { timeout: 4000 });
      state.busy = false;
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(made.board?.name).toBe('Dusk'), { timeout: 4000 });
      expect(made.board?.notes).toBe('from an agent');
      expect(store().entries[madeKey].notice ?? null).toBeNull();
    });

    it('New\'s save sent again (saveAway) with an image added while the lost create was out: that image goes on the board (review 9 R27)', async () => {
      const made = madeServer();
      const held = gate();
      onceServer(made, { next: true, hold: held.held });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(made.creates).toHaveLength(1));
      // An image added to the unsaved draft while that create is out (as an add lands: its op queued).
      act(() => { store().edit(newKey, (current) => {
        const draft = current as { images: MoodboardImage[]; pendingOps?: MoodboardOp[] };
        const op = { op: 'add', images: [{ id: 'lake1', url: lake }] } as MoodboardOp;
        return { ...draft, images: [...draft.images, image('lake1', { url: lake })], pendingOps: [...(draft.pendingOps ?? []), op] };
      }); });
      await held.open();
      // New again at once: its save (saveAway) sends the create again, before any autosave.
      clickNew();
      await waitFor(() => expect(made.board?.images.map((img) => img.url)).toEqual([river, lake]), { timeout: 4000 });
      expect(made.creates).toHaveLength(1);
      expect(api.createMoodboard.mock.calls.map((call) => (call[0] as { attempt?: number }).attempt)).toEqual([1, 2]);
      expect(made.edits.flat().filter((op) => op.op === 'add').flatMap((op) => (op as Extract<MoodboardOp, { op: 'add' }>).images.map((img) => img.url)))
        .toEqual([lake]);
    });

    it('a saved board\'s PUT never carries a create id', async () => {
      const made = madeServer();
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      clickNew();
      await waitFor(() => expect(made.creates).toHaveLength(1));
      expect(made.creates[0]).toHaveProperty('requestId');
      await toBoard('made1');
      act(() => { store().edit(madeKey, (draft) => ({ ...(draft as object), name: 'Renamed' })); });
      await waitFor(() => expect(made.puts.length).toBeGreaterThan(0));
      expect(made.puts.every((put) => !('requestId' in put))).toBe(true);
    });
  });

  // Round 6f (GM r14): a failed create loses nothing (the draft keeps it all, and the create is idempotent,
  // so Retry is safe), so it says what a failed background save says, in the same look.
  describe('round 6f: a failed create says what a failed save says (GM r14)', () => {
    let quiet: () => void = () => {};
    beforeEach(() => { quiet = probesOnline(); });
    afterEach(() => { quiet(); });
    const SAVE = "Couldn't save the board.";
    type Look = { line: string; neutral: boolean; chip: string; notSaved: boolean; retries: number; inLine: number; error: unknown };
    const lookOf = async (key: string, line: string): Promise<Look> => {
      const notice = (await screen.findByText(line)).closest('.moodboard-studio__notice')!;
      const chip = document.querySelector('.moodboard-studio-toolbar__state')!;
      return {
        line: notice.textContent ?? '',
        neutral: notice.className.includes('moodboard-studio__notice--neutral') && !notice.className.includes('--error')
          && notice.hasAttribute('data-line-neutral') && notice.getAttribute('role') === 'status',
        chip: chip.textContent ?? '',
        notSaved: chip.className.includes('moodboard-studio-toolbar__state--not-saved') && !chip.className.includes('--error'),
        retries: screen.queryAllByRole('button', { name: 'Retry' }).length,
        inLine: notice.querySelectorAll('button').length,
        error: store().entries[key].saveError,
      };
    };
    /** New's own save (a create) refused with `cause`: the line on the unsaved board. */
    const createLook = async (cause: () => unknown, line: string, retry: 'save' | 'reload' = 'save') => {
      madeServer();
      api.createMoodboard.mockImplementation(async () => { throw cause(); });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      clickNew();
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', retry, savedId: null }));
      expect(urlsOf(newKey)).toEqual([river]);
      const first = await lookOf(newKey, line);
      if (retry === 'reload') return first;
      // Its Retry is the board's own save (persist's create): the same line again.
      const sends = api.createMoodboard.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(api.createMoodboard.mock.calls.length).toBe(sends + 1));
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', retry: 'save', savedId: null }));
      expect(await lookOf(newKey, line)).toEqual(first);
      return first;
    };
    /** made1's background save (the resend on reconnect, r12's line) refused with `cause`. */
    const saveLook = async (cause: () => unknown, line: string, retry: 'save' | 'reload' = 'save') => {
      const create = gate();
      const made = madeServer(create.held);
      await newWithAdd(made);
      offline();
      await create.open();
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true }));
      made.fail = cause();
      await online();
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ saveState: 'error', retry }));
      await toBoard('made1');
      return lookOf(madeKey, line);
    };
    const fresh6f = () => {
      cleanup();
      useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
      resetBoardAdds();
      window.sessionStorage.removeItem(WAITING);
      window.sessionStorage.removeItem(PENDING);
    };
    const causes: Array<[string, () => unknown, string]> = [
      ['no answer (the connection dropped)', () => dropped(), 'the server isn’t answering'],
      ['a 502 with no words (the dev proxy, the backend gone)', () => new RequestFailedError(SAVE, 502, {}), 'the server isn’t answering'],
      ['429', () => new RequestFailedError(SAVE, 429, { detail: 'Too many requests' }), 'the server is busy'],
      ['408', () => new RequestFailedError(SAVE, 408, { detail: 'Timed out' }), 'the server didn’t respond'],
      ['503 with words', () => new RequestFailedError(SAVE, 503, { detail: 'Busy' }), 'the server didn’t respond'],
      ['504 with words', () => new RequestFailedError(SAVE, 504, { detail: 'Timed out upstream' }), 'the server didn’t respond'],
      ['500', () => new RequestFailedError(SAVE, 500, { detail: 'boom' }), 'the server hit an error'],
      ['400', () => new RequestFailedError(SAVE, 400, { detail: 'Bad board' }), 'the server didn’t accept this save'],
      ['a 422 on the content (not the id)', () => new RequestFailedError(SAVE, 422, { detail: 'name must be a string' }), 'the server didn’t accept this save'],
    ];
    // GM r16 7a: signed out, the step is a reload, so no Retry anywhere.
    it.each([
      ['401', () => new RequestFailedError(SAVE, 401, { detail: 'Connect again' })],
      ['403', () => new RequestFailedError(SAVE, 403, { detail: 'Not yours', code: 'person_required' })],
    ] as const)('%s: the create and the save say the signed-out line, neutral, with no Retry', async (_name, cause) => {
      const line = 'Nebula couldn’t save the board because you’re signed out. Open the link Nebula printed when it started.';
      const probe = probeAnswers('online');
      try {
        const created = await createLook(cause, line, 'reload');
        fresh6f();
        const saved = await saveLook(cause, line, 'reload');
        expect(created).toEqual(saved);
        expect(created).toEqual({ line, neutral: true, chip: 'Not saved', notSaved: true, retries: 0, inLine: 0,
          error: { heading: '', reason: line } });
        expect(created.line).not.toMatch(/Connect again|Not yours/);
      } finally { probe.stop(); }
    });

    it.each(causes)('%s: the create and the save give the same line and the same chip', async (_name, cause, because) => {
      const line = `Nebula couldn’t save the board because ${because}. Try again.`;
      const probe = probeAnswers('online');
      try {
        const created = await createLook(cause, line);
        fresh6f();
        const saved = await saveLook(cause, line);
        expect(created).toEqual(saved);
        expect(created).toEqual({ line, neutral: true, chip: 'Not saved', notSaved: true, retries: 1, inLine: 0,
          error: { heading: '', reason: line } });
        // Never "create": after a lost answer the server may have made the board.
        expect(`${created.line} ${created.chip}`).not.toMatch(/creat/i);
      } finally { probe.stop(); }
    });

    it('the autosave\'s create (no New pressed) gives the same line and chip', async () => {
      madeServer();
      api.createMoodboard.mockImplementation(async () => { throw new RequestFailedError(SAVE, 503, { detail: 'Busy' }); });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', retry: 'save', savedId: null }), { timeout: 4000 });
      const line = 'Nebula couldn’t save the board because the server didn’t respond. Try again.';
      expect(await lookOf(newKey, line)).toEqual({ line, neutral: true, chip: 'Not saved', notSaved: true, retries: 1, inLine: 0,
        error: { heading: '', reason: line } });
    });

    it('offline at send: neither the create nor the save says anything; both wait under the banner', async () => {
      madeServer();
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      await waitFor(() => expect(urlsOf(newKey)).toEqual([river]));
      offline();
      clickNew();
      await waitFor(() => expect(api.createMoodboard).toHaveBeenCalled());
      await new Promise((done) => setTimeout(done, 30));
      expect(store().entries[newKey]).toMatchObject({ saveError: null, savedId: null });
      expect(store().entries[newKey].saveState).not.toBe('error');
      expect(document.querySelector('.moodboard-studio__notice--neutral, .moodboard-studio__notice--error')).toBeNull();
      fresh6f();
      await online();
      const create = gate();
      const made = madeServer(create.held);
      await newWithAdd(made);
      offline();
      await create.open();
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ pendingSaveId: null, dirty: true, saveState: 'draft', saveError: null }));
      await toBoard('made1');
      expect(document.querySelector('.moodboard-studio__notice--neutral, .moodboard-studio__notice--error')).toBeNull();
    });

    it('an unsaved board whose create failed (a 5xx) comes back after a reload with its image, its line, "Not saved" and Retry; Retry makes one board (GM r15 3)', async () => {
      const made = madeServer();
      const create = api.createMoodboard.getMockImplementation()!;
      const refuse = { on: true };
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string }) => {
        if (refuse.on) throw new RequestFailedError(SAVE, 500, { reason: 'boom' });
        return create(body);
      });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      const line = 'Nebula couldn’t save the board because the server hit an error. Try again.';
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', saveError: { heading: '', reason: line } }));
      const first = api.createMoodboard.mock.calls[0][0] as { requestId?: string; attempt?: number };
      // The reload: a new page, its store empty, this tab's session storage kept.
      const stored = window.sessionStorage.getItem('nebula:moodboard-unsaved-drafts');
      expect(stored).not.toBeNull();
      cleanup();
      act(() => { useAssetStudioDraftStore.setState({ entries: {}, aliases: {} }); });
      window.sessionStorage.setItem('nebula:moodboard-unsaved-drafts', stored!);
      resetUnsavedDrafts();
      act(() => { restoreUnsavedDrafts(); });
      await openNew();
      expect(urlsOf(newKey)).toEqual([river]);
      expect(screen.getByText(line).closest('.moodboard-studio__notice')!.className).toContain('moodboard-studio__notice--neutral');
      expect(document.querySelector('.moodboard-studio-toolbar__state')!.textContent).toBe('Not saved');
      refuse.on = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ savedId: 'made1', saveError: null }));
      const again = api.createMoodboard.mock.calls.at(-1)![0] as { requestId?: string; attempt?: number };
      expect(again.requestId).toBe(first.requestId);
      expect(again.attempt).toBeGreaterThan(first.attempt!);
      expect(made.creates).toHaveLength(1);
      expect(made.board?.images.map((img) => img.url)).toEqual([river]);
      // Saved: nothing is kept for a reload any more.
      await waitFor(() => expect(window.sessionStorage.getItem('nebula:moodboard-unsaved-drafts')).toBeNull());
    });

    it('a 422 for the create\'s id says 7(b)\'s neutral line; its Retry goes without the id and saves (round 6g; GM r16 7b)', async () => {
      const made = madeServer();
      const create = api.createMoodboard.getMockImplementation()!;
      // The server refuses this id however often it is sent; a create without one it takes.
      api.createMoodboard.mockImplementation(async (body: Partial<Moodboard> & { requestId?: string }) => {
        if (body.requestId) throw new RequestFailedError(SAVE, 422, { detail: "requestId must be 8 to 128 letters, digits, '-' or '_'" });
        return create(body);
      });
      await openNew();
      paste(clipboard({ files: [png('river.png')] }));
      // The autosave's create is refused.
      await waitFor(() => expect(store().entries[newKey]).toMatchObject({ saveState: 'error', retry: 'save',
        saveError: { heading: '', reason: 'Nebula couldn’t save the board because the server didn’t accept this save. Try again.' }, createRequestId: null }));
      expect(document.querySelector('.moodboard-studio__notice--error')).toBeNull();
      expect(document.querySelector('.moodboard-studio__notice--neutral')).not.toBeNull();
      const chip = document.querySelector('.moodboard-studio-toolbar__state')!;
      expect(chip.textContent).toBe('Not saved');
      expect(document.querySelector('.moodboard-studio__notice--neutral')!.textContent).not.toMatch(/creat|requestId/i);
      expect(api.createMoodboard).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(store().entries[madeKey]).toMatchObject({ savedId: 'made1', saveError: null }));
      expect(api.createMoodboard).toHaveBeenCalledTimes(2);
      const again = api.createMoodboard.mock.calls[1][0] as { requestId?: string; attempt?: number };
      expect(again.requestId).toBeUndefined();
      expect(again.attempt).toBeUndefined();
      expect(made.creates).toHaveLength(1);
    });
  });
});

describe('round 6c: an add replayed after a 409 (GM r11 3)', () => {
  type Add = Extract<MoodboardOp, { op: 'add' }>;
  const rect = (card: MoodboardPlacement) => ({ x: card.x, y: card.y, width: card.w, height: card.h });
  /** The first edit answers 409: meanwhile another tab put a tile `w` x `h` exactly where the add was going. */
  const tileAtTheAdd = (w = 480, h = 270) => {
    const send = api.editMoodboard.getMockImplementation()!;
    const spots: Array<{ x: number; y: number }> = [];
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      const add = ops.find((op): op is Add => op.op === 'add')!;
      spots.push(add.at!);
      server.board = { ...server.board, version: server.board.version + 1,
        images: [...server.board.images, image('other', { placements: [{ ...card('other', add.at!.x, add.at!.y), w, h }] })] };
      throw new MoodboardVersionConflict(clone(server.board));
    }).mockImplementation(send);
    return spots;
  };

  it('a paste on the open board: the replay moves the add to the nearest free spot, off the other tab\'s tile', async () => {
    await openStudio('board');
    const spots = tileAtTheAdd();
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const [replayed] = addOps();
    const [w, h] = sizeFor(1, 1.5);
    const other = { x: spots[0].x, y: spots[0].y, width: 480, height: 270 };
    const taken = server.board.images.filter((img) => img.id !== replayed.images[0].id).flatMap((img) => (img.placements ?? []).map(rect));
    expect(replayed.at).toEqual(respot({ ...spots[0], width: w, height: h }, taken, board.view));
    expect(replayed.at).not.toEqual(spots[0]);
    for (const tile of taken) expect(keepsGap({ ...replayed.at!, width: w, height: h }, tile)).toBe(true);
    expect(keepsGap({ ...replayed.at!, width: w, height: h }, other)).toBe(true);
    // On the server once, where it was sent; its Undo step still knows it.
    await waitFor(() => expect(useAssetStudioDraftStore.getState().entries[JSON.stringify(['moodboard', 'global', 'g1'])]).toMatchObject({ dirty: false }));
    const placed = server.board.images.find((img) => img.url === '/api/outputs/chat-uploads/river.png')!;
    expect(placed.placements![0]).toMatchObject(replayed.at!);
    const key = JSON.stringify(['moodboard', 'global', 'g1']);
    const steps = useBoardUndoStore.getState().history(key, useAssetStudioDraftStore.getState().entries[key].epoch).done;
    expect(steps.map((step) => step.state)).toEqual(['saved']);
  });

  it('a drop above the toolbar: the replay starts from the spot moved up off the band, as the drop did', async () => {
    await openStudio('board');
    const view = { x: 0, y: 0, width: 1400, height: 700 };
    const spots = tileAtTheAdd(480, 160);
    act(() => { board.onDropFiles!([png('low.png')], { at: { x: 1100, y: 650 }, view, aim: true, band: true } as never); });
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const [replayed] = addOps();
    const [w, h] = sizeFor(1, 1.5);
    const taken = server.board.images.filter((img) => img.id !== replayed.images[0].id).flatMap((img) => (img.placements ?? []).map(rect));
    expect(replayed.at).toEqual(respot({ ...spots[0], width: w, height: h }, taken, view, true));
    for (const tile of taken) expect(keepsGap({ ...replayed.at!, width: w, height: h }, tile)).toBe(true);
    // In the view the person dropped it in, above the toolbar.
    expect(replayed.at!.y + h).toBeLessThanOrEqual(view.y + view.height);
    expect(replayed.at!.x).toBeGreaterThanOrEqual(view.x);
  });

  it('an add the board left alone keeps its spot through the replay', async () => {
    await openStudio('board');
    const send = api.editMoodboard.getMockImplementation()!;
    const spots: Array<{ x: number; y: number }> = [];
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      spots.push(ops.find((op): op is Add => op.op === 'add')!.at!);
      server.board = { ...server.board, version: server.board.version + 1,
        images: [...server.board.images, image('far', { placements: [card('far', -900, -900)] })] };
      throw new MoodboardVersionConflict(clone(server.board));
    }).mockImplementation(send);
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(addOps()[0].at).toEqual(spots[0]);
  });

  const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
  const [w, h] = sizeFor(1, 1.5);

  it('the replay keeps off spots other uploads still hold', async () => {
    await openStudio('board');
    const send = api.editMoodboard.getMockImplementation()!;
    const spots: Array<{ x: number; y: number }> = [];
    let held: { x: number; y: number; width: number; height: number } | null = null;
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      const at = ops.find((op): op is Add => op.op === 'add')!.at!;
      spots.push(at);
      server.board = { ...server.board, version: server.board.version + 1,
        images: [...server.board.images, image('other', { placements: [{ ...card('other', at.x, at.y), w, h }] })] };
      // Where the replay would go, another paste's upload holds a spot.
      const taken = server.board.images.flatMap((img) => (img.placements ?? []).map(rect));
      const spot = respot({ ...at, width: w, height: h }, taken, board.view);
      held = { ...spot, width: w, height: h };
      const ref = useBoardAddStore.getState().held[0].board;
      useBoardAddStore.setState((state) => ({ held: [...state.held, { id: 'placeholder-lake', ...held!,
        source: { kind: 'file' as const, name: 'lake.png' }, board: ref }] }));
      throw new MoodboardVersionConflict(clone(server.board));
    }).mockImplementation(send);
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const at = addOps()[0].at!;
    expect(keepsGap({ ...at, width: w, height: h }, held!)).toBe(true);
    expect(keepsGap({ ...at, width: w, height: h }, { ...spots[0], width: w, height: h })).toBe(true);
  });

  it('an add placed partly out of its view, left alone by the concurrent write, keeps its spot', async () => {
    await openStudio('board');
    const view = { x: 0, y: 0, width: 1000, height: 600 };
    const send = api.editMoodboard.getMockImplementation()!;
    const spots: Array<{ x: number; y: number }> = [];
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      spots.push(ops.find((op): op is Add => op.op === 'add')!.at!);
      server.board = { ...server.board, version: server.board.version + 1,
        images: [...server.board.images, image('far', { placements: [card('far', -3000, -3000)] })] };
      throw new MoodboardVersionConflict(clone(server.board));
    }).mockImplementation(send);
    act(() => { board.onDropFiles!([png('edge.png')], { at: { x: 980, y: 450 }, view, aim: true } as never); });
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(spots[0].x + w).toBeGreaterThan(view.width);
    expect(addOps()[0].at).toEqual(spots[0]);
  });

  /** A view with no room for a tile, above the toolbar's band: a drop there ends up under the band. */
  const tightView = { x: 0, y: 0, width: 1000, height: 300 };

  it('a drop with no room in view, then a 409 takes its spot: the replay starts off the band', async () => {
    await openStudio('board');
    const spots = tileAtTheAdd(w, h);
    act(() => { board.onDropFiles!([png('tight.png')], { at: { x: 500, y: 280 }, view: tightView, aim: true, band: true } as never); });
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const [replayed] = addOps();
    const taken = server.board.images.filter((img) => img.id !== replayed.images[0].id).flatMap((img) => (img.placements ?? []).map(rect));
    const withBand = respot({ ...spots[0], width: w, height: h }, taken, tightView, true);
    expect(withBand).not.toEqual(respot({ ...spots[0], width: w, height: h }, taken, tightView, false));
    expect(replayed.at).toEqual(withBand);
  });

  it('a held spot the board took, from a drop with no room in view: it starts off the band too', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    act(() => { board.onDropFiles!([png('tight.png')], { at: { x: 500, y: 280 }, view: tightView, aim: true, band: true } as never); });
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const spot = { x: board.placeholders[0].x, y: board.placeholders[0].y, width: w, height: h };
    act(() => { useAssetStudioDraftStore.getState().edit(g1Key, (draft) => ({ ...(draft as { images: MoodboardImage[] }),
      images: [...(draft as { images: MoodboardImage[] }).images, image('x', { placements: [{ ...card('x', spot.x, spot.y), w, h }] })] })); });
    const taken = ((useAssetStudioDraftStore.getState().entries[g1Key].draft as { images: MoodboardImage[] }).images)
      .flatMap((img) => (img.placements ?? []).map(rect));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    const withBand = respot(spot, taken, tightView, true);
    expect(withBand).not.toEqual(respot(spot, taken, tightView, false));
    expect(addOps()[0].at).toEqual(withBand);
  });
});

describe('round 6d: the offline board, the chip, review 8\'s replay and toast gaps', () => {
  const store = () => useAssetStudioDraftStore.getState();
  const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
  const offline = () => act(() => { noteBackendConnection('offline'); });
  const online = () => act(async () => { noteBackendConnection('online'); await Promise.resolve(); });
  const hint = 'Drag images here or add files.';
  type Add = Extract<MoodboardOp, { op: 'add' }>;
  const rect = (placement: MoodboardPlacement) => ({ x: placement.x, y: placement.y, width: placement.w, height: placement.h });
  const [w, h] = sizeFor(1, 1.5);

  it('GM r12 2, the List: offline, Add Images is off with the offline reason and the drop hint goes; back online both come back', async () => {
    await openStudio('list');
    const input = screen.getByLabelText('Add Images') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(screen.getByText(hint)).toBeTruthy();
    offline();
    expect(input.disabled).toBe(true);
    const wrap = input.closest('label')!;
    expect(wrap.title).toBe('You can add images when Nebula reconnects.');
    expect(wrap.hasAttribute('data-offline-disabled')).toBe(true);
    expect(wrap.className).toContain('moodboard-dropzone__file-wrap--disabled');
    expect(screen.queryByText(hint)).toBeNull();
    await online();
    expect(input.disabled).toBe(false);
    expect(wrap.title).toBe('');
    expect(wrap.hasAttribute('data-offline-disabled')).toBe(false);
    expect(screen.getByText(hint)).toBeTruthy();
  });

  it('GM r12 2, the Board: the Studio tells the board it is offline, and that it is back', async () => {
    await openStudio('board');
    expect(board.offline).toBe(false);
    offline();
    expect(board.offline).toBe(true);
    await online();
    expect(board.offline).toBe(false);
  });

  it('a paste refused while offline (its upload not sent) shows no empty line and holds no spot', async () => {
    await openStudio('board');
    offline();
    backend.apiFetch.mockImplementation(async () => { throw new OfflineRefusal('POST', '/api/uploads'); });
    paste(clipboard({ files: [png('river.png')] }));
    await new Promise((done) => setTimeout(done, 50));
    expect(store().entries[g1Key].saveError).toBeNull();
    expect(document.querySelector('.moodboard-studio__notice')).toBeNull();
    expect(board.placeholders).toEqual([]);
    expect(api.editMoodboard).not.toHaveBeenCalled();
  });

  /** A paste with no room in the view: its tile lands outside it, with the chip; the add lands and its spot's fade ends. */
  const pasteOutside = async () => {
    board.view = { x: 0, y: 0, width: 1000, height: 270 };
    board.point = { x: 500, y: 135 };
    paste(clipboard({ files: [png('away.png')] }));
    await waitFor(() => expect(board.outside).not.toBeNull());
    await waitFor(() => expect(addOps()).toHaveLength(1));
    await waitFor(() => expect(store().entries[g1Key]).toMatchObject({ dirty: false }));
    act(() => { board.filledDone?.(board.placeholders.map((holder) => holder.id)); });
    await waitFor(() => expect(board.placeholders).toEqual([]));
    expect(board.outside).not.toBeNull();
  };

  it('LOW-1 (review 8): Undo of an add placed outside the view takes its chip with it', async () => {
    await openStudio('board');
    await pasteOutside();
    press('z', { metaKey: true });
    await waitFor(() => expect(urls()).toEqual(['/api/outputs/i1.png', '/api/outputs/i2.png']));
    await waitFor(() => expect(board.outside).toBeNull());
  });

  it('LOW-1 (review 8): a remove of that add takes the chip too; one of two keeps the chip on the other', async () => {
    await openStudio('board');
    board.view = { x: 0, y: 0, width: 1000, height: 270 };
    board.point = { x: 500, y: 135 };
    paste(clipboard({ files: [png('a.png'), png('b.png')] }));
    await waitFor(() => expect(board.outside?.rects).toHaveLength(2));
    await waitFor(() => expect(addOps()).toHaveLength(2));
    await waitFor(() => expect(store().entries[g1Key]).toMatchObject({ dirty: false }));
    act(() => { board.filledDone?.(board.placeholders.map((holder) => holder.id)); });
    await waitFor(() => expect(board.placeholders).toEqual([]));
    const [first, second] = addOps();
    const removeImage = (id: string) => act(() => {
      store().edit(g1Key, (draft) => ({ ...(draft as { images: MoodboardImage[] }),
        images: (draft as { images: MoodboardImage[] }).images.filter((img) => img.id !== id) }));
    });
    removeImage(first.images[0].id!);
    await waitFor(() => expect(board.outside?.rects).toEqual([{ ...second.at!, width: w, height: h }]));
    removeImage(second.images[0].id!);
    await waitFor(() => expect(board.outside).toBeNull());
  });

  it('a card that only touches the chip\'s tile doesn\'t hold it: moved edge to edge off it, the chip goes (review 9 R10)', async () => {
    await openStudio('board');
    await pasteOutside();
    const [tile] = board.outside!.rects;
    const [add] = addOps();
    // Its card moves right by its width: it now shares only the tile's right edge.
    act(() => {
      store().edit(g1Key, (draft) => ({ ...(draft as { images: MoodboardImage[] }),
        images: (draft as { images: MoodboardImage[] }).images.map((img) => (img.id !== add.images[0].id ? img
          : { ...img, placements: (img.placements ?? []).map((card) => ({ ...card, x: tile.x + tile.width, y: tile.y })) })) }));
    });
    await waitFor(() => expect(board.outside).toBeNull());
  });

  it('NIT-3 (review 8): an add a 409 replay moves out of the view it was made in gets the edge chip', async () => {
    await openStudio('board');
    board.view = { x: 3000, y: 0, width: w + 60, height: h + 60 };
    board.point = { x: 3000 + (w + 60) / 2, y: (h + 60) / 2 };
    const send = api.editMoodboard.getMockImplementation()!;
    const spots: Array<{ x: number; y: number }> = [];
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      const at = ops.find((op): op is Add => op.op === 'add')!.at!;
      spots.push(at);
      server.board = { ...server.board, version: server.board.version + 1,
        images: [...server.board.images, image('other', { placements: [{ ...card('other', at.x, at.y), w, h }] })] };
      throw new MoodboardVersionConflict(clone(server.board));
    }).mockImplementation(send);
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    // Made inside the view: no chip then.
    expect(spots[0].x).toBeGreaterThanOrEqual(3000);
    const moved = { ...addOps()[0].at!, width: w, height: h };
    expect(moved).not.toMatchObject(spots[0]);
    await waitFor(() => expect(board.outside?.rects).toEqual([moved]));
    expect(board.outside?.thumb).toBe('/api/outputs/chat-uploads/river.png');
  });

  it('NIT-3: a replay move that stays in the view gets no chip', async () => {
    await openStudio('board');
    const spots: Array<{ x: number; y: number }> = [];
    const send = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      const at = ops.find((op): op is Add => op.op === 'add')!.at!;
      spots.push(at);
      server.board = { ...server.board, version: server.board.version + 1,
        images: [...server.board.images, image('other', { placements: [{ ...card('other', at.x, at.y), w, h }] })] };
      throw new MoodboardVersionConflict(clone(server.board));
    }).mockImplementation(send);
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(addOps()[0].at).not.toEqual(spots[0]);
    await new Promise((done) => setTimeout(done, 30));
    expect(board.outside).toBeNull();
  });

  it('round 6f: a replay move that stays in the view but leaves what is seen (the notice band) gets the chip', async () => {
    await openStudio('board');
    // What is seen at paste time: exactly the spot the paste takes, so the add is seen where it was made.
    const made = placeTiles({ at: { ...board.point! }, sizes: [[w, h]], occupied: [{ x: 0, y: 0, width: 480, height: 270 },
      { x: 520, y: 0, width: 480, height: 270 }], view: board.view }).spots[0];
    board.seen = { x: made.x, y: made.y, width: w, height: h };
    const spots: Array<{ x: number; y: number }> = [];
    const send = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      const at = ops.find((op): op is Add => op.op === 'add')!.at!;
      spots.push(at);
      server.board = { ...server.board, version: server.board.version + 1,
        images: [...server.board.images, image('other', { placements: [{ ...card('other', at.x, at.y), w, h }] })] };
      throw new MoodboardVersionConflict(clone(server.board));
    }).mockImplementation(send);
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(spots[0]).toEqual(made);
    const moved = { ...addOps()[0].at!, width: w, height: h };
    expect(moved).not.toMatchObject(made);
    // Still wholly in the view (the whole view would give no chip), but not in what is seen.
    expect(moved.x >= board.view!.x && moved.y >= board.view!.y && moved.x + w <= board.view!.x + board.view!.width
      && moved.y + h <= board.view!.y + board.view!.height).toBe(true);
    await waitFor(() => expect(board.outside?.rects).toEqual([moved]));
  });

  it('Y3 (review 8): a List add still uploading holds no spot on the Board: the replay leaves the add where it was', async () => {
    server.board = { ...server.board, images: [image('i1', { placements: [card('i1', 3000, 0)] }), image('i2', { placements: [card('i2', 3520, 0)] })] };
    await openStudio('board');
    board.point = { x: 0, y: 0 };
    const send = api.editMoodboard.getMockImplementation()!;
    const spots: Array<{ x: number; y: number }> = [];
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      spots.push(ops.find((op): op is Add => op.op === 'add')!.at!);
      server.board = { ...server.board, version: server.board.version + 1,
        images: [...server.board.images, image('far', { placements: [card('far', -3000, -3000)] })] };
      // A List add on this board, still uploading: a row, with no spot on the board.
      const ref = useBoardAddStore.getState().held[0].board;
      useBoardAddStore.setState((state) => ({ held: [...state.held, { id: 'placeholder-row', x: 0, y: 0, width: 0, height: 0, listOnly: true,
        source: { kind: 'file' as const, name: 'row.png' }, board: ref }] }));
      throw new MoodboardVersionConflict(clone(server.board));
    }).mockImplementation(send);
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    // The add covers the row's (meaningless) corner, and still keeps its spot.
    expect(spots[0].x).toBeLessThan(0);
    expect(spots[0].y).toBeLessThan(0);
    expect(addOps()[0].at).toEqual(spots[0]);
  });

  it('Y4 (review 8): two adds a 409 replay moves land on spots of their own, a gap apart', async () => {
    await openStudio('board');
    // A view with one free spot left once the other tab's tiles are in: both
    // adds' nearest; the first takes it, the second goes on.
    board.view = { x: 3000, y: 0, width: 1380, height: 354 };
    board.point = { x: 3690, y: 177 };
    const send = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      const adds = ops.filter((op): op is Add => op.op === 'add');
      server.board = { ...server.board, version: server.board.version + 1,
        images: [...server.board.images, ...adds.map((add, index) => image(`other${index}`, { placements: [{ ...card(`other${index}`, add.at!.x, add.at!.y), w, h }] }))] };
      throw new MoodboardVersionConflict(clone(server.board));
    }).mockImplementation(send);
    paste(clipboard({ files: [png('a.png'), png('b.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(2));
    const [a, b] = addOps().map((op) => ({ ...op.at!, width: w, height: h }));
    expect(keepsGap(a, b)).toBe(true);
    const others = server.board.images.filter((img) => img.id.startsWith('other') || img.id === 'i1' || img.id === 'i2')
      .flatMap((img) => (img.placements ?? []).map(rect));
    for (const tile of others) {
      expect(keepsGap(a, tile)).toBe(true);
      expect(keepsGap(b, tile)).toBe(true);
    }
  });

  it('Y20 (review 8): an Undo toast (it has an action) is still there back on its board', async () => {
    const raf = immediateFrames();
    await openStudio('list');
    act(() => { (document.querySelector('.moodboard-tile__remove') as HTMLButtonElement).click(); });
    await screen.findByRole('button', { name: 'Undo' });
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    expect(screen.queryByText('Removed #1')).toBeNull();
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    await screen.findByDisplayValue('Global board');
    expect(screen.getByText('Removed #1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    raf.mockRestore();
  });

  it('Y21 (review 8): an info line about the board the person is on stays: an Undo answered just as they come back to its board', async () => {
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    await waitFor(() => expect(store().entries[g1Key]).toMatchObject({ dirty: false }));
    // The undo's answer is held, and puts nothing back to redo: its line has no action.
    let answer: (value: unknown) => void = () => {};
    let ready: Promise<unknown> = Promise.resolve();
    const send = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementationOnce((...args: Parameters<typeof send>) => {
      ready = send(...args).then((edited: object) => ({ ...edited, undo: { ops: [] } }));
      return new Promise((done) => { answer = done; });
    });
    press('z', { metaKey: true });
    await waitFor(() => expect(api.editMoodboard).toHaveBeenCalledTimes(2));
    const value = await ready;
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    await waitFor(() => expect(screen.queryByDisplayValue('Global board')).toBeNull());
    // Back on the board, and its undo answers in the same turn: the line
    // comes before the Studio has drawn the board again (outside act, as in
    // the page, so React draws on its own microtask, after the answer's).
    answer(value);
    useUIStore.getState().enterMoodboardEditor('g1', 'global');
    await act(async () => { await Promise.resolve(); });
    await screen.findByDisplayValue('Global board');
    expect(screen.getByText('Undid: Added #3')).toBeTruthy();
  });

  it('GM r12 1: the neutral line\'s look is #204\'s neutral tokens, not the error colour', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/moodboard-studio.css'), 'utf8');
    const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.-]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`))?.[1] ?? '';
    const line = rule('body.app-slava-restraint .moodboard-studio__notice--neutral');
    expect(line).toContain('color: var(--sr-ink-light)');
    expect(line).toContain('border-left-color: var(--sr-edge-strong)');
    expect(line).toContain('background: var(--sr-surface-control)');
    expect(rule('body.app-slava-restraint .moodboard-studio-toolbar__state--not-saved')).toContain('color: var(--sr-ink-light)');
    expect(css).not.toMatch(/--neutral[^{]*,[^{]*\{[^}]*#e0796b/);
    expect(css).not.toMatch(/--not-saved[^{]*,[^{]*\{[^}]*#e0796b/);
  });
});

// Round 6i (GM r17 2+3): a saved board's kept edit lives through a reload of
// the tab and replays on the board as the server has it then, by the 6g rule.
describe('a saved board\'s kept edit through a reload (round 6i, GM r17)', () => {
  const EDITS = 'nebula:moodboard-kept-edits';
  const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
  const SAVE = "Couldn't save the board.";
  const keptEdits = () => JSON.parse(window.sessionStorage.getItem(EDITS) ?? '[]') as Array<{ board: string; fields: Record<string, unknown>; base: Record<string, unknown> }>;
  /** The reload: a new page, its store empty, this tab's session storage kept. */
  const reloadTab = () => {
    cleanup();
    resetUnsavedDrafts();
    act(() => { useAssetStudioDraftStore.setState({ entries: {}, aliases: {} }); });
    useBoardUndoStore.setState({ histories: {} });
    act(() => { restoreUnsavedDrafts(); });
  };
  const reopen = async (name: string) => {
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await screen.findByDisplayValue(name, {}, { timeout: 3000 });
  };
  const rename = (from: string, to: string) => fireEvent.change(screen.getByDisplayValue(from), { target: { value: to } });
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();

  it('a rename whose save failed survives the reload and is sent then; the kept edit goes once saved', async () => {
    const put = api.updateMoodboard.getMockImplementation()!;
    api.updateMoodboard.mockRejectedValue(new RequestFailedError(SAVE, 500, { detail: 'boom' }));
    await openStudio();
    rename('Global board', 'Dusk');
    await screen.findByText('Nebula couldn’t save the board because the server hit an error. Try again.', {}, { timeout: 3000 });
    expect(keptEdits()).toEqual([expect.objectContaining({ board: 'g1', fields: { name: 'Dusk' }, base: { name: 'Global board' } })]);
    api.updateMoodboard.mockImplementation(put);
    reloadTab();
    await reopen('Dusk');
    await waitFor(() => expect(server.board.name).toBe('Dusk'), { timeout: 3000 });
    expect(server.puts.at(-1)).toMatchObject({ name: 'Dusk', baseVersion: 1 });
    await waitFor(() => expect(window.sessionStorage.getItem(EDITS)).toBeNull());
    expect(screen.queryByText(/^Kept /)).toBeNull();
  });

  it('a conflict says Reload, with no Retry; after the reload the edit replays on the newer version', async () => {
    const put = api.updateMoodboard.getMockImplementation()!;
    const theirs = { ...clone(server.board), version: 5, notes: 'agent notes', updatedAt: later(60_000) } as Moodboard;
    api.updateMoodboard.mockImplementation(async () => { throw new MoodboardVersionConflict(clone(theirs)); });
    await openStudio();
    rename('Global board', 'Dusk');
    await screen.findByText('Nebula couldn’t save the board because it changed somewhere else. Reload to get the latest version.', {}, { timeout: 4000 });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    server.board = theirs;
    api.updateMoodboard.mockImplementation(put);
    reloadTab();
    await reopen('Dusk');
    await waitFor(() => expect(server.board).toMatchObject({ name: 'Dusk', notes: 'agent notes' }), { timeout: 3000 });
    expect(server.puts.at(-1)).toMatchObject({ name: 'Dusk', baseVersion: 5 });
    expect(server.puts.at(-1)).not.toHaveProperty('notes');
  });

  it('renamed elsewhere after the edit: the board\'s name stays, and the one-field line shows it with its title', async () => {
    api.updateMoodboard.mockRejectedValue(new RequestFailedError(SAVE, 500, { detail: 'boom' }));
    await openStudio();
    rename('Global board', 'Dusk');
    await screen.findByText('Nebula couldn’t save the board because the server hit an error. Try again.', {}, { timeout: 3000 });
    server.board = { ...server.board, name: 'Rivers', version: 2, updatedAt: later(60_000) } as Moodboard;
    api.updateMoodboard.mockClear();
    reloadTab();
    await reopen('Rivers');
    const line = await screen.findByText('Kept the name “Rivers” from the board.');
    expect(line.className).toContain('moodboard-studio__notice--neutral');
    expect(line.getAttribute('title')).toBe('Rivers');
    await new Promise((done) => setTimeout(done, 800));
    expect(api.updateMoodboard).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(EDITS)).toBeNull();
  });

  it('renamed elsewhere before the edit: the edit is later, so it goes on, with no line', async () => {
    const put = api.updateMoodboard.getMockImplementation()!;
    server.board = { ...server.board, updatedAt: later(-120_000) } as Moodboard;
    api.updateMoodboard.mockRejectedValue(new RequestFailedError(SAVE, 500, { detail: 'boom' }));
    await openStudio();
    rename('Global board', 'Dusk');
    await screen.findByText('Nebula couldn’t save the board because the server hit an error. Try again.', {}, { timeout: 3000 });
    server.board = { ...server.board, name: 'Rivers', version: 2, updatedAt: later(-60_000) } as Moodboard;
    api.updateMoodboard.mockImplementation(put);
    reloadTab();
    await reopen('Dusk');
    await waitFor(() => expect(server.board.name).toBe('Dusk'), { timeout: 3000 });
    expect(screen.queryByText(/^Kept /)).toBeNull();
  });

  it('an add and a remove replay; an add the board already has, and a remove of an image gone, don\'t', async () => {
    const edit = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockRejectedValue(new RequestFailedError(SAVE, 500, { detail: 'boom' }));
    await openStudio();
    act(() => {
      useAssetStudioDraftStore.getState().edit(g1Key, (draft) => {
        const current = draft as { images: MoodboardImage[]; pendingOps?: MoodboardOp[] };
        const ops: MoodboardOp[] = [{ op: 'add', images: [{ id: 'n1', url: '/api/outputs/sea.png' }] } as MoodboardOp,
          { op: 'add', images: [{ id: 'n2', url: '/api/outputs/dune.png' }] } as MoodboardOp, { op: 'remove', images: ['i1', 'i2'] } as MoodboardOp];
        return { ...current, pendingOps: [...(current.pendingOps ?? []), ...ops] };
      });
    });
    await waitFor(() => expect(keptEdits()[0]?.board).toBe('g1'));
    await waitFor(() => expect(api.editMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    // Meanwhile dune.png landed (a save before the reload) and i2 went.
    server.board = { ...server.board, version: 3, images: [server.board.images[0], image('n2', { url: '/api/outputs/dune.png' })] } as Moodboard;
    api.editMoodboard.mockReset().mockImplementation(edit);
    reloadTab();
    await reopen('Global board');
    await waitFor(() => expect(server.edits.length).toBeGreaterThan(0), { timeout: 3000 });
    const sent = server.edits.flat();
    expect(sent.filter((op) => op.op === 'add').map((op) => (op as Extract<MoodboardOp, { op: 'add' }>).images[0].url)).toEqual(['/api/outputs/sea.png']);
    expect(sent.filter((op) => op.op === 'remove')).toEqual([{ op: 'remove', images: ['i1'] }]);
  });

  it('replayed and refused again, it is kept again with its first edit time, so a second reload still weighs it fairly', async () => {
    api.updateMoodboard.mockRejectedValue(new RequestFailedError(SAVE, 500, { detail: 'boom' }));
    await openStudio();
    rename('Global board', 'Dusk');
    await screen.findByText('Nebula couldn’t save the board because the server hit an error. Try again.', {}, { timeout: 3000 });
    const first = (keptEdits()[0] as { fieldEditedAt?: Record<string, number> }).fieldEditedAt?.name;
    expect(first).toBeGreaterThan(0);
    reloadTab();
    await reopen('Dusk');
    await screen.findByText('Nebula couldn’t save the board because the server hit an error. Try again.', {}, { timeout: 3000 });
    expect((keptEdits()[0] as { fieldEditedAt?: Record<string, number> }).fieldEditedAt?.name).toBe(first);
  });

  it('a send that waited for Nebula beside the kept edit doesn\'t overrule the replay', async () => {
    window.sessionStorage.setItem(EDITS, JSON.stringify([{ board: 'g1', fields: { name: 'Dusk' }, base: { name: 'Global board' },
      fieldEditedAt: { name: 1 }, ops: [], at: Date.now() }]));
    window.sessionStorage.setItem('nebula:moodboard-sends-waiting', JSON.stringify([{ board: 'g1', ops: [], fields: { name: 'Dusk' },
      page: 'an-earlier-page', at: Date.now() }]));
    server.board = { ...server.board, name: 'Rivers', version: 2, updatedAt: later(-1000) } as Moodboard;
    await reopen('Rivers');
    await screen.findByText('Kept the name “Rivers” from the board.');
    await new Promise((done) => setTimeout(done, 800));
    expect(api.updateMoodboard).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('nebula:moodboard-sends-waiting')).toBeNull();
  });

  it('the board deleted elsewhere before the reload: nothing replays, and the edit waits a day for its board to come back', async () => {
    const put = api.updateMoodboard.getMockImplementation()!;
    api.updateMoodboard.mockRejectedValue(new RequestFailedError(SAVE, 500, { detail: 'boom' }));
    await openStudio();
    rename('Global board', 'Dusk');
    await screen.findByText('Nebula couldn’t save the board because the server hit an error. Try again.', {}, { timeout: 3000 });
    const kept = server.board;
    server.board = { ...kept, id: 'gone' } as Moodboard;
    api.updateMoodboard.mockImplementation(put);
    reloadTab();
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await screen.findByText(/Moodboard not found/);
    expect(keptEdits()).toHaveLength(1);
    // Restored: its next load in this tab replays it.
    server.board = kept;
    reloadTab();
    await reopen('Dusk');
    await waitFor(() => expect(server.board.name).toBe('Dusk'), { timeout: 3000 });
  });
});
