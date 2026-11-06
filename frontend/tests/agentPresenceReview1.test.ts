import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPresenceEvent, ExecutionEvent } from '../src/lib/wsClient';

/**
 * PR #233 review 1, B2: the backend drops a board's cursors when the board is
 * deleted (and moves those on a removed image to the board), and tells the
 * open tabs; a tab holds a cursor until told, so without that the old cursor
 * stayed drawn for the 120 s prune beside a new session that took its number.
 */
const socket = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: {
    subscribe: (handler: (event: unknown) => void) => { socket.handlers.push(handler); return () => {}; },
    subscribeFirst: () => () => {},
    connect: () => {},
    send: () => {},
  },
}));
const emit = (event: ExecutionEvent | Record<string, unknown>) => { for (const handler of socket.handlers) handler(event); };

const CLAUDE = { id: 'claude', name: 'Claude', color: '#E8825A', verified: true };
const BOARD = { surface: 'moodboard', itemId: 'b1' };
const IMAGE = { surface: 'moodboard', itemId: 'b1/i3' };
const presence = (key: string, ordinal: number, overrides: Record<string, unknown> = {}): AgentPresenceEvent => ({
  type: 'agentPresence', agent: CLAUDE, action: 'click', say: '', at: 1, target: BOARD,
  anchorNames: { board: 'Desert light' }, session: { key: key.repeat(12).slice(0, 12), ordinal }, ...overrides,
} as AgentPresenceEvent);

beforeEach(() => {
  vi.resetModules();
  socket.handlers = [];
});
async function load() {
  await import('../src/store/agentPresenceFeed');
  const { useAgentPresenceStore } = await import('../src/store/agentPresenceStore');
  return useAgentPresenceStore;
}

describe('agentPresenceLeave', () => {
  it('drops the named session cursors at once and keeps the rest', async () => {
    const store = await load();
    emit(presence('a', 1));
    emit(presence('b', 2, { target: IMAGE }));
    emit(presence('c', 3, { target: { surface: 'moodboard', itemId: 'b2' } }));
    expect(Object.keys(store.getState().agents)).toHaveLength(3);
    emit({ type: 'agentPresenceLeave', cursors: [
      { agentId: 'claude', key: 'aaaaaaaaaaaa' }, { agentId: 'claude', key: 'bbbbbbbbbbbb' }, { agentId: 'nobody', key: 'zzz' },
    ] });
    expect(Object.keys(store.getState().agents)).toEqual(['claude#cccccccccccc']);
  });

  it('an agent\'s plain cursor (no session key) goes by its id, and a leave that matches nothing changes nothing', async () => {
    const store = await load();
    emit({ ...presence('a', 1), session: undefined });
    const before = store.getState().agents;
    store.getState().leave([{ agentId: 'other', key: null }]);
    expect(store.getState().agents).toBe(before);
    emit({ type: 'agentPresenceLeave', cursors: [{ agentId: 'claude', key: null }] });
    expect(store.getState().agents).toEqual({});
  });

  it('a new session that takes the freed number draws alone', async () => {
    const store = await load();
    emit(presence('a', 2));
    emit({ type: 'agentPresenceLeave', cursors: [{ agentId: 'claude', key: 'aaaaaaaaaaaa' }] });
    emit(presence('d', 2));
    const agents = Object.values(store.getState().agents);
    expect(agents.map((cursor) => cursor.session?.ordinal)).toEqual([2]);
  });
});

describe('agentPresenceRetarget', () => {
  it('moves the named cursor to the board and its names with it, without a new event', async () => {
    const store = await load();
    emit(presence('a', 1, { target: IMAGE, anchorNames: { board: 'Desert light', image: 3 } }));
    const seq = store.getState().agents['claude#aaaaaaaaaaaa'].seq;
    emit({ type: 'agentPresenceRetarget', cursors: [
      { agentId: 'claude', key: 'aaaaaaaaaaaa', target: BOARD, anchorNames: { board: 'Desert light' } },
      { agentId: 'claude', key: 'ffffffffffff', target: BOARD },
    ] });
    const cursor = store.getState().agents['claude#aaaaaaaaaaaa'];
    expect(cursor.target).toEqual(BOARD);
    expect(cursor.anchorNames).toEqual({ board: 'Desert light' });
    expect(cursor.seq).toBe(seq);
    expect(Object.keys(store.getState().agents)).toHaveLength(1);
  });

  it('refuses a target that is not an anchor', async () => {
    const store = await load();
    emit(presence('a', 1, { target: IMAGE }));
    store.getState().retarget([{ agentId: 'claude', key: 'aaaaaaaaaaaa', target: { surface: 'moodboard', itemId: 'a/b/c' } }]);
    expect(store.getState().agents['claude#aaaaaaaaaaaa'].target).toEqual(IMAGE);
  });
});
