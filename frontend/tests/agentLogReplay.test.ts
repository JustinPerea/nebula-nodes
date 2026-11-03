import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

// GM - Design, PR #211 r21 (LOW-1 + Q2): a cursor's say always reaches the
// Agent log exactly once, whether this tab saw it live, saw it live and then
// its replay (a reconnect), or only its replay (a reload, or a say from a
// cursor folded into a count cursor, which the canvas never draws). The log
// lists every action itself; the cursor layer never writes to it.

const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: {
    connect: vi.fn(),
    subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; },
  },
}));

type Store = typeof import('../src/store/agentLogStore');
let log: Store;

/** A fresh page: the log store and its listed set load again, empty. */
async function loadPage() {
  ws.handlers.length = 0;
  vi.resetModules();
  log = await import('../src/store/agentLogStore');
}

const emit = (event: unknown) => { for (const handler of ws.handlers) handler(event); };

const AT = Date.UTC(2026, 10, 2, 9, 0, 0);
const said = (key: string, say: string, at = AT): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'pair', name: 'Pair', color: '#3FC1A5', verified: true },
  target: { nodeId: 'n1' },
  action: 'click',
  say,
  at,
  session: { key: key.repeat(12), ordinal: 1 },
} as AgentPresenceEvent);
const replay = (...cursors: (AgentPresenceEvent & { secondsAgo?: number })[]) =>
  ({ type: 'agentPresenceReplay', cursors: cursors.map((c) => ({ ...c, replay: true, since: AT })) });

const lines = () => log.useAgentLogStore.getState().entries.map((e) => `${e.agent?.name}: ${e.message}`);

beforeEach(async () => { await loadPage(); });

describe('a cursor\'s say reaches the Agent log exactly once (r21)', () => {
  it('seen live, then replayed on a reconnect (twice): one line', () => {
    emit(said('d', 'Checking the prompt'));
    emit(replay({ ...said('d', 'Checking the prompt'), secondsAgo: 1 }));
    emit(replay({ ...said('d', 'Checking the prompt'), secondsAgo: 1.5 }));
    expect(lines()).toEqual(['Pair: Checking the prompt']);
  });

  it('after a reload, a folded cursor\'s current say comes back once from the replay', async () => {
    emit(said('a', 'Laying out'));
    emit(said('d', 'Checking the prompt', AT + 10));
    expect(lines()).toHaveLength(2);
    await loadPage();
    expect(lines()).toEqual([]);
    // Oldest first, as the backend replays; d is the 4th arrival in its
    // column, folded into the count cursor, so the canvas never draws its say.
    const cursors = [{ ...said('a', 'Laying out'), secondsAgo: 2.5 }, { ...said('d', 'Checking the prompt', AT + 10), secondsAgo: 0.5 }];
    emit(replay(...cursors));
    emit(replay(...cursors));
    expect(lines()).toEqual(['Pair: Laying out', 'Pair: Checking the prompt']);
    // A live event repeating the same action (same session, time and words) is not listed again.
    emit(said('d', 'Checking the prompt', AT + 10));
    expect(lines()).toHaveLength(2);
    // A new say from the same cursor is a new line.
    emit(said('d', 'Checking the prompt', AT + 20));
    expect(lines()).toHaveLength(3);
  });

  it('a say no longer current (3 s or older) is not replayed into the log; one without an age is not either', () => {
    emit(replay({ ...said('a', 'Old news'), secondsAgo: 3 }, { ...said('b', 'Older'), secondsAgo: 40 }, said('c', 'No age')));
    expect(lines()).toEqual([]);
    emit(replay({ ...said('a', 'Just now'), secondsAgo: 2.9 }));
    expect(lines()).toEqual(['Pair: Just now']);
  });

  it('two sessions saying the same words at the same time are two lines', () => {
    emit(replay({ ...said('a', 'Same words'), secondsAgo: 1 }, { ...said('b', 'Same words'), secondsAgo: 1 }));
    expect(lines()).toHaveLength(2);
  });
});
