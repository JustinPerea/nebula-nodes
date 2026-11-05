import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPresenceEvent, ExecutionEvent } from '../src/lib/wsClient';

/**
 * PR #211 round 4: the socket feed in the startup entry and the presence
 * store in the cursor chunk (review 3, N3), the subscription that hands the
 * replay to the store (LOW-2), the replay's age clamp (LOW-3, F05) and a
 * demoted tab (LOW-1, GM - Design r9 item 6).
 */
const socket = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: {
    subscribe: (handler: (event: unknown) => void) => {
      socket.handlers.push(handler);
      return () => {};
    },
    subscribeFirst: () => () => {},
    connect: () => {},
    send: () => {},
  },
}));

const emit = (event: ExecutionEvent | Record<string, unknown>) => {
  for (const handler of socket.handlers) handler(event);
};
const CLAUDE = { id: 'claude', name: 'Claude', color: '#E8825A', verified: true };
const presence = (overrides: Partial<AgentPresenceEvent> & Record<string, unknown> = {}): AgentPresenceEvent => ({
  type: 'agentPresence', agent: CLAUDE, action: 'move', say: '', at: 1, target: { x: 10, y: 20 }, ...overrides,
} as AgentPresenceEvent);
const session = (key: string, ordinal: number) => ({ session: { key: key.repeat(12).slice(0, 12), ordinal } });

beforeEach(() => {
  vi.resetModules();
  socket.handlers = [];
});

async function load() {
  const feed = await import('../src/store/agentPresenceFeed');
  const store = await import('../src/store/agentPresenceStore');
  return { feed, store: store.useAgentPresenceStore };
}

describe('the replay reaches the store through the socket subscription (LOW-2)', () => {
  it('an agentPresenceReplay on the socket replaces the tab\'s cursors with the replayed ones', async () => {
    const { store } = await load();
    emit(presence());
    expect(Object.keys(store.getState().agents)).toEqual(['claude']);
    emit({ type: 'agentPresenceReplay', cursors: [
      { ...presence({ target: { x: 1, y: 1 } }), ...session('a', 1), replay: true, secondsAgo: 2 },
      { ...presence({ target: { x: 5, y: 5 } }), ...session('b', 3), replay: true, secondsAgo: 0 },
    ] });
    const agents = store.getState().agents;
    expect(Object.keys(agents).sort()).toEqual(['claude#aaaaaaaaaaaa', 'claude#bbbbbbbbbbbb']);
    expect(Object.values(agents).every((cursor) => cursor.replayed)).toBe(true);
    expect(agents['claude#bbbbbbbbbbbb'].session?.ordinal).toBe(3);
  });

  it('a graph clear and a plain event reach it the same way', async () => {
    const { store } = await load();
    emit(presence({ target: { nodeId: 'n1' } }));
    emit({ type: 'graphSync', nodes: [], edges: [], empty: true });
    expect(store.getState().agents).toEqual({});
  });
});

describe('the replay\'s age is clamped (LOW-3, F05)', () => {
  it('a negative age reads as now, and one past the expiry as the expiry', async () => {
    const { store } = await load();
    const { AGENT_CURSOR_EXPIRE_MS } = await import('../src/store/agentPresenceStore');
    store.getState().replay([
      { ...presence(), ...session('a', 1), secondsAgo: -30 },
      { ...presence(), ...session('b', 2), secondsAgo: 1e9 },
    ] as never, 1_000_000);
    const agents = store.getState().agents;
    expect(agents['claude#aaaaaaaaaaaa'].receivedAt).toBe(1_000_000);
    expect(agents['claude#bbbbbbbbbbbb'].receivedAt).toBe(1_000_000 - AGENT_CURSOR_EXPIRE_MS);
  });
});

describe('the feed holds presence until the cursor chunk loads (N3)', () => {
  it('events heard before the store loads are applied in order, with the time they were heard', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(50_000);
    const feed = await import('../src/store/agentPresenceFeed');
    emit(presence({ ...session('a', 1), say: 'first' }));
    now.mockReturnValue(51_000);
    emit(presence({ ...session('a', 1), say: 'second' }));
    emit({ type: 'executing', nodeId: 'n1' }); // not presence: never held
    expect(feed.heldPresenceEvents()).toHaveLength(2);
    now.mockReturnValue(60_000);
    const { useAgentPresenceStore: store } = await import('../src/store/agentPresenceStore');
    const cursor = store.getState().agents['claude#aaaaaaaaaaaa'];
    expect(cursor.say).toBe('second');
    expect(cursor.seq).toBe(2);
    expect(cursor.receivedAt).toBe(51_000);
    expect(feed.heldPresenceEvents()).toHaveLength(0);
    // From now on each event goes straight in.
    emit(presence({ ...session('b', 2) }));
    expect(Object.keys(store.getState().agents)).toHaveLength(2);
    now.mockRestore();
  });

  it('a replay drops what was held before it, and the hold is bounded', async () => {
    const feed = await import('../src/store/agentPresenceFeed');
    for (let i = 0; i < feed.AGENT_PRESENCE_FEED_MAX + 10; i += 1) emit(presence({ say: String(i) }));
    expect(feed.heldPresenceEvents()).toHaveLength(feed.AGENT_PRESENCE_FEED_MAX);
    expect((feed.heldPresenceEvents()[0] as AgentPresenceEvent).say).toBe('10');
    emit({ type: 'agentPresenceReplay', cursors: [{ ...presence(), ...session('c', 2), replay: true, secondsAgo: 0 }] });
    expect(feed.heldPresenceEvents().map((event) => event.type)).toEqual(['agentPresenceReplay']);
    const { useAgentPresenceStore: store } = await import('../src/store/agentPresenceStore');
    expect(Object.keys(store.getState().agents)).toEqual(['claude#cccccccccccc']);
  });

  it('the cap never pushes the held replay out: the replay, then the latest events after it (review 4, NIT-3)', async () => {
    const feed = await import('../src/store/agentPresenceFeed');
    emit({ type: 'agentPresenceReplay', cursors: [
      { ...presence({ agent: { ...CLAUDE, id: 'quiet', name: 'Quiet' } }), ...session('c', 1), replay: true, secondsAgo: 0 },
    ] });
    for (let i = 0; i < feed.AGENT_PRESENCE_FEED_MAX + 5; i += 1) emit(presence({ ...session('a', 2), say: String(i) }));
    const held = feed.heldPresenceEvents();
    expect(held).toHaveLength(feed.AGENT_PRESENCE_FEED_MAX + 1);
    expect(held[0].type).toBe('agentPresenceReplay');
    expect((held[1] as AgentPresenceEvent).say).toBe('5');
    const { useAgentPresenceStore: store } = await import('../src/store/agentPresenceStore');
    // The quiet session's cursor is there, as on every other tab.
    expect(Object.keys(store.getState().agents).sort()).toEqual(['claude#aaaaaaaaaaaa', 'quiet#cccccccccccc']);
    expect(store.getState().agents['claude#aaaaaaaaaaaa'].say).toBe(String(feed.AGENT_PRESENCE_FEED_MAX + 4));
  });

  it('holds graph clears and replacements only, not every graph sync (review 4, NIT-2)', async () => {
    const feed = await import('../src/store/agentPresenceFeed');
    emit({ type: 'graphSync', nodes: [], edges: [] });
    emit({ type: 'graphSync', nodes: [], edges: [], graphReplaced: true });
    emit({ type: 'graphSync', nodes: [], edges: [], empty: true });
    expect(feed.heldPresenceEvents()).toHaveLength(2);
  });
});

describe('a demoted tab (GM - Design, PR #211 r9 item 6; review 3, LOW-1)', () => {
  it('its numbered cursors leave, and agent-form events then draw one unnumbered cursor per agent', async () => {
    const { store } = await load();
    emit({ type: 'agentPresenceReplay', cursors: [
      { ...presence(), ...session('a', 1), replay: true, secondsAgo: 0 },
      { ...presence(), ...session('b', 2), replay: true, secondsAgo: 0 },
      { ...presence(), ...session('c', 3), replay: true, secondsAgo: 0 },
    ] });
    expect(Object.keys(store.getState().agents)).toHaveLength(3);
    // The server refuses this tab's hello (a restart with a new token).
    emit({ type: 'socketDemoted' });
    expect(store.getState().agents).toEqual({});
    // The agents' form: no session. Each agent shows once, unnumbered, as a
    // live event (it flies in: not a replayed snap).
    emit(presence({ say: 'lane a again' }));
    emit(presence({ say: 'lane b again' }));
    const agents = Object.values(store.getState().agents);
    expect(agents.map((cursor) => [cursor.key, cursor.session, cursor.replayed])).toEqual([['claude', null, false]]);
  });

  it('keeps unnumbered cursors: they are the agents\' form already', async () => {
    const { store } = await load();
    emit(presence({ agent: { ...CLAUDE, id: 'codex', name: 'Codex' } }));
    emit(presence(session('a', 2)));
    emit({ type: 'socketDemoted' });
    expect(Object.keys(store.getState().agents)).toEqual(['codex']);
  });
});

// #211 follow-up (GM r23 item 2): the backend's new arrivals for cursors a
// node move carried reach the store, before and after it loads, without a
// new event: no seq, no say, only the place in the column.
describe('the carried cursors\' new arrivals (agentPresenceArrival)', () => {
  it('reach the store through the feed and change only the arrival', async () => {
    const feedOnly = await import('../src/store/agentPresenceFeed');
    emit(presence({ ...session('a', 1), since: 1000 }));
    emit({ type: 'agentPresenceArrival', cursors: [{ agentId: 'claude', key: 'a'.repeat(12), ordinal: 1, since: 5000 }] });
    expect(feedOnly.heldPresenceEvents().map((e) => e.type)).toEqual(['agentPresence', 'agentPresenceArrival']);
    const { store } = await load();
    const cursor = store.getState().agents[`claude#${'a'.repeat(12)}`];
    expect(cursor.arrivedAt).toBe(5000);
    expect(cursor.arrivalKnown).toBe(true);
    const seq = cursor.seq;
    emit({ type: 'agentPresenceArrival', cursors: [{ agentId: 'claude', key: 'a'.repeat(12), ordinal: 1, since: 7000 },
      { agentId: 'claude', key: 'f'.repeat(12), ordinal: 9, since: 1 }, { bad: true }] });
    const after = store.getState().agents[`claude#${'a'.repeat(12)}`];
    expect(after.arrivedAt).toBe(7000);
    expect(after.seq).toBe(seq);
    expect(Object.keys(store.getState().agents)).toHaveLength(1);
  });
});
