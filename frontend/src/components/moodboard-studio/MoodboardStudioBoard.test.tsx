import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Moodboard, MoodboardImage, MoodboardPlacement } from '../../types';

// The Board view in Moodboard Studio (moodboard canvas PR5): a switch between
// Board and List, one op and one undo step per drag, the Studio's own keys,
// and the board kept in step with List and with edits made elsewhere. The
// canvas itself is a stand-in here (BoardCanvas.test.tsx covers it); it gets
// the same props and calls the same callbacks.

const api = vi.hoisted(() => ({
  analyzeMoodboard: vi.fn(), createMoodboard: vi.fn(), editMoodboard: vi.fn(), fetchMoodboard: vi.fn(),
  fetchMoodboards: vi.fn(), keepMoodboardBriefOverride: vi.fn(), lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(), updateMoodboard: vi.fn(),
}));
const socket = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
const board = vi.hoisted(() => ({ props: null as null | {
  boardKey: string; images: MoodboardImage[];
  onMove: (moves: Array<{ placement: string; x: number; y: number }>) => void;
  onDropFiles: (files: File[], at: { x: number; y: number }) => void;
} }));
const graphFile = vi.hoisted(() => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/graphFile', () => graphFile);
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
vi.mock('./BoardCanvas', () => ({
  BoardCanvas: (props: NonNullable<typeof board.props>) => {
    board.props = props;
    return (
      <div data-testid="board-canvas">
        {props.images.map((img, index) => (
          <span key={img.id}>{`card #${index + 1} at ${img.placements?.[0]?.x},${img.placements?.[0]?.y}`}</span>
        ))}
      </div>
    );
  },
}));

import { MoodboardStudioView } from './MoodboardStudioView';
import { GraphFileActions } from '../GraphFileActions';
import { MoodboardVersionConflict, type MoodboardOp } from '../../lib/moodboardEdits';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { MOODBOARD_VIEW_KEY, useBoardCanvasStore } from '../../store/boardCanvasStore';
import { useBoardUndoStore } from '../../lib/boardUndo';

const card = (id: string, x = 0, y = 0): MoodboardPlacement => ({ id: `c-${id}`, frameId: null, x, y, w: 480, h: 270,
  weight: 1, placedBy: 'person', placedAt: '2026-10-20T00:00:00+00:00' });
const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, placements: [card(id)], ...extra });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The backend as far as these tests need it: /edits applies place, remove,
 *  note, weight and setAside, and answers each batch with an undo; a restore
 *  puts the images back as they were before the batch it undoes (and can be
 *  told to report a slice it skipped). */
const server = {
  board: null as unknown as Moodboard,
  edits: [] as MoodboardOp[][],
  puts: [] as Record<string, unknown>[],
  before: new Map<string, MoodboardImage[]>(),
  coverBefore: new Map<string, string | null>(),
  skip: [] as Array<Record<string, unknown>>,
};

function serverEdit(current: Moodboard, op: MoodboardOp): Moodboard {
  const next = clone(current);
  const change = (id: string, patch: Partial<MoodboardImage>) => {
    if (!next.images.some((img) => img.id === id)) throw new Error(`${op.op}: no image '${id}'`);
    next.images = next.images.map((img) => (img.id === id ? { ...img, ...patch } : img));
  };
  if (op.op === 'add') next.images = [...next.images, ...op.images.map((img) => image(img.id!, { url: img.url }))];
  if (op.op === 'remove') next.images = next.images.filter((img) => !op.images.includes(img.id));
  if (op.op === 'weight') change(op.image, { weight: op.value });
  if (op.op === 'setAside') change(op.image, { excluded: op.value });
  if (op.op === 'note') change(op.image, { ...('notes' in op ? { notes: op.notes } : {}),
    ...('privateNote' in op ? { privateNote: op.privateNote } : {}) });
  if (op.op === 'place') {
    next.images = next.images.map((img) => ({ ...img, placements: img.placements?.map((p) => (
      p.id === op.placement ? { ...p, x: op.x, y: op.y } : p)) }));
  }
  if (op.op === 'cover') next.coverImageId = op.image;
  if (op.op === 'restore') {
    const tag = String((op.slices[0] as { tag: string }).tag);
    next.images = clone(server.before.get(tag)!);
    next.coverImageId = server.coverBefore.get(tag) ?? null;
  }
  return next;
}

function outsideWrite(update: (current: Moodboard) => Moodboard) {
  server.board = { ...update(clone(server.board)), version: server.board.version + 1 };
  act(() => {
    for (const handler of socket.handlers) {
      handler({ type: 'storedAssetChanged', kind: 'moodboard', id: server.board.id, deleted: false,
        version: server.board.version, edit: { actor: { kind: 'agent', name: 'Claude' } } });
    }
  });
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  graphFile.saveToFile.mockReset().mockResolvedValue(undefined);
  socket.handlers.clear();
  board.props = null;
  server.board = {
    id: 'g1', name: 'Global board', version: 1, notes: '', mode: 'look', strength: 0.7,
    images: [image('i1'), image('i2', { placements: [card('i2', 520, 0)] })],
    analysis: { version: 5, sourceHash: 'h1', summary: 'Warm.', palette: ['#e8593c'], accents: [], images: [] },
    direction: '', avoid: [], pinnedColors: { include: [], exclude: [] }, briefOverride: null,
    thumbnail: '/api/outputs/i1.png', createdAt: '', updatedAt: '',
  } as unknown as Moodboard;
  server.edits = [];
  server.puts = [];
  server.before.clear();
  server.coverBefore.clear();
  server.skip = [];
  api.fetchMoodboard.mockImplementation(async (id: string) => (id === server.board.id ? clone(server.board) : null));
  api.fetchMoodboards.mockImplementation(async (scope: string) => (scope === 'global' ? [clone(server.board)] : []));
  api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
  api.updateMoodboard.mockImplementation(async (_id: string, body: Record<string, unknown>) => {
    server.puts.push(body);
    if (typeof body.baseVersion === 'number' && body.baseVersion !== server.board.version) {
      throw new MoodboardVersionConflict(clone(server.board));
    }
    const fields = { ...body };
    delete fields.baseVersion;
    server.board = { ...server.board, ...fields, version: server.board.version + 1 } as Moodboard;
    return clone(server.board);
  });
  api.editMoodboard.mockImplementation(async (_id: string, ops: MoodboardOp[], baseVersion?: number) => {
    server.edits.push(ops);
    if (typeof baseVersion === 'number' && baseVersion !== server.board.version) {
      throw new MoodboardVersionConflict(clone(server.board));
    }
    const tag = `u${server.edits.length}`;
    server.before.set(tag, clone(server.board.images));
    server.coverBefore.set(tag, server.board.coverImageId ?? null);
    server.board = { ...ops.reduce(serverEdit, server.board), version: server.board.version + 1 };
    const restoring = ops.every((op) => op.op === 'restore');
    const applied = ops.map((op, index) => ({ index, op: op.op, status: 'applied' as const,
      ...(restoring ? { skipped: server.skip, removed: [] } : {}) }));
    return { board: clone(server.board), version: server.board.version, applied,
      undo: { ops: [{ op: 'restore', slices: [{ part: 'tag', tag }] }] } };
  });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  useBoardUndoStore.setState({ histories: {} });
  useBoardCanvasStore.setState({ view: 'list', selection: {}, viewports: {} });
  try { window.localStorage.removeItem(MOODBOARD_VIEW_KEY); } catch { /* jsdom */ }
  setOpenProject(['p1', 'Project']);
});
afterEach(() => cleanup());

async function openStudio({ view = 'list' as 'list' | 'board', withGraphActions = false } = {}) {
  useBoardCanvasStore.setState({ view });
  act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
  render(
    <ReactFlowProvider>
      {withGraphActions && <GraphFileActions />}
      <MoodboardStudioView />
    </ReactFlowProvider>,
  );
  await screen.findByDisplayValue('Global board');
  if (view === 'board') await screen.findByTestId('board-canvas');
}
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const select = (...placements: string[]) => act(() => {
  useBoardCanvasStore.getState().setSelection(board.props!.boardKey, placements);
});
const entry = () => Object.values(useAssetStudioDraftStore.getState().entries).find((e) => e.savedId === 'g1');

describe('the Board / List switch', () => {
  it('opens on List; Board shows the canvas and is remembered', async () => {
    await openStudio();
    expect(screen.getByRole('radio', { name: 'List' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Images (2)')).toBeTruthy();
    expect(screen.queryByTestId('board-canvas')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Board' }));
    expect(await screen.findByTestId('board-canvas')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Board' }).getAttribute('aria-checked')).toBe('true');
    expect(window.localStorage.getItem(MOODBOARD_VIEW_KEY)).toBe('board');
    expect(screen.queryByText('Images (2)')).toBeNull();
  });

  it('opening a board in the Board view writes nothing and leaves the draft clean', async () => {
    await openStudio({ view: 'board' });
    expect(screen.getByText('card #1 at 0,0')).toBeTruthy();
    expect(screen.getByText('card #2 at 520,0')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(server.edits).toEqual([]);
    expect(server.puts).toEqual([]);
    expect(entry()?.dirty).toBe(false);
  });

  it('with nothing selected the side panel holds the board: its fields, Direction and the brief', async () => {
    await openStudio({ view: 'board' });
    const panel = screen.getByRole('complementary', { name: 'Board' });
    expect(within(panel).getByDisplayValue('Global board')).toBeTruthy();
    expect(within(panel).getByRole('textbox', { name: 'What the board is for' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Analyze' })).toBeTruthy();
  });
});

describe('a drag on the board', () => {
  it('is one op, sent at once, and one undo step: Cmd+Z puts the card back, Shift+Cmd+Z again', async () => {
    await openStudio({ view: 'board' });
    act(() => board.props!.onMove([{ placement: 'c-i1', x: 300, y: 40 }]));
    expect(screen.getByText('card #1 at 300,40')).toBeTruthy();
    await waitFor(() => expect(server.edits).toEqual([[{ op: 'place', placement: 'c-i1', x: 300, y: 40 }]]), { timeout: 400 });
    // A move keeps the analysis.
    expect(server.board.analysis).not.toBeNull();

    press('z', { metaKey: true });
    await waitFor(() => expect(server.edits[1]).toEqual([{ op: 'restore', slices: [{ part: 'tag', tag: 'u1' }] }]));
    expect(await screen.findByText('card #1 at 0,0')).toBeTruthy();
    expect(server.board.images[0].placements?.[0]).toMatchObject({ x: 0, y: 0 });

    press('z', { metaKey: true, shiftKey: true });
    await waitFor(() => expect(server.edits[2]).toEqual([{ op: 'restore', slices: [{ part: 'tag', tag: 'u2' }] }]));
    expect(await screen.findByText('card #1 at 300,40')).toBeTruthy();
  });

  it('a step whose cards changed since says so instead of moving them', async () => {
    await openStudio({ view: 'board' });
    act(() => board.props!.onMove([{ placement: 'c-i2', x: 900, y: 0 }]));
    await waitFor(() => expect(server.edits).toHaveLength(1));
    server.skip = [{ part: 'card', image: 'i2', number: 2, reason: 'changed since', message: '#2 changed since, left as is' }];
    press('z', { metaKey: true });
    expect(await screen.findByText('#2 changed since, left as is')).toBeTruthy();
  });

  it('each step goes as its own batch, so one undo undoes only its own step', async () => {
    await openStudio({ view: 'board' });
    select('c-i1');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Image note' }), { target: { value: 'the orange' } });
    act(() => board.props!.onMove([{ placement: 'c-i2', x: 700, y: 20 }]));
    await waitFor(() => expect(server.edits).toHaveLength(2));
    expect(server.edits).toEqual([
      [{ op: 'note', image: 'i1', notes: 'the orange' }],
      [{ op: 'place', placement: 'c-i2', x: 700, y: 20 }],
    ]);
    press('z', { metaKey: true });
    await waitFor(() => expect(server.edits).toHaveLength(3));
    expect(server.edits[2]).toEqual([{ op: 'restore', slices: [{ part: 'tag', tag: 'u2' }] }]);
    expect(server.board.images[0].notes).toBe('the orange');
  });
});

describe('the cover (#123) in undo', () => {
  it('a pick is one undo step: Cmd+Z opens the board on #1 again, Shift+Cmd+Z brings the pick back', async () => {
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Use #2 as cover' }));
    expect(screen.getByText('Cover: #2')).toBeTruthy();
    await waitFor(() => expect(server.edits).toEqual([[{ op: 'cover', image: 'i2' }]]), { timeout: 2000 });
    // A pick keeps the analysis.
    expect(server.board.analysis).not.toBeNull();

    press('z', { metaKey: true });
    await waitFor(() => expect(server.edits[1]).toEqual([{ op: 'restore', slices: [{ part: 'tag', tag: 'u1' }] }]));
    expect(await screen.findByText('Cover: #1, the first image')).toBeTruthy();
    expect(server.board.coverImageId).toBeNull();
    expect(await screen.findByText(/Undid: Made #2 the cover/)).toBeTruthy();

    press('z', { metaKey: true, shiftKey: true });
    await waitFor(() => expect(server.edits[2]).toEqual([{ op: 'restore', slices: [{ part: 'tag', tag: 'u2' }] }]));
    expect(await screen.findByText('Cover: #2')).toBeTruthy();
  });

  it('picks made before the step is sent join it: one batch, and one undo goes back to before them', async () => {
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Use #2 as cover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use #1 as cover' }));
    await waitFor(() => expect(server.edits).toEqual([[{ op: 'cover', image: 'i1' }]]), { timeout: 2000 });
    expect(Object.values(useBoardUndoStore.getState().histories).flatMap((history) => history.done)).toHaveLength(1);

    press('z', { metaKey: true });
    await waitFor(() => expect(server.edits).toHaveLength(2));
    expect(server.board.coverImageId).toBeNull();
    expect(await screen.findByText('Cover: #1, the first image')).toBeTruthy();
  });

  it('a pick, then that image removed before the pick is sent: two batches, and Undo brings the image back as the cover', async () => {
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Use #2 as cover' }));
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>('.moodboard-tile__remove')[1]);
    expect(await screen.findByText('Cover: #1, the first image')).toBeTruthy();
    // Never one batch: the server refuses a batch that picks an image and takes it off.
    await waitFor(() => expect(server.edits).toEqual([[{ op: 'cover', image: 'i2' }], [{ op: 'remove', images: ['i2'] }]]));
    expect(server.board.images.map((img) => img.id)).toEqual(['i1']);

    press('z', { metaKey: true });
    await waitFor(() => expect(server.edits[2]).toEqual([{ op: 'restore', slices: [{ part: 'tag', tag: 'u2' }] }]));
    expect(await screen.findByText('Cover: #2')).toBeTruthy();
    expect(server.board.coverImageId).toBe('i2');
  });

  it('an undo that put nothing back (an agent changed the cover since) leaves no redo over their pick', async () => {
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Use #2 as cover' }));
    await waitFor(() => expect(server.edits).toEqual([[{ op: 'cover', image: 'i2' }]]), { timeout: 2000 });
    outsideWrite((current) => ({ ...current, coverImageId: 'i1' }));
    expect(await screen.findByText('Cover: #1')).toBeTruthy();
    // The server's restore finds the cover changed since: it puts nothing
    // back, and its answer has no `undo` (nothing to redo).
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      server.edits.push(ops);
      return { board: clone(server.board), version: server.board.version,
        applied: [{ index: 0, op: 'restore', status: 'unchanged', removed: [],
          skipped: [{ part: 'fields', field: 'coverImageId', reason: 'changed since', message: 'The cover changed since, left as is' }] }],
        undo: { ops: [] } };
    });
    press('z', { metaKey: true });
    expect(await screen.findByText('The cover changed since, left as is')).toBeTruthy();
    expect(server.edits).toHaveLength(2);

    press('z', { metaKey: true, shiftKey: true });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(server.edits).toHaveLength(2);
    expect(server.board.coverImageId).toBe('i1');
    expect(screen.queryByRole('button', { name: 'Redo' })).toBeNull();
  });
});

describe('edits made elsewhere', () => {
  it("rebase the board without losing the person's pending note", async () => {
    await openStudio({ view: 'board' });
    select('c-i1');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Image note' }), { target: { value: 'the orange' } });
    outsideWrite((current) => ({ ...current, images: [...current.images, image('cli1', { placements: [card('cli1', 1040, 0)] })] }));

    expect(await screen.findByText('card #3 at 1040,0')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Image note' }) as HTMLTextAreaElement).value).toBe('the orange');
    await waitFor(() => expect(server.board.images[0].notes).toBe('the orange'), { timeout: 3000 });
    expect(server.board.images.map((img) => img.id)).toEqual(['i1', 'i2', 'cli1']);
  });
});

describe('an agent on the board', () => {
  it("moves a card (moodboard_edit): the open Board view shows it without a reload, and the agent's undo puts it back", async () => {
    await openStudio({ view: 'board' });
    const moved = (x: number, y: number) => (current: Moodboard) => ({ ...current, images: current.images.map((img) => (
      img.id === 'i2' ? { ...img, placements: [card('i2', x, y)] } : img)) });
    outsideWrite(moved(900, 300));
    expect(await screen.findByText('card #2 at 900,300')).toBeTruthy();
    // Its undo is another write of the agent's: the card goes back.
    outsideWrite(moved(520, 0));
    expect(await screen.findByText('card #2 at 520,0')).toBeTruthy();
    // Following it wrote nothing, and the person's own Undo has no step of the agent's to take.
    press('z', { metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.edits).toEqual([]);
    expect(server.puts).toEqual([]);
    expect(entry()?.dirty).toBe(false);
  });
});

describe('Undo pressed while a step is still saving', () => {
  it('waits for the step to land, then undoes it', async () => {
    await openStudio({ view: 'board' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementationOnce(async (...args: Parameters<typeof real>) => { await gate; return real(...args); });
    act(() => board.props!.onMove([{ placement: 'c-i1', x: 300, y: 40 }]));
    await waitFor(() => expect(api.editMoodboard).toHaveBeenCalledTimes(1));
    press('z', { metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await waitFor(() => expect(server.edits[1]).toEqual([{ op: 'restore', slices: [{ part: 'tag', tag: 'u1' }] }]));
    expect(await screen.findByText('card #1 at 0,0')).toBeTruthy();
  });

  it('two quick presses undo the last two steps, one after the other', async () => {
    await openStudio({ view: 'board' });
    act(() => board.props!.onMove([{ placement: 'c-i1', x: 300, y: 40 }]));
    await waitFor(() => expect(server.edits).toHaveLength(1));
    act(() => board.props!.onMove([{ placement: 'c-i2', x: 900, y: 40 }]));
    await waitFor(() => expect(server.edits).toHaveLength(2));
    await waitFor(() => expect(entry()?.pendingSaveId).toBeFalsy());
    press('z', { metaKey: true });
    press('z', { metaKey: true });
    await waitFor(() => expect(server.edits).toHaveLength(4));
    expect(server.edits.slice(2)).toEqual([
      [{ op: 'restore', slices: [{ part: 'tag', tag: 'u2' }] }],
      [{ op: 'restore', slices: [{ part: 'tag', tag: 'u1' }] }],
    ]);
    expect(await screen.findByText('card #1 at 0,0')).toBeTruthy();
    expect(screen.getByText('card #2 at 520,0')).toBeTruthy();
  });
});

describe('List and Board', () => {
  it('show the same board: a weight set in List is the panel weight; a move in Board keeps the List order', async () => {
    await openStudio();
    fireEvent.change(screen.getAllByRole('slider', { name: /^Weight/ })[1], { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Board' }));
    await screen.findByTestId('board-canvas');
    select('c-i2');
    const panel = await screen.findByRole('complementary', { name: 'Reference #2' });
    expect((within(panel).getByRole('slider', { name: /^Weight/ }) as HTMLInputElement).value).toBe('0.5');

    act(() => board.props!.onMove([{ placement: 'c-i2', x: -600, y: 0 }]));
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    const numbers = screen.getAllByLabelText(/^Image \d/).map((badge) => badge.textContent);
    expect(numbers).toEqual(['#1', '#2']);
    const sliders = screen.getAllByRole('slider', { name: /^Weight/ }) as HTMLInputElement[];
    expect(sliders.map((slider) => slider.value)).toEqual(['1', '0.5']);
    await waitFor(() => expect(server.board.images.map((img) => [img.id, img.weight, img.placements?.[0].x]))
      .toEqual([['i1', 1, 0], ['i2', 0.5, -600]]), { timeout: 3000 });
  });
});

describe("the Studio's keys", () => {
  it("Cmd+S saves the board and doesn't open the canvas's graph save", async () => {
    await openStudio({ view: 'board', withGraphActions: true });
    select('c-i1');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Image note' }), { target: { value: 'saved now' } });
    const event = press('s', { metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(server.edits).toEqual([[{ op: 'note', image: 'i1', notes: 'saved now' }]]), { timeout: 300 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(graphFile.saveToFile).not.toHaveBeenCalled();
  });

  it('Cmd+S in the List view is the board\'s too: no graph save dialog over the Studio', async () => {
    await openStudio({ withGraphActions: true });
    const event = press('s', { metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(graphFile.saveToFile).not.toHaveBeenCalled();
  });

  it('Delete removes the selected references at once and offers Undo', async () => {
    await openStudio({ view: 'board' });
    select('c-i1');
    press('Delete');
    await waitFor(() => expect(server.edits).toEqual([[{ op: 'remove', images: ['i1'] }]]), { timeout: 400 });
    expect(screen.queryByText(/^card #\d at 0,0$/)).toBeNull();
    const toast = await screen.findByRole('status', { name: 'Board undo' });
    expect(toast.textContent).toContain('Removed #1');
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(server.edits[1]).toEqual([{ op: 'restore', slices: [{ part: 'tag', tag: 'u1' }] }]));
    expect(await screen.findByText('card #1 at 0,0')).toBeTruthy();
    expect(server.board.images.map((img) => img.id)).toEqual(['i1', 'i2']);
  });

  it('keys typed in a text field stay the field\'s: Delete edits the note, Cmd+Z is the field\'s own', async () => {
    await openStudio({ view: 'board' });
    select('c-i1');
    const note = await screen.findByRole('textbox', { name: 'Image note' });
    act(() => board.props!.onMove([{ placement: 'c-i1', x: 10, y: 10 }]));
    await waitFor(() => expect(server.edits).toHaveLength(1));
    note.focus();
    const del = press('Delete', {}, note);
    const undo = press('z', { metaKey: true }, note);
    expect(del.defaultPrevented).toBe(false);
    expect(undo.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.edits).toHaveLength(1);
  });

  it('Delete does nothing in the List view, where each image has its own remove button', async () => {
    await openStudio();
    useBoardCanvasStore.getState().setSelection(JSON.stringify(['moodboard', 'global', 'g1']), ['c-i1']);
    press('Delete');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.edits).toEqual([]);
  });
});
