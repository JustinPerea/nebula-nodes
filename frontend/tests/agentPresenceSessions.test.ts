/**
 * One cursor per agent session (GM - Design's cursor spec, §4): the presence
 * store keys cursors by the opaque session key the backend gives the
 * person's tabs, caps one agent at 8, and reads any action it doesn't know
 * as a move. With no session nothing changes: the agent's one cursor, keyed
 * by its id, as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The same mock most canvas tests use (only `wsClient`): the store must
// still load and normalise actions under it.
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { subscribe: () => () => {}, subscribeFirst: () => () => {}, connect: () => {}, send: () => {} },
}));

const {
  AGENT_CURSOR_SESSIONS_PER_AGENT,
  cleanSession,
  cursorAction,
  useAgentPresenceStore,
} = await import('../src/store/agentPresenceStore');
const { AGENT_CURSOR_ACTIONS } = await import('../src/lib/agentPresenceActions');

const CLAUDE = { id: 'claude', name: 'Claude', color: '#E8825A', verified: true };
const CODEX = { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true };

function key(n: number): string {
  return n.toString(16).padStart(12, '0');
}

function event(extra: Record<string, unknown> = {}) {
  return {
    type: 'agentPresence' as const, agent: CLAUDE, action: 'move', say: '', at: 1,
    projectId: 'p1', target: { nodeId: 'n1' }, ...extra,
  };
}

const apply = (e: ReturnType<typeof event>, now: number) =>
  useAgentPresenceStore.getState().apply(e as never, now);

beforeEach(() => useAgentPresenceStore.getState().clear());

describe('actions', () => {
  it('knows the ten, in the backend order, and reads anything else as a move', () => {
    expect(AGENT_CURSOR_ACTIONS).toEqual(
      ['move', 'look', 'think', 'type', 'click', 'drag', 'run', 'propose', 'wait', 'error']);
    for (const action of AGENT_CURSOR_ACTIONS) expect(cursorAction(action)).toBe(action);
    for (const odd of ['hover', '', 'MOVE', 5, null, undefined, {}]) expect(cursorAction(odd)).toBe('move');
  });

  it('stores the normalised action', () => {
    apply(event({ action: 'propose' }), 1_000);
    expect(useAgentPresenceStore.getState().agents.claude.action).toBe('propose');
    apply(event({ action: 'teleport' }), 2_000);
    expect(useAgentPresenceStore.getState().agents.claude.action).toBe('move');
  });
});

describe('sessions', () => {
  it('without a session, the cursor is keyed by the agent as before', () => {
    apply(event(), 1_000);
    const { agents } = useAgentPresenceStore.getState();
    expect(Object.keys(agents)).toEqual(['claude']);
    expect(agents.claude.key).toBe('claude');
    expect(agents.claude.session).toBeNull();
  });

  it('gives each session of one agent its own cursor, keyed by the opaque key', () => {
    apply(event({ session: { key: key(1), ordinal: 1 } }), 1_000);
    apply(event({ session: { key: key(2), ordinal: 2 }, target: { nodeId: 'n2' } }), 2_000);
    apply(event({ session: { key: key(1), ordinal: 1 }, target: { nodeId: 'n3' } }), 3_000);
    const { agents } = useAgentPresenceStore.getState();
    expect(Object.keys(agents).sort()).toEqual([`claude#${key(1)}`, `claude#${key(2)}`]);
    const first = agents[`claude#${key(1)}`];
    expect(first.id).toBe('claude');
    expect(first.session).toEqual({ key: key(1), ordinal: 1 });
    expect(first.target).toEqual({ nodeId: 'n3' });
    expect(first.seq).toBe(2);
    expect(agents[`claude#${key(2)}`].session?.ordinal).toBe(2);
  });

  it('a malformed session lands on the agent’s own cursor', () => {
    for (const bad of [
      { key: 'ABCDEF012345', ordinal: 1 }, { key: key(1).slice(1), ordinal: 1 }, { key: `${key(1)}0`, ordinal: 1 },
      { key: key(1), ordinal: 0 }, { key: key(1), ordinal: 1.5 }, { key: key(1), ordinal: 100_001 },
      { key: key(1), ordinal: '2' }, { key: 5, ordinal: 1 }, 'chat:abc', null,
    ]) {
      expect(cleanSession(bad)).toBeNull();
      useAgentPresenceStore.getState().clear();
      apply(event({ session: bad }), 1_000);
      expect(Object.keys(useAgentPresenceStore.getState().agents)).toEqual(['claude']);
    }
    expect(cleanSession({ key: key(1), ordinal: 100_000 })).toEqual({ key: key(1), ordinal: 100_000 });
  });

  it('caps one agent at 8 cursors, dropping the one heard from longest ago', () => {
    expect(AGENT_CURSOR_SESSIONS_PER_AGENT).toBe(8);
    apply({ ...event(), agent: CODEX } as never, 500);
    // Numbers 2-10, so none is the plain cursor's 1 (a shared number is a
    // cursor that left: the next test).
    for (let n = 1; n <= 8; n += 1) apply(event({ session: { key: key(n), ordinal: n + 1 } }), 1_000 + n);
    // Heard again: no longer the oldest.
    apply(event({ session: { key: key(1), ordinal: 2 } }), 2_000);
    apply(event({ session: { key: key(9), ordinal: 10 } }), 3_000);
    const { agents } = useAgentPresenceStore.getState();
    const mine = Object.values(agents).filter((cursor) => cursor.id === 'claude');
    expect(mine).toHaveLength(8);
    expect(agents[`claude#${key(2)}`]).toBeUndefined();
    expect(agents[`claude#${key(1)}`]).toBeDefined();
    expect(agents[`claude#${key(9)}`]).toBeDefined();
    // Another agent's cursor is never one of the eight.
    expect(agents.codex).toBeDefined();
    // The no-session cursor counts toward the cap like any other.
    apply(event(), 4_000);
    expect(Object.values(useAgentPresenceStore.getState().agents).filter((c) => c.id === 'claude')).toHaveLength(8);
    expect(useAgentPresenceStore.getState().agents[`claude#${key(3)}`]).toBeUndefined();
  });

  it('shows the number the backend gave and never numbers on its own', () => {
    apply(event({ session: { key: key(1), ordinal: 1 } }), 1_000);
    apply(event({ session: { key: key(2), ordinal: 2 } }), 1_001);
    apply(event({ session: { key: key(3), ordinal: 3 } }), 1_002);
    // Session 2 left the backend, which gave its number to a new session.
    // The old cursor goes here too, so two cursors never read "Claude · 2".
    apply(event({ session: { key: key(4), ordinal: 2 } }), 1_003);
    let { agents } = useAgentPresenceStore.getState();
    expect(Object.keys(agents).sort()).toEqual([`claude#${key(1)}`, `claude#${key(3)}`, `claude#${key(4)}`]);
    expect(Object.values(agents).map((c) => c.session?.ordinal).sort()).toEqual([1, 2, 3]);
    // The live ones keep theirs.
    expect(agents[`claude#${key(1)}`].session?.ordinal).toBe(1);
    expect(agents[`claude#${key(3)}`].session?.ordinal).toBe(3);
    // The plain cursor counts as 1, so a session given 1 takes its place.
    useAgentPresenceStore.getState().clear();
    apply(event(), 2_000);
    apply(event({ session: { key: key(5), ordinal: 1 } }), 2_001);
    ({ agents } = useAgentPresenceStore.getState());
    expect(Object.keys(agents)).toEqual([`claude#${key(5)}`]);
    // And the other way: the plain cursor back means session 1 left.
    apply(event(), 2_001.5);
    expect(Object.keys(useAgentPresenceStore.getState().agents)).toEqual(['claude']);
    apply(event({ session: { key: key(5), ordinal: 1 } }), 2_001.7);
    // Another agent's numbers are its own.
    apply({ ...event(), agent: CODEX, session: { key: key(6), ordinal: 1 } } as never, 2_002);
    expect(Object.keys(useAgentPresenceStore.getState().agents).sort()).toEqual(['codex#' + key(6), `claude#${key(5)}`].sort());
  });

  it('prune and forgetGraph work per cursor key', () => {
    apply(event({ session: { key: key(1), ordinal: 1 } }), 1_000);
    apply(event({ session: { key: key(2), ordinal: 2 }, target: { x: 4, y: 5 } }), 100_000);
    useAgentPresenceStore.getState().prune(125_000);
    expect(Object.keys(useAgentPresenceStore.getState().agents)).toEqual([`claude#${key(2)}`]);
    apply(event({ session: { key: key(1), ordinal: 1 } }), 125_000);
    useAgentPresenceStore.getState().forgetGraph();
    const { agents } = useAgentPresenceStore.getState();
    expect(Object.keys(agents)).toEqual([`claude#${key(2)}`]);
    expect(agents[`claude#${key(2)}`].key).toBe(`claude#${key(2)}`);
  });
});
