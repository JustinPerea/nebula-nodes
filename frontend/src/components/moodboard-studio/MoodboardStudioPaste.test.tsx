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
  moveStoredAsset: vi.fn(), updateMoodboard: vi.fn(),
}));
const backend = vi.hoisted(() => ({ apiFetch: vi.fn() }));
const board = vi.hoisted(() => ({
  point: { x: 900, y: 300 } as { x: number; y: number } | null,
  view: { x: -1000, y: -1000, width: 4000, height: 3000 } as { x: number; y: number; width: number; height: number } | null,
  outside: null as null | { id: number; rects: Array<{ x: number; y: number; width: number; height: number }>; thumb: string | null },
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
vi.mock('../../hooks/useAssetDelete', () => ({
  useAssetDelete: () => ({ lastDeleted: null, busy: false, error: null, refreshKey: 0, remove: vi.fn(),
    undo: vi.fn(), dismiss: vi.fn(), refresh: vi.fn() }),
}));
// jsdom loads no image: each pasted file reads as 3:2 at once.
vi.mock('../../lib/boardDrop', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/boardDrop')>(),
  readImageAspect: async () => 1.5,
}));
vi.mock('./BoardCanvas', async () => {
  const { useEffect } = await import('react');
  return {
    BoardCanvas: (props: {
      images: MoodboardImage[];
      onDropFiles: NonNullable<typeof board.onDropFiles>;
      pasteTarget?: { current: (() => { at: { x: number; y: number }; view: typeof board.view; aim: boolean }) | null };
      outside?: typeof board.outside;
    }) => {
      board.onDropFiles = props.onDropFiles;
      board.outside = props.outside ?? null;
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
import { LINKS_NOT_ADDED, NOTHING_TO_PASTE, uriListLinks, webLinks } from './pasteImages';
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
  Object.values(api).forEach((mock) => mock.mockReset());
  backend.apiFetch.mockReset().mockImplementation(async (path: string, init?: RequestInit) => uploadResponse(path, init));
  refuse = null;
  board.point = { x: 900, y: 300 };
  board.view = { x: -1000, y: -1000, width: 4000, height: 3000 };
  board.outside = null;
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
      if (op.op === 'restore') images = clone(server.before.get(String((op.slices[0] as { tag: string }).tag))!);
    }
    server.board = { ...server.board, images, version: server.board.version + 1 };
    return { board: clone(server.board), version: server.board.version,
      applied: ops.map((op, index) => ({ index, op: op.op, status: 'applied' as const,
        ...(op.op === 'restore' ? { skipped: [], removed: [] } : {}) })),
      undo: { ops: [{ op: 'restore', slices: [{ part: 'tag', tag }] }] } };
  });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
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
