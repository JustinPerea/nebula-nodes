import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
  outside: null as null | { id: number; rects: Array<{ x: number; y: number; width: number; height: number }>; thumb: string | null },
  placeholders: [] as Array<{ id: string; x: number; y: number; width: number; height: number; source?: unknown; filled?: { imageId: string; url: string }; listOnly?: boolean }>,
  filledDone: null as null | ((ids: string[]) => void),
  onDropFiles: null as null | ((files: File[], target: { at: { x: number; y: number };
    view: { x: number; y: number; width: number; height: number } | null; aim: boolean }) => void),
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
    }) => {
      board.onDropFiles = props.onDropFiles;
      board.filledDone = props.onPlaceholdersFilled ?? null;
      board.outside = props.outside ?? null;
      board.placeholders = props.placeholders ?? [];
      const ref = props.pasteTarget;
      useEffect(() => {
        if (!ref) return undefined;
        const read = () => ({ at: board.point!, view: board.view, aim: false });
        ref.current = read;
        return () => { ref.current = null; };
      }, [ref]);
      return <div data-testid="board-canvas">{props.images.map((img) => <span key={img.id}>{img.url}</span>)}</div>;
    },
  };
});

import { MoodboardStudioView } from './MoodboardStudioView';
import { resetBoardAdds, useBoardAddStore } from './boardAdds';
import { ALREADY_BEING_ADDED, LINKS_NOT_ADDED, NOTHING_TO_PASTE, reloadLostLine, uriListLinks, webLinks } from './pasteImages';
import { placeTiles } from '../../lib/boardPlacement';
import { sizeFor } from '../../lib/moodboardLayout';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { MOODBOARD_VIEW_KEY, useBoardCanvasStore } from '../../store/boardCanvasStore';
import { useBoardUndoStore } from '../../lib/boardUndo';
import type { MoodboardOp } from '../../lib/moodboardEdits';

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
  setOpenProject(['p1', 'Project']);
});
afterEach(() => cleanup());

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

  it('an aimed drop moved by the board into the toolbar band takes the chip (it would be hidden there)', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    const view = { x: 0, y: 0, width: 2000, height: 1000 };
    act(() => { board.onDropFiles!([png('aimed.png')], { at: { x: 1000, y: 500 }, view, aim: true, band: true } as Parameters<NonNullable<typeof board.onDropFiles>>[1]); });
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    expect(board.outside).toBeNull();
    // The only slot left reaches past the view's bottom edge, into the band.
    const under = slot(500, 1000 - Math.round(h / 2));
    arrive(around([under]));
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(addOps()[0].at).toEqual({ x: under.x, y: under.y });
    await waitFor(() => expect(board.outside?.rects).toEqual([under]));
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
    window.localStorage.setItem('nebula:moodboard-adds-in-flight', JSON.stringify([
      { id: 'placeholder-9', board: 'g1', name: 'river.png', page: 'an earlier page' },
      { id: 'placeholder-10', board: 'g1', name: 'lake.png', page: 'an earlier page' },
      { id: 'placeholder-11', board: 'other', name: 'sea.png', page: 'an earlier page' }]));
    const uploads = holdUploads();
    await openStudio('board');
    await screen.findByText('“river.png” and “lake.png” weren’t added because the page reloaded while they uploaded. Paste them again.');
    paste(clipboard({ files: [png('now.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const kept = () => JSON.parse(window.localStorage.getItem('nebula:moodboard-adds-in-flight') ?? '[]') as Array<{ name: string; board: string }>;
    expect(kept().map((it) => `${it.board}:${it.name}`)).toEqual(['other:sea.png', 'g1:now.png']);
    await uploads.open();
    await waitFor(() => expect(addOps()).toHaveLength(1));
    await waitFor(() => expect(kept().map((it) => it.name)).toEqual(['sea.png']));
    window.localStorage.removeItem('nebula:moodboard-adds-in-flight');
  });

  it('GM 5: a reload cuts the upload short and the browser runs its failure on the way out: the record stays for the next load', async () => {
    const uploads = holdUploads();
    await openStudio('board');
    paste(clipboard({ files: [png('river.png')] }));
    await waitFor(() => expect(board.placeholders).toHaveLength(1));
    const kept = () => JSON.parse(window.localStorage.getItem('nebula:moodboard-adds-in-flight') ?? '[]') as Array<{ name: string }>;
    try {
      window.dispatchEvent(new Event('pagehide'));
      await uploads.fail();
      await new Promise((done) => setTimeout(done, 30));
      expect(kept().map((it) => it.name)).toEqual(['river.png']);
    } finally {
      window.dispatchEvent(new Event('pageshow'));
      window.localStorage.removeItem('nebula:moodboard-adds-in-flight');
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
    expect(JSON.stringify(store().entries[g1Key].saveError)).toContain("Couldn't save the board.");
    expect(store().entries[g1Key].retry).toBe('save');
    expect(urlsOf(g1Key)).toContain(river);
    expect(((store().entries[g1Key].draft as { pendingOps?: MoodboardOp[] }).pendingOps ?? []).some((op) => op.op === 'add')).toBe(true);
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
    const kept = JSON.parse(window.localStorage.getItem('nebula:moodboard-adds-in-flight') ?? '[]') as Array<{ name: string }>;
    expect(kept.map((it) => it.name)).toEqual(['river.png']);
    await uploads.open();
    await waitFor(() => expect(window.localStorage.getItem('nebula:moodboard-adds-in-flight')).toBeNull());
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
