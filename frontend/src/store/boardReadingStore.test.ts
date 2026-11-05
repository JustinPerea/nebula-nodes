import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardReadingRun, BoardReadingState } from '../lib/boardReading';
import { RequestFailedError } from '../lib/errorCopy';

// The Studio's mirror of a board's reading (Read the board): loads, the
// socket's word on a run, the "Replaced the reading" signal and refusals.

const api = vi.hoisted(() => ({
  fetchBoardReading: vi.fn(), startBoardReading: vi.fn(), stopBoardReading: vi.fn(), undoBoardReading: vi.fn(),
}));
vi.mock('../lib/boardReading', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));

import { useBoardReadingStore } from './boardReadingStore';

const run = (extra: Partial<BoardReadingRun> = {}): BoardReadingRun => ({
  id: 'run1', boardId: 'mb1', status: 'running', route: 'antigravity', count: 3, by: { kind: 'person' },
  startedAt: 1000, elapsedMs: 0, cause: null, readingId: null, ...extra });

const state = (readingId: string | null, extra: Partial<BoardReadingState> = {}): BoardReadingState => ({
  reading: readingId ? { id: readingId } as BoardReadingState['reading'] : null, markdown: null, tiles: [], stale: null,
  hasPrevious: false, run: null,
  route: { antigravity: { installed: true, signedIn: true }, hasKey: false, route: 'antigravity', count: 3,
    model: { id: 'gemini-4-argon', name: 'Gemini 4 Argon' }, estimate: { low: null, high: null, unpriced: true, unconfirmed: false } },
  ...extra,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  useBoardReadingStore.setState({ boards: {}, replaced: null, tab: 'settings' });
});

describe('boardReadingStore', () => {
  it('signals a read that landed over an earlier one, once', async () => {
    api.fetchBoardReading.mockResolvedValueOnce(state('rd_old'));
    await useBoardReadingStore.getState().load('mb1');
    expect(useBoardReadingStore.getState().replaced).toBeNull();
    api.fetchBoardReading.mockResolvedValue(state('rd_new', { hasPrevious: true,
      run: run({ status: 'done', readingId: 'rd_new' }) }));
    await useBoardReadingStore.getState().load('mb1');
    expect(useBoardReadingStore.getState().replaced).toMatchObject({ boardId: 'mb1', readingId: 'rd_new' });
    useBoardReadingStore.getState().clearReplaced();
    await useBoardReadingStore.getState().load('mb1');
    expect(useBoardReadingStore.getState().replaced).toBeNull();
  });

  it('does not signal a first reading, or an Undo back to the earlier one', async () => {
    api.fetchBoardReading.mockResolvedValueOnce(state(null));
    await useBoardReadingStore.getState().load('mb1');
    api.fetchBoardReading.mockResolvedValueOnce(state('rd_1', { run: run({ status: 'done', readingId: 'rd_1' }) }));
    await useBoardReadingStore.getState().load('mb1');
    expect(useBoardReadingStore.getState().replaced).toBeNull();
    // Undo: the earlier reading is back; the run still names the replaced one.
    api.fetchBoardReading.mockResolvedValueOnce(state('rd_0', { hasPrevious: true, run: run({ status: 'done', readingId: 'rd_1' }) }));
    await useBoardReadingStore.getState().load('mb1');
    expect(useBoardReadingStore.getState().replaced).toBeNull();
  });

  it('drops an older load that answers after a newer one', async () => {
    let first!: (value: BoardReadingState) => void;
    api.fetchBoardReading.mockReturnValueOnce(new Promise((resolve) => { first = resolve; }));
    api.fetchBoardReading.mockResolvedValueOnce(state('rd_new'));
    const older = useBoardReadingStore.getState().load('mb1');
    await useBoardReadingStore.getState().load('mb1');
    first(state('rd_old'));
    await older;
    expect(useBoardReadingStore.getState().boards.mb1.state?.reading?.id).toBe('rd_new');
  });

  it('takes a run from the socket, and reads the board again when it ends', async () => {
    api.fetchBoardReading.mockResolvedValue(state(null));
    await useBoardReadingStore.getState().load('mb1');
    api.fetchBoardReading.mockClear();
    useBoardReadingStore.getState().takeRun('mb1', run());
    expect(useBoardReadingStore.getState().boards.mb1.state?.run?.status).toBe('running');
    expect(api.fetchBoardReading).not.toHaveBeenCalled();
    useBoardReadingStore.getState().takeRun('mb1', run({ status: 'failed', cause: 'timeout' }));
    expect(api.fetchBoardReading).toHaveBeenCalledWith('mb1');
  });

  it('keeps a newer run when an older one’s word comes late', async () => {
    api.fetchBoardReading.mockResolvedValue(state(null, { run: run({ id: 'run2', startedAt: 2000 }) }));
    await useBoardReadingStore.getState().load('mb1');
    useBoardReadingStore.getState().takeRun('mb1', run({ id: 'run1', startedAt: 1000, status: 'running' }));
    expect(useBoardReadingStore.getState().boards.mb1.state?.run?.id).toBe('run2');
  });

  it('starts on the route asked, and shows a refusal under the failure heading', async () => {
    api.fetchBoardReading.mockResolvedValue(state(null));
    api.startBoardReading.mockResolvedValueOnce({ status: 'running', run: run() });
    await useBoardReadingStore.getState().load('mb1');
    await useBoardReadingStore.getState().start('mb1', 'gemini_key');
    expect(api.startBoardReading).toHaveBeenCalledWith('mb1', 'gemini_key');
    expect(useBoardReadingStore.getState().boards.mb1.state?.run?.status).toBe('running');
    api.startBoardReading.mockRejectedValueOnce(new RequestFailedError('', 409, { reason: 'A read is already running on this board.' }));
    await useBoardReadingStore.getState().start('mb1');
    expect(useBoardReadingStore.getState().boards.mb1.actionError).toEqual({
      heading: 'Nebula couldn’t read the board', reason: 'A read is already running on this board.' });
  });

  it('undoes the reading it names', async () => {
    api.fetchBoardReading.mockResolvedValue(state('rd_0'));
    api.undoBoardReading.mockResolvedValue(undefined);
    await useBoardReadingStore.getState().undo('mb1', 'rd_1');
    expect(api.undoBoardReading).toHaveBeenCalledWith('mb1', 'rd_1');
    expect(api.fetchBoardReading).toHaveBeenCalledWith('mb1');
  });
});
