import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Moodboard, MoodboardImage } from '../../types';

// The Studio and outside writers on one board (moodboard canvas PR3): image
// edits go to the board as checked edits, a PUT carries board fields only,
// and the open board follows edits made elsewhere (an agent, the CLI).

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
import { TAB_ID } from '../../lib/tabId';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';

const analysis = { version: 5, sourceHash: 'h1', summary: 'Warm.', palette: ['#e8593c'], accents: [] };
const card = (id: string, weight = 1) => ({ id: `c-${id}`, frameId: null, x: 0, y: 0, w: 480, h: 270, weight,
  placedBy: 'person' as const, placedAt: '2026-10-20T00:00:00+00:00' });
const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, placements: [card(id)], ...extra });

/** The backend, as far as these tests need it: one board, its version, PUT
 *  merging what it is sent (name and Direction trimmed, as the store does)
 *  and /edits applying ops (refusing the batch for an op on an image that
 *  isn't there), each refusing a stale baseVersion with the board as it is
 *  now. */
const server: { board: Moodboard; puts: Record<string, unknown>[]; edits: MoodboardOp[][] } = {
  board: null as unknown as Moodboard, puts: [], edits: [],
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function serverEdit(board: Moodboard, op: MoodboardOp): Moodboard {
  const steers = ['add', 'remove', 'weight', 'setAside'].includes(op.op) || (op.op === 'note' && 'notes' in op);
  const next = { ...board, analysis: steers ? null : board.analysis };
  const change = (id: string, patch: Partial<MoodboardImage>) => {
    if (!next.images.some((img) => img.id === id)) throw new Error(`${op.op}: no image '${id}' on this board`);
    next.images = next.images.map((img) => (img.id === id ? { ...img, ...patch } : img));
  };
  if (op.op === 'add') next.images = [...next.images, ...op.images!.map((img) => image(img.id!, { url: img.url }))];
  if (op.op === 'remove') next.images = next.images.filter((img) => !op.images.includes(img.id));
  if (op.op === 'weight') change(String(op.image), { weight: op.value });
  if (op.op === 'setAside') change(String(op.image), { excluded: op.value });
  if (op.op === 'note') change(String(op.image), { ...('notes' in op ? { notes: op.notes } : {}),
    ...('privateNote' in op ? { privateNote: op.privateNote } : {}) });
  return next;
}

function outsideWrite(update: (board: Moodboard) => Moodboard, { announce = true } = {}) {
  server.board = { ...update(clone(server.board)), version: server.board.version + 1 };
  if (!announce) return;
  act(() => {
    for (const handler of socket.handlers) {
      handler({ type: 'storedAssetChanged', kind: 'moodboard', id: server.board.id, deleted: false,
        version: server.board.version, edit: { actor: { kind: 'agent', name: 'Claude' } } });
    }
  });
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  socket.handlers.clear();
  server.board = {
    id: 'g1', name: 'Global board', version: 1, notes: '', mode: 'look', strength: 0.7,
    images: [image('i1')], analysis, direction: '', avoid: [], pinnedColors: { include: [], exclude: [] },
    briefOverride: null, thumbnail: '/api/outputs/i1.png', createdAt: '', updatedAt: '',
  } as unknown as Moodboard;
  server.puts = [];
  server.edits = [];
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
    for (const key of ['name', 'direction'] as const) {
      if (typeof fields[key] === 'string') fields[key] = (fields[key] as string).trim();
    }
    server.board = { ...server.board, ...fields, version: server.board.version + 1 } as Moodboard;
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
  await screen.findByDisplayValue('Global board');
}

const weightSlider = (index = 0) => screen.getAllByRole('slider', { name: /^Weight/ })[index];

describe('Moodboard Studio follows edits made elsewhere', () => {
  it('a storedAssetChanged for the open board updates the draft without a reload', async () => {
    await openStudio();
    expect(screen.getByText('Images (1)')).toBeTruthy();
    outsideWrite((board) => ({ ...board, images: [...board.images, image('cli1')], notes: 'from the CLI' }));
    expect(await screen.findByText('Images (2)')).toBeTruthy();
    expect(screen.getByDisplayValue('from the CLI')).toBeTruthy();
    // Nothing was the person's to save.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(server.puts).toEqual([]);
    expect(server.edits).toEqual([]);
  });

  it("a CLI add racing the person's weight edit keeps both", async () => {
    await openStudio();
    fireEvent.change(weightSlider(), { target: { value: '0.5' } });
    outsideWrite((board) => ({ ...board, images: [...board.images, image('cli1')] }));

    await waitFor(() => expect(server.board.images.find((img) => img.id === 'i1')?.weight).toBe(0.5), { timeout: 3000 });
    expect(server.board.images.map((img) => img.id)).toEqual(['i1', 'cli1']);
    expect(await screen.findByText('Images (2)')).toBeTruthy();
    expect((weightSlider(0) as HTMLInputElement).value).toBe('0.5');
  });

  it('a write it never heard about comes back as a 409: it rebases and sends again', async () => {
    await openStudio();
    fireEvent.change(weightSlider(), { target: { value: '0.3' } });
    outsideWrite((board) => ({ ...board, images: [...board.images, image('cli1')], name: 'Renamed by Claude' }),
      { announce: false });

    await waitFor(() => expect(server.board.images.find((img) => img.id === 'i1')?.weight).toBe(0.3), { timeout: 3000 });
    expect(server.board.images.map((img) => img.id)).toEqual(['i1', 'cli1']);
    expect(server.board.name).toBe('Renamed by Claude');
    expect(await screen.findByDisplayValue('Renamed by Claude')).toBeTruthy();
    expect(screen.getByText('Images (2)')).toBeTruthy();
  });

  it("an edit to the open board keeps the person's unsaved board fields and pending note", async () => {
    await openStudio();
    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'My name' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Image note' }), { target: { value: 'the orange' } });
    outsideWrite((board) => ({ ...board, strength: 0.2, images: [...board.images, image('cli1')] }));

    await waitFor(() => expect(server.board.name).toBe('My name'), { timeout: 3000 });
    await waitFor(() => expect(server.board.images[0].notes).toBe('the orange'), { timeout: 3000 });
    expect(server.board.strength).toBe(0.2);
    expect(server.board.images.map((img) => img.id)).toEqual(['i1', 'cli1']);
    expect(screen.getByDisplayValue('My name')).toBeTruthy();
    expect(screen.getAllByRole('textbox', { name: 'Image note' }).map((box) => (box as HTMLTextAreaElement).value))
      .toEqual(['the orange', '']);
  });

  it('ignores the echo of its own write', async () => {
    await openStudio();
    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'Echoed' } });
    await waitFor(() => expect(server.board.name).toBe('Echoed'), { timeout: 3000 });
    const reads = api.fetchMoodboard.mock.calls.length;
    act(() => {
      for (const handler of socket.handlers) {
        handler({ type: 'storedAssetChanged', kind: 'moodboard', id: 'g1', deleted: false,
          version: server.board.version, edit: { actor: { kind: 'person' }, tab: TAB_ID } });
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.fetchMoodboard.mock.calls.length).toBe(reads);
  });
});

describe('Moodboard Studio sends image edits as checked edits', () => {
  it('a PUT carries board fields only, with baseVersion; image changes go as ops', async () => {
    await openStudio();
    fireEvent.change(screen.getByRole('textbox', { name: 'Private note' }), { target: { value: 'liked' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Set aside' }));
    await waitFor(() => expect(server.edits.length).toBeGreaterThan(0), { timeout: 3000 });
    const ops = server.edits.flat();
    expect(ops).toEqual(expect.arrayContaining([
      { op: 'note', image: 'i1', privateNote: 'liked' },
      { op: 'setAside', image: 'i1', value: true },
    ]));
    expect(api.editMoodboard.mock.calls[0][2]).toBe(1);
    expect(server.puts).toEqual([]);

    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'Renamed' } });
    await waitFor(() => expect(server.puts.length).toBe(1), { timeout: 3000 });
    const [body] = server.puts;
    expect(body).toMatchObject({ name: 'Renamed', baseVersion: server.board.version - 1 });
    expect(body).not.toHaveProperty('images');
    expect(body).not.toHaveProperty('analysis');
  });

  it('typing a note sends one op, after a pause or on blur', async () => {
    await openStudio();
    const note = screen.getByRole('textbox', { name: 'Image note' });
    for (const value of ['t', 'te', 'tea', 'teal']) fireEvent.change(note, { target: { value } });
    fireEvent.blur(note);
    await waitFor(() => expect(server.edits.length).toBe(1));
    expect(server.edits[0]).toEqual([{ op: 'note', image: 'i1', notes: 'teal' }]);
    expect(server.board.analysis).toBeNull();
  });

  it('removing and adding go as ops too', async () => {
    server.board = { ...server.board, images: [image('i1'), image('i2')] };
    await openStudio();
    fireEvent.click(screen.getAllByRole('button', { name: 'x' })[0]);
    await waitFor(() => expect(server.edits.flat()).toEqual([{ op: 'remove', images: ['i1'] }]), { timeout: 3000 });
    expect(server.board.images.map((img) => img.id)).toEqual(['i2']);
  });
});

describe('Moodboard Studio after the races reviewers found', () => {
  it('a field the server cleaned still takes the next outside edit', async () => {
    await openStudio();
    const direction = screen.getByRole('textbox', { name: 'What the board is for' });
    fireEvent.change(direction, { target: { value: 'warm dusk ' } });
    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'Moodboard ' } });
    await waitFor(() => expect(server.board.direction).toBe('warm dusk'), { timeout: 3000 });
    expect(server.board.name).toBe('Moodboard');

    outsideWrite((board) => ({ ...board, direction: 'cold', name: 'Refs' }));
    expect(await screen.findByDisplayValue('cold')).toBeTruthy();
    expect(screen.getByDisplayValue('Refs')).toBeTruthy();

    const puts = server.puts.length;
    fireEvent.change(weightSlider(), { target: { value: '0.4' } });
    await waitFor(() => expect(server.board.images[0].weight).toBe(0.4), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(server.puts.length).toBe(puts);
    expect(server.board.direction).toBe('cold');
    expect(server.board.name).toBe('Refs');
  });

  it('a pending edit on an image someone removed is dropped, and the rest still saves', async () => {
    server.board = { ...server.board, images: [image('i1'), image('i2')] };
    await openStudio();
    fireEvent.change(weightSlider(1), { target: { value: '0.5' } });
    outsideWrite((board) => ({ ...board, images: board.images.filter((img) => img.id !== 'i2') }));
    await screen.findByText('Images (1)');
    fireEvent.change(weightSlider(0), { target: { value: '0.3' } });

    await waitFor(() => expect(server.board.images[0].weight).toBe(0.3), { timeout: 3000 });
    expect(server.edits.flat()).toEqual([{ op: 'weight', image: 'i1', value: 0.3 }]);
    expect(screen.queryByText(/Save failed|Retry/)).toBeNull();
  });

  it('an outside write announced mid-save is read once the save lands, and a mid-save edit goes next', async () => {
    server.board = { ...server.board, images: [image('i1'), image('i2')] };
    let land: () => void = () => {};
    api.editMoodboard.mockImplementationOnce(async (_id: string, ops: MoodboardOp[]) => {
      // The batch reaches the server at once; its answer is held back.
      server.edits.push(ops);
      server.board = { ...ops.reduce(serverEdit, server.board), version: server.board.version + 1 };
      const answer = { board: clone(server.board), version: server.board.version, applied: [], undo: { ops: [] } };
      await new Promise<void>((resolve) => { land = resolve; });
      return answer;
    });
    await openStudio();
    fireEvent.change(weightSlider(0), { target: { value: '0.5' } });
    await waitFor(() => expect(server.edits.length).toBe(1), { timeout: 3000 });

    // While it is in flight, an agent adds an image and the person moves #2's weight.
    outsideWrite((board) => ({ ...board, images: [...board.images, image('cli1')] }));
    fireEvent.change(weightSlider(1), { target: { value: '0.2' } });
    const reads = api.fetchMoodboard.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.fetchMoodboard.mock.calls.length).toBe(reads);  // not mid-save

    await act(async () => { land(); });
    expect(await screen.findByText('Images (3)')).toBeTruthy();
    await waitFor(() => expect(server.edits.length).toBe(2), { timeout: 3000 });
    expect(api.fetchMoodboard.mock.calls.length).toBe(reads + 1);
    expect(server.edits[1]).toEqual([{ op: 'weight', image: 'i2', value: 0.2 }]);
    expect(server.board.images.map((img) => [img.id, img.weight])).toEqual([['i1', 0.5], ['i2', 0.2], ['cli1', 1]]);
  });

  it('the batch lands, then the PUT gets a 409: it rebases, keeps the changed fields and sends only them again', async () => {
    const land = api.editMoodboard.getMockImplementation()!;
    api.editMoodboard.mockImplementationOnce(async (...args: Parameters<typeof land>) => {
      const answer = await land(...args);
      // Someone writes between the batch and the PUT, and nobody hears of it.
      outsideWrite((board) => ({ ...board, direction: 'from the CLI', strength: 0.2 }), { announce: false });
      return answer;
    });
    await openStudio();
    fireEvent.change(weightSlider(), { target: { value: '0.4' } });
    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'My name' } });

    await waitFor(() => expect(server.puts.length).toBe(2), { timeout: 3000 });
    // The ops went once, with the version read; the PUT after them carried the
    // batch's version, was refused, and went again on the board the 409 gave.
    expect(server.edits).toEqual([[{ op: 'weight', image: 'i1', value: 0.4 }]]);
    expect(api.editMoodboard.mock.calls[0][2]).toBe(1);
    expect(server.puts[0]).toMatchObject({ name: 'My name', baseVersion: 2 });
    expect(server.puts[1]).toEqual({ name: 'My name', baseVersion: 3 });
    expect(server.board).toMatchObject({ name: 'My name', direction: 'from the CLI', strength: 0.2, version: 4 });
    expect(server.board.images[0].weight).toBe(0.4);
    expect(screen.getByDisplayValue('My name')).toBeTruthy();
    expect(await screen.findByDisplayValue('from the CLI')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(server.puts.length).toBe(2);
    expect(server.edits.length).toBe(1);
    expect(screen.queryByText(/Save failed|Retry/)).toBeNull();
  });
});
