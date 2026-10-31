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
// hands the Studio a fixed paste point, as the board does.

const api = vi.hoisted(() => ({
  analyzeMoodboard: vi.fn(), createMoodboard: vi.fn(), editMoodboard: vi.fn(), fetchMoodboard: vi.fn(),
  fetchMoodboards: vi.fn(), keepMoodboardBriefOverride: vi.fn(), lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(), updateMoodboard: vi.fn(),
}));
const backend = vi.hoisted(() => ({ apiFetch: vi.fn() }));
const board = vi.hoisted(() => ({
  point: { x: 900, y: 300 } as { x: number; y: number } | null,
  drops: [] as Array<{ files: File[]; at: { x: number; y: number } }>,
  onDropFiles: null as null | ((files: File[], at: { x: number; y: number }) => void),
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
      onDropFiles: (files: File[], at: { x: number; y: number }) => void;
      pastePoint?: { current: (() => { x: number; y: number }) | null };
    }) => {
      board.onDropFiles = props.onDropFiles;
      const ref = props.pastePoint;
      useEffect(() => {
        if (!ref) return undefined;
        const read = () => board.point!;
        ref.current = read;
        return () => { ref.current = null; };
      }, [ref]);
      return <div data-testid="board-canvas">{props.images.map((img) => <span key={img.id}>{img.url}</span>)}</div>;
    },
  };
});

import { MoodboardStudioView } from './MoodboardStudioView';
import { NOTHING_TO_PASTE, webLinks } from './pasteImages';
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
function clipboard({ files = [] as File[], text = '', html = '' } = {}): DataTransfer {
  const types = [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : []), ...(html ? ['text/html'] : [])];
  return {
    files: Object.assign([...files], { item: (index: number) => files[index] ?? null }) as unknown as FileList,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })) as unknown as DataTransferItemList,
    types,
    getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : ''),
  } as unknown as DataTransfer;
}
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
    // Where a drop of the same file at the same point puts it.
    act(() => { board.onDropFiles!([png('dropped.png')], { x: 900, y: 300 }); });
    await waitFor(() => expect(addOps()).toHaveLength(2));
    expect(add.at).toEqual(addOps()[1].at);
    expect(Math.abs(add.at!.y - 300)).toBeLessThan(300);
  });

  it('three files fan out from the point as a multi-file drop does, in one batch', async () => {
    await openStudio('board');
    paste(clipboard({ files: [png('a.png'), png('b.png'), png('c.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(3));
    expect(server.edits).toHaveLength(1);
    const xs = addOps().map((op) => op.at!.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(addOps().map((op) => op.images[0].url)).toEqual(['a.png', 'b.png', 'c.png'].map((n) => `/api/outputs/chat-uploads/${n}`));
  });

  it('lands where the board says: the pointer, or the middle of the view when it isn\'t over the board', async () => {
    await openStudio('board');
    board.point = { x: -2000, y: 4000 };
    paste(clipboard({ files: [png('there.png')] }));
    await waitFor(() => expect(addOps()).toHaveLength(1));
    expect(addOps()[0].at!.y).toBeGreaterThan(3000);
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
    await waitFor(() => expect(urls()).toHaveLength(5));
    expect(urls().slice(2)).toEqual(['one.png', 'two.png', 'three.png'].map((n) => `/api/outputs/chat-uploads/${n}`));
    expect(addOps().every((op) => !('at' in op) || op.at === undefined)).toBe(true);
  });

  it('a non-image file is left out, as a drop leaves it out', async () => {
    await openStudio('list');
    paste(clipboard({ files: [new File(['x'], 'notes.txt', { type: 'text/plain' }), png('ok.png')] }));
    await waitFor(() => expect(urls()).toHaveLength(3));
    expect(server.uploads).toEqual(['ok.png']);
  });

  it('an oversized file gives the upload\'s own line, as a drop does', async () => {
    await openStudio('list');
    refuse = { status: 413, body: { detail: 'File exceeds 20 MB limit' } };
    paste(clipboard({ files: [png('huge.png')] }));
    expect(await screen.findByText("Couldn't upload huge.png.")).toBeTruthy();
    expect(server.board.images).toHaveLength(2);
  });

  it('a tab that isn\'t connected as the person gets what a drop gets: the upload\'s refusal, nothing added', async () => {
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
  it('a paste into Direction, a name or a note is the field\'s own', async () => {
    await openStudio('list');
    const direction = screen.getByPlaceholderText(/Say what you want/);
    const note = screen.getAllByPlaceholderText('A label for you, like Liked')[0];
    const name = screen.getByDisplayValue('Global board');
    for (const field of [direction, note, name]) {
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

  it('a paste something before it refused (a tab following an agent\'s switch) is left alone, as a drop is', async () => {
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

  it('no paste handler is left once the Studio is gone', async () => {
    await openStudio('board');
    cleanup();
    const event = paste(clipboard({ files: [png('later.png')] }));
    expect(event.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.uploads).toEqual([]);
  });
});

describe('links on the clipboard', () => {
  it('are read only as http and https, one per line, and only when every line is one', () => {
    expect(webLinks('https://a.example/x.png\n http://b.example/y.jpg ')).toEqual(['https://a.example/x.png', 'http://b.example/y.jpg']);
    expect(webLinks('https://a.example/x.png\nnot a link')).toEqual([]);
    expect(webLinks('data:image/png;base64,AAAA')).toEqual([]);
    expect(webLinks('file:///a.png')).toEqual([]);
    expect(webLinks('javascript:alert(1)')).toEqual([]);
  });
});
