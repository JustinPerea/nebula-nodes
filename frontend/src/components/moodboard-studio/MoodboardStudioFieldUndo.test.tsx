import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Moodboard, MoodboardImage, MoodboardPlacement } from '../../types';

// Board fields as undo steps (Q83, Justin: "A field becomes one step when you
// leave it, and Cmd+Z inside a text box still undoes your typing first").
// Each change to Direction, Avoid, the pinned colours, strength and the other
// board fields is one step in the Studio's one undo queue (#127's), committed
// when a text field loses focus or when a control's change is done. Its undo
// is the `restore` the PUT answered with, sent back through the server.

const api = vi.hoisted(() => ({
  analyzeMoodboard: vi.fn(), createMoodboard: vi.fn(), editMoodboard: vi.fn(), fetchMoodboard: vi.fn(),
  fetchMoodboards: vi.fn(), keepMoodboardBriefOverride: vi.fn(), lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(), updateMoodboard: vi.fn(),
}));
const socket = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
const board = vi.hoisted(() => ({ props: null as null | {
  boardKey: string; images: MoodboardImage[];
  onMove: (moves: Array<{ placement: string; x: number; y: number }>) => void;
} }));
vi.mock('../../lib/api', () => api);
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
import { MoodboardVersionConflict, type MoodboardOp } from '../../lib/moodboardEdits';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import { useBoardUndoStore } from '../../lib/boardUndo';

const card = (id: string, x = 0, y = 0): MoodboardPlacement => ({ id: `c-${id}`, frameId: null, x, y, w: 480, h: 270,
  weight: 1, placedBy: 'person', placedAt: '2026-10-20T00:00:00+00:00' });
const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, placements: [card(id)], ...extra });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The server's words for a field it left as is (services/moodboard_edits FIELD_LABELS).
const LABELS: Record<string, string> = {
  name: 'The name', notes: "The board's notes", mode: 'Mode', strength: 'Strength', direction: 'Direction',
  avoid: 'The Avoid list', pinnedColors: 'The pinned colours', clashMode: 'The clash mode',
  colorChoices: 'The colour choices', sendNotes: 'Send notes to generators', briefOverride: 'The hand-written brief',
};
const FIELDS = Object.keys(LABELS);
type Slice = { part: string; before: Record<string, unknown>; expect: Record<string, unknown>; image?: string; placement?: string };

/** The backend as these tests need it. A PUT merges its fields and answers
 *  with the board plus `undo`, a `restore` of a `fields` slice (what it
 *  changed, before and after). `/edits` applies `place` and `restore`: a
 *  field or card still as the slice expects goes back, one changed since is
 *  left and named. Every answer's `undo` is the restore of its own diff. */
const server = {
  board: null as unknown as Moodboard,
  puts: [] as Record<string, unknown>[],
  putUndos: [] as MoodboardOp[][],
  edits: [] as MoodboardOp[][],
};

function diffUndo(before: Moodboard, after: Moodboard): MoodboardOp[] {
  const slices: Slice[] = [];
  const changed = FIELDS.filter((key) => !same((before as unknown as Record<string, unknown>)[key],
    (after as unknown as Record<string, unknown>)[key]));
  for (const img of after.images) {
    const was = before.images.find((other) => other.id === img.id);
    const settings = (['weight', 'notes'] as const).filter((name) => was && was[name] !== img[name]);
    if (was && settings.length) {
      slices.push({ part: 'settings', image: img.id, before: Object.fromEntries(settings.map((name) => [name, was[name]])),
        expect: Object.fromEntries(settings.map((name) => [name, img[name]])) });
    }
    for (const placement of img.placements ?? []) {
      const old = was?.placements?.find((p) => p.id === placement.id);
      if (old && !same(old, placement)) {
        slices.push({ part: 'card', image: img.id, placement: placement.id, before: clone(old) as never, expect: clone(placement) as never });
      }
    }
  }
  if (changed.length) {
    const pick = (b: Moodboard) => Object.fromEntries(changed.map((key) => [key, clone((b as unknown as Record<string, unknown>)[key] ?? null)]));
    slices.push({ part: 'fields', before: pick(before), expect: pick(after) });
  }
  return slices.length ? [{ op: 'restore', slices } as unknown as MoodboardOp] : [];
}

function applyOp(next: Moodboard, op: MoodboardOp, skipped: Array<Record<string, unknown>>) {
  if (op.op === 'place') {
    next.images = next.images.map((img) => ({ ...img, placements: img.placements?.map((p) => (
      p.id === op.placement ? { ...p, x: op.x, y: op.y } : p)) }));
  }
  if (op.op === 'weight') next.images = next.images.map((img) => (img.id === op.image ? { ...img, weight: op.value } : img));
  if (op.op === 'note' && 'notes' in op) next.images = next.images.map((img) => (img.id === op.image ? { ...img, notes: op.notes! } : img));
  if (op.op === 'restore') {
    for (const slice of op.slices as unknown as Slice[]) {
      if (slice.part === 'fields') {
        const fields = next as unknown as Record<string, unknown>;
        for (const key of Object.keys(slice.before)) {
          if (same(fields[key], slice.before[key])) continue;
          if (!same(fields[key], slice.expect[key])) {
            skipped.push({ part: 'fields', field: key, reason: 'changed since', message: `${LABELS[key]} changed since, left as is` });
            continue;
          }
          fields[key] = clone(slice.before[key]);
        }
      }
      if (slice.part === 'settings') {
        next.images = next.images.map((img) => {
          if (img.id !== slice.image) return img;
          const back = Object.fromEntries(Object.keys(slice.before).filter((name) => same(img[name as keyof MoodboardImage],
            slice.expect[name])).map((name) => [name, slice.before[name]]));
          return { ...img, ...back };
        });
      }
      if (slice.part === 'card') {
        next.images = next.images.map((img) => (img.id !== slice.image ? img : { ...img, placements: img.placements?.map((p) => {
          if (p.id !== slice.placement) return p;
          if (same(p, slice.before)) return p;
          if (!same(p, slice.expect)) {
            skipped.push({ part: 'card', image: img.id, reason: 'changed since', message: '#1 changed since, left as is' });
            return p;
          }
          return clone(slice.before) as unknown as MoodboardPlacement;
        }) }));
      }
    }
  }
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
  socket.handlers.clear();
  board.props = null;
  server.board = {
    id: 'g1', name: 'Global board', version: 1, notes: '', mode: 'look', strength: 0.7,
    images: [image('i1'), image('i2', { placements: [card('i2', 520, 0)] })],
    analysis: { version: 5, sourceHash: 'h1', summary: 'Warm.', palette: ['#e8593c'], accents: [], images: [] },
    direction: '', avoid: [], pinnedColors: { include: [], exclude: [] }, briefOverride: null,
    clashMode: 'leave-out', colorChoices: { keep: [], leaveOut: [] }, sendNotes: false,
    thumbnail: '/api/outputs/i1.png', createdAt: '', updatedAt: '',
  } as unknown as Moodboard;
  server.puts = [];
  server.putUndos = [];
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
    delete fields.projectId;
    const before = clone(server.board);
    const after = { ...server.board, ...fields } as Moodboard;
    const undo = diffUndo(before, after);
    server.board = { ...after, version: undo.length ? server.board.version + 1 : server.board.version };
    server.putUndos.push(undo);
    return { ...clone(server.board), undo: { ops: undo } };
  });
  api.editMoodboard.mockImplementation(async (_id: string, ops: MoodboardOp[], baseVersion?: number) => {
    server.edits.push(ops);
    if (typeof baseVersion === 'number' && baseVersion !== server.board.version) {
      throw new MoodboardVersionConflict(clone(server.board));
    }
    const before = clone(server.board);
    const next = clone(server.board);
    const applied = ops.map((op, index) => {
      const skipped: Array<Record<string, unknown>> = [];
      applyOp(next, op, skipped);
      return { index, op: op.op, status: 'applied' as const, ...(op.op === 'restore' ? { skipped, removed: [] } : {}) };
    });
    const undo = diffUndo(before, next);
    server.board = { ...next, version: undo.length ? server.board.version + 1 : server.board.version };
    return { board: clone(server.board), version: server.board.version, applied, undo: { ops: undo } };
  });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  useBoardUndoStore.setState({ histories: {} });
  useBoardCanvasStore.setState({ view: 'list', selection: {}, viewports: {} });
  setOpenProject(['p1', 'Project']);
});
afterEach(() => cleanup());

async function openStudio({ view = 'list' as 'list' | 'board' } = {}) {
  useBoardCanvasStore.setState({ view });
  act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
  render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
  await screen.findByDisplayValue('Global board');
  if (view === 'board') await screen.findByTestId('board-canvas');
}
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const undo = (target?: Element) => press('z', { metaKey: true }, target);
const redo = (target?: Element) => press('z', { metaKey: true, shiftKey: true }, target);
const direction = () => screen.getByRole('textbox', { name: 'What the board is for' }) as HTMLTextAreaElement;
const strength = () => screen.getByRole('slider', { name: /^Strength/ }) as HTMLInputElement;
const restores = () => server.edits.filter((ops) => ops.every((op) => op.op === 'restore'));
const settled = () => waitFor(() => expect(Object.values(useAssetStudioDraftStore.getState().entries)
  .find((e) => e.savedId === 'g1')).toMatchObject({ dirty: false, pendingSaveId: null }), { timeout: 3000 });
const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

/** Type into a text field as a person does: focus, a few changes, leave. */
async function typeInto(field: HTMLElement, values: string[], { leave = true } = {}) {
  act(() => { field.focus(); });
  fireEvent.focus(field);
  for (const value of values) fireEvent.change(field, { target: { value } });
  if (leave) {
    act(() => { field.blur(); });
    fireEvent.blur(field);
  }
}

describe('a text field is one step when you leave it', () => {
  it('Direction: edit, leave, Cmd+Z puts it back through the server with the PUT\'s own undo', async () => {
    await openStudio();
    await typeInto(direction(), ['w', 'wa', 'warm', 'warm dusk']);
    await waitFor(() => expect(server.board.direction).toBe('warm dusk'), { timeout: 3000 });
    await settled();
    expect(server.puts).toHaveLength(1);

    const event = undo();
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(restores()).toHaveLength(1));
    // The undo is the PUT's answer, as the server gave it: never a guess.
    expect(restores()[0]).toEqual(server.putUndos[0]);
    expect(restores()[0]).toEqual([{ op: 'restore', slices: [
      { part: 'fields', before: { direction: '' }, expect: { direction: 'warm dusk' } }] }]);
    await waitFor(() => expect(server.board.direction).toBe(''));
    await waitFor(() => expect(direction().value).toBe(''));
    expect((await screen.findByRole('status', { name: 'Board undo' })).textContent).toMatch(/Undid:? Direction/);
  });

  it('typing then Cmd+Z inside the textarea is the textarea\'s own undo, not a Studio step', async () => {
    await openStudio();
    await typeInto(direction(), ['warm', 'warm dusk'], { leave: false });
    const event = undo(direction());
    expect(event.defaultPrevented).toBe(false);
    const redoEvent = redo(direction());
    expect(redoEvent.defaultPrevented).toBe(false);
    await pause(800);
    expect(restores()).toEqual([]);
  });

  it('two changes to one field in one focus are one step, even when a save went out between them', async () => {
    await openStudio();
    await typeInto(direction(), ['warm'], { leave: false });
    await waitFor(() => expect(server.board.direction).toBe('warm'), { timeout: 3000 });
    await typeInto(direction(), ['warm editorial']);
    await waitFor(() => expect(server.board.direction).toBe('warm editorial'), { timeout: 3000 });
    await settled();
    expect(server.puts).toHaveLength(2);

    undo();
    await waitFor(() => expect(server.board.direction).toBe(''));
    expect(restores()).toHaveLength(1);
    // Both answers' undos, the later first, in one batch.
    expect(restores()[0]).toEqual([...server.putUndos[1], ...server.putUndos[0]]);
    await settled();
    undo();
    await pause(300);
    expect(restores()).toHaveLength(1);
  });

  it('leaving a field you did not change adds no step', async () => {
    await openStudio();
    await typeInto(direction(), []);
    await typeInto(direction(), ['warm', '']);
    await pause(800);
    expect(useBoardUndoStore.getState().histories[Object.keys(useBoardUndoStore.getState().histories)[0]]?.done ?? [])
      .toEqual([]);
    undo();
    await pause(300);
    expect(server.edits).toEqual([]);
  });

  it('typed, saved, then put back as it was before leaving: no step, and the board is as it was', async () => {
    await openStudio();
    await typeInto(direction(), ['warm'], { leave: false });
    await waitFor(() => expect(server.board.direction).toBe('warm'), { timeout: 3000 });
    await typeInto(direction(), ['']);
    await waitFor(() => expect(server.board.direction).toBe(''), { timeout: 3000 });
    await settled();
    expect(Object.values(useBoardUndoStore.getState().histories)[0]?.done ?? []).toEqual([]);
    undo();
    await pause(300);
    expect(server.edits).toEqual([]);
  });

  it('your own brief: typed and left is one step, named "Your brief"', async () => {
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Write your own' }));
    await waitFor(() => expect(server.board.briefOverride).toEqual({ text: '' }), { timeout: 3000 });
    await settled();
    const box = screen.getByRole('textbox', { name: 'Your brief' });
    await typeInto(box, ['Soft', 'Soft dusk light']);
    await waitFor(() => expect(server.board.briefOverride).toEqual({ text: 'Soft dusk light' }), { timeout: 3000 });
    await settled();
    undo();
    await waitFor(() => expect(server.board.briefOverride).toEqual({ text: '' }));
    expect(await screen.findByText(/Undid:? Your brief/)).toBeTruthy();
    await settled();
    undo();
    await waitFor(() => expect(server.board.briefOverride).toBeNull());
    expect(restores()).toHaveLength(2);
  });

  it('redo puts it back with the restore the undo answered with', async () => {
    await openStudio();
    await typeInto(direction(), ['warm dusk']);
    await waitFor(() => expect(server.board.direction).toBe('warm dusk'), { timeout: 3000 });
    await settled();
    undo();
    await waitFor(() => expect(server.board.direction).toBe(''));
    await settled();
    const event = redo();
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(server.board.direction).toBe('warm dusk'));
    expect(restores()).toHaveLength(2);
    expect(restores()[1]).toEqual([{ op: 'restore', slices: [
      { part: 'fields', before: { direction: 'warm dusk' }, expect: { direction: '' } }] }]);
    expect((await screen.findByText(/Redid:? Direction/))).toBeTruthy();
    await waitFor(() => expect(direction().value).toBe('warm dusk'));
  });
});

describe('a control is one step when its change is done', () => {
  it('the strength slider is one step on release, and Cmd+Z on the slider is the Studio\'s', async () => {
    await openStudio();
    const slider = strength();
    act(() => { slider.focus(); });
    fireEvent.pointerDown(slider);
    for (const value of ['0.6', '0.5', '0.4']) fireEvent.change(slider, { target: { value } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(server.board.strength).toBe(0.4), { timeout: 3000 });
    await settled();

    const event = undo(slider);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(server.board.strength).toBe(0.7));
    expect(restores()).toHaveLength(1);
    expect((await screen.findByRole('status', { name: 'Board undo' })).textContent).toMatch(/Undid:? Strength/);
    await settled();
    undo();
    await pause(300);
    expect(restores()).toHaveLength(1);
  });

  it('arrow keys on the focused slider are one step; Cmd+Z there closes and undoes it', async () => {
    await openStudio();
    const slider = strength();
    act(() => { slider.focus(); });
    for (const value of ['0.65', '0.6']) {
      fireEvent.keyDown(slider, { key: 'ArrowLeft' });
      fireEvent.change(slider, { target: { value } });
      fireEvent.keyUp(slider, { key: 'ArrowLeft' });
    }
    await waitFor(() => expect(server.board.strength).toBe(0.6), { timeout: 3000 });
    await settled();
    undo(slider);
    await waitFor(() => expect(server.board.strength).toBe(0.7));
    expect(restores()).toHaveLength(1);
  });

  it('a colour pick is one step: two picks, Cmd+Z takes back only the last', async () => {
    await openStudio();
    const hex = screen.getByRole('textbox', { name: 'Colors that must appear: hex' });
    const add = within(hex.parentElement!).getByRole('button', { name: 'Add' });
    fireEvent.change(hex, { target: { value: '#112233' } });
    fireEvent.click(add);
    await waitFor(() => expect(server.board.pinnedColors?.include).toEqual(['#112233']), { timeout: 3000 });
    await settled();
    fireEvent.change(hex, { target: { value: '#e8593c' } });
    fireEvent.click(add);
    await waitFor(() => expect(server.board.pinnedColors?.include).toEqual(['#112233', '#e8593c']), { timeout: 3000 });
    await settled();

    undo();
    await waitFor(() => expect(server.board.pinnedColors?.include).toEqual(['#112233']));
    expect((await screen.findByRole('status', { name: 'Board undo' })).textContent).toMatch(/Undid:? Pinned colors/);
    await settled();
    undo();
    await waitFor(() => expect(server.board.pinnedColors?.include).toEqual([]));
    expect(restores()).toHaveLength(2);
  });

  it('a second pick made while the first one\'s save is still out is its own step', async () => {
    let land: () => void = () => {};
    const put = api.updateMoodboard.getMockImplementation()!;
    api.updateMoodboard.mockImplementationOnce(async (...args: Parameters<typeof put>) => {
      const answer = await put(...args);
      await new Promise<void>((resolve) => { land = resolve; });
      return answer;
    });
    await openStudio();
    const hex = screen.getByRole('textbox', { name: 'Colors that must appear: hex' });
    const add = within(hex.parentElement!).getByRole('button', { name: 'Add' });
    fireEvent.change(hex, { target: { value: '#112233' } });
    fireEvent.click(add);
    await waitFor(() => expect(server.puts).toHaveLength(1), { timeout: 3000 });
    fireEvent.change(hex, { target: { value: '#e8593c' } });
    fireEvent.click(add);
    await act(async () => { land(); });
    await waitFor(() => expect(server.board.pinnedColors?.include).toEqual(['#112233', '#e8593c']), { timeout: 3000 });
    await settled();

    undo();
    await waitFor(() => expect(server.board.pinnedColors?.include).toEqual(['#112233']));
    await settled();
    undo();
    await waitFor(() => expect(server.board.pinnedColors?.include).toEqual([]));
    expect(restores()).toHaveLength(2);
  });

  it('an Avoid item, the mode and the Send notes switch are a step each, named in the toast', async () => {
    await openStudio();
    const avoid = screen.getByRole('textbox', { name: 'Add to the avoid list' });
    fireEvent.change(avoid, { target: { value: 'neon' } });
    fireEvent.keyDown(avoid, { key: 'Enter' });
    await waitFor(() => expect(server.board.avoid).toEqual(['neon']), { timeout: 3000 });
    await settled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'world' } });
    await waitFor(() => expect(server.board.mode).toBe('world'), { timeout: 3000 });
    await settled();
    fireEvent.click(screen.getByRole('switch', { name: /Send these notes/ }));
    await waitFor(() => expect(server.board.sendNotes).toBe(true), { timeout: 3000 });
    await settled();

    undo();
    await waitFor(() => expect(server.board.sendNotes).toBe(false));
    expect(await screen.findByText(/Undid:? Send notes to generators/)).toBeTruthy();
    await settled();
    undo();
    await waitFor(() => expect(server.board.mode).toBe('look'));
    await settled();
    undo();
    await waitFor(() => expect(server.board.avoid).toEqual([]));
    expect(restores()).toHaveLength(3);
  });
});

describe('a stale field step follows the card rule: left as is, and named', () => {
  it('Direction changed since by an agent: the undo leaves it and the toast says so; nothing to redo', async () => {
    await openStudio();
    await typeInto(direction(), ['warm dusk']);
    await waitFor(() => expect(server.board.direction).toBe('warm dusk'), { timeout: 3000 });
    await settled();
    outsideWrite((current) => ({ ...current, direction: 'agent dawn' }));
    await waitFor(() => expect(direction().value).toBe('agent dawn'));

    undo();
    expect(await screen.findByText('Direction changed since, left as is')).toBeTruthy();
    expect(server.board.direction).toBe('agent dawn');
    await settled();
    redo();
    await pause(300);
    expect(restores()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Redo' })).toBeNull();
  });
});

describe('one timeline with the card steps', () => {
  it('a card move, then a Direction edit: Cmd+Z twice undoes Direction, then the move (Board view)', async () => {
    await openStudio({ view: 'board' });
    act(() => board.props!.onMove([{ placement: 'c-i1', x: 300, y: 40 }]));
    await waitFor(() => expect(server.edits).toHaveLength(1));
    await settled();
    await typeInto(direction(), ['warm dusk']);
    await waitFor(() => expect(server.board.direction).toBe('warm dusk'), { timeout: 3000 });
    await settled();

    undo();
    await waitFor(() => expect(server.board.direction).toBe(''));
    expect(screen.getByText('card #1 at 300,40')).toBeTruthy();
    await settled();
    undo();
    await waitFor(() => expect(screen.getByText('card #1 at 0,0')).toBeTruthy());
    expect(server.board.direction).toBe('');
    expect(restores()).toHaveLength(2);
  });

  it('a Direction edit, then a weight change in List: Cmd+Z undoes the weight, then Direction', async () => {
    await openStudio();
    await typeInto(direction(), ['warm dusk']);
    await waitFor(() => expect(server.board.direction).toBe('warm dusk'), { timeout: 3000 });
    await settled();
    fireEvent.change(screen.getAllByRole('slider', { name: /^Weight/ })[0], { target: { value: '0.5' } });
    await waitFor(() => expect(server.board.images[0].weight).toBe(0.5), { timeout: 3000 });
    await settled();
    const history = Object.values(useBoardUndoStore.getState().histories)[0];
    expect(history.done.map((step) => step.label)).toEqual(['Direction', 'Weight of #1']);

    undo();
    await waitFor(() => expect(server.board.images[0].weight).toBe(1));
    expect(server.board.direction).toBe('warm dusk');
    await settled();
    undo();
    await waitFor(() => expect(server.board.direction).toBe(''));
    expect(server.board.images[0].weight).toBe(1);
  });
});

describe("an image's note is one step when you leave it too", () => {
  it('typing that saved twice before the box lost focus undoes in one step', async () => {
    await openStudio();
    const note = screen.getAllByRole('textbox', { name: 'Image note' })[0];
    await typeInto(note, ['the'], { leave: false });
    await waitFor(() => expect(server.board.images[0].notes).toBe('the'), { timeout: 3000 });
    await typeInto(note, ['the orange']);
    await waitFor(() => expect(server.board.images[0].notes).toBe('the orange'), { timeout: 3000 });
    await settled();
    expect(server.edits).toHaveLength(2);

    undo();
    await waitFor(() => expect(server.board.images[0].notes).toBe(''));
    expect(restores()).toHaveLength(1);
    expect(await screen.findByText(/Undid:? Note on #1/)).toBeTruthy();
    await settled();
    undo();
    await pause(300);
    expect(restores()).toHaveLength(1);
  });
});

describe('text fields keep their own undo everywhere in the Studio', () => {
  it('board name, notes, the image notes and the brief: Cmd+Z inside is never the Studio\'s', async () => {
    await openStudio();
    const fields = [
      screen.getByDisplayValue('Global board'),
      screen.getByRole('textbox', { name: 'Notes' }),
      screen.getByRole('textbox', { name: 'Add to the avoid list' }),
      screen.getByRole('textbox', { name: 'Colors that must appear: hex' }),
      ...screen.getAllByRole('textbox', { name: 'Image note' }),
      ...screen.getAllByRole('textbox', { name: 'Private note' }),
      direction(),
    ];
    for (const field of fields) {
      act(() => { field.focus(); });
      expect(undo(field).defaultPrevented).toBe(false);
      expect(redo(field).defaultPrevented).toBe(false);
    }
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.querySelector('.moodboard-studio-view')!.appendChild(editable);
    expect(undo(editable).defaultPrevented).toBe(false);
    await pause(100);
    expect(server.edits).toEqual([]);
  });
});

describe('review fixes', () => {
  it('a later save of the same open note that changes nothing keeps the note\'s step and its undo', async () => {
    await openStudio();
    await typeInto(direction(), ['warm dusk']);
    await waitFor(() => expect(server.board.direction).toBe('warm dusk'), { timeout: 3000 });
    await settled();
    const note = screen.getAllByRole('textbox', { name: 'Image note' })[0];
    await typeInto(note, ['hello'], { leave: false });
    await waitFor(() => expect(server.board.images[0].notes).toBe('hello'), { timeout: 3000 });
    await settled();
    // Typed on and back again before leaving: the second batch changes nothing.
    await typeInto(note, ['hello!', 'hello']);
    await settled();
    expect(server.edits).toHaveLength(2);
    const history = Object.values(useBoardUndoStore.getState().histories)[0];
    expect(history.done.map((step) => step.label)).toEqual(['Direction', 'Note on #1']);

    undo();
    await waitFor(() => expect(server.board.images[0].notes).toBe(''));
    expect(server.board.direction).toBe('warm dusk');
    expect(await screen.findByText(/Undid:? Note on #1/)).toBeTruthy();
  });

  it('a cleared name (nothing can save) is undone on the page, and Cmd+Z then reaches the step under it', async () => {
    await openStudio();
    const slider = strength();
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.4' } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(server.board.strength).toBe(0.4), { timeout: 3000 });
    await settled();
    const name = screen.getByDisplayValue('Global board') as HTMLInputElement;
    await typeInto(name, ['']);
    await pause(700);
    expect(server.puts).toHaveLength(1);

    undo();
    await waitFor(() => expect(name.value).toBe('Global board'));
    expect((await screen.findByRole('status', { name: 'Board undo' })).textContent).toMatch(/Undid:? Name/);
    expect(server.edits).toEqual([]);
    await settled();
    undo();
    await waitFor(() => expect(server.board.strength).toBe(0.7));
    expect(server.board.name).toBe('Global board');
    expect(restores()).toHaveLength(1);
  });

  it('board notes typed while the name is blank, undone on the page, keep the analysis the server holds', async () => {
    await openStudio();
    const name = screen.getByDisplayValue('Global board') as HTMLInputElement;
    await typeInto(name, ['']);
    await typeInto(screen.getByRole('textbox', { name: 'Notes' }), ['moody']);
    undo();
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe(''));
    undo();
    await waitFor(() => expect(name.value).toBe('Global board'));
    await pause(700);
    await settled();
    expect(server.puts.filter((body) => 'analysis' in body)).toEqual([]);
    expect(server.board.analysis).not.toBeNull();
  });

  it('a field edited on a board with no images (nothing can save) is undone on the page', async () => {
    server.board = { ...server.board, images: [] };
    await openStudio();
    await typeInto(direction(), ['warm dusk']);
    await pause(700);
    expect(server.puts).toEqual([]);
    undo();
    await waitFor(() => expect(direction().value).toBe(''));
    expect(await screen.findByText(/Undid:? Direction/)).toBeTruthy();
    expect(server.edits).toEqual([]);
  });

  it('a field changed and put back before leaving keeps what Shift+Cmd+Z can redo', async () => {
    await openStudio();
    const slider = strength();
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.4' } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(server.board.strength).toBe(0.4), { timeout: 3000 });
    await settled();
    undo();
    await waitFor(() => expect(server.board.strength).toBe(0.7));
    await settled();

    await typeInto(direction(), ['x', '']);
    await pause(700);
    expect(server.puts).toHaveLength(1);
    redo();
    await waitFor(() => expect(server.board.strength).toBe(0.4));
    expect(restores()).toHaveLength(2);
  });
});
