import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Agents panel's store (Q125 item 2): status lines live from the socket,
 * the roster read on mount and after a reconnect, and an event that lands
 * during a read is neither lost nor undone by it.
 */

const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
const rosterApi = vi.hoisted(() => ({ fetchAgentRoster: vi.fn() }));

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; } },
}));
vi.mock('../src/lib/agentRoster', () => rosterApi);

const { refreshAgentRoster, useAgentRosterStore } = await import('../src/components/agent-notes/agentRosterStore');

const CODEX = { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true };
const GEMINI = { id: 'ext:gemini', name: 'Gemini', color: '#F2C14E', verified: false };

function emit(event: unknown) {
  for (const handler of ws.handlers) handler(event);
}

function status(agent: typeof CODEX, text: string | null, rev: number) {
  return { type: 'agentStatus', agent, change: text ? 'set' : 'cleared', rev,
    status: text ? { text, nodeId: null, projectId: 'p1', at: 0, secondsAgo: 0 } : null };
}

function entry(agent: typeof CODEX, text: string) {
  return { agent, group: 'working', status: { text, nodeId: 'n1', secondsAgo: 30 },
    lastAction: { verb: 'Ran', nodeId: 'n1', label: 'Upscale', secondsAgo: 5 },
    cursor: { nodeId: 'n1', action: 'click', secondsAgo: 5 },
    needsYou: { questions: 0, proposals: 0 }, waitingSeconds: null, activeSecondsAgo: 5 };
}

beforeEach(() => {
  useAgentRosterStore.getState().reset();
  rosterApi.fetchAgentRoster.mockReset();
});

describe('the roster store', () => {
  it('keeps a status set or cleared during the read when it is newer than the read', async () => {
    let answer: (value: unknown) => void = () => {};
    rosterApi.fetchAgentRoster.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const reading = refreshAgentRoster();
    emit(status(GEMINI, 'Sorting the moodboard', 8));
    emit(status(CODEX, null, 9));
    // The read was taken at rev 7: Codex still had its line, Gemini had none.
    answer({ projectId: 'p1', rev: 7, agents: [entry(CODEX, 'Rendering')] });
    await reading;
    const { statuses, cursors } = useAgentRosterStore.getState();
    expect(Object.keys(statuses)).toEqual(['ext:gemini']);
    expect(statuses['ext:gemini'].text).toBe('Sorting the moodboard');
    expect(cursors.codex.did).toMatchObject({ verb: 'Ran', nodeId: 'n1', label: 'Upscale' });
  });

  it('lets the read win over an event it already includes', async () => {
    let answer: (value: unknown) => void = () => {};
    rosterApi.fetchAgentRoster.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const reading = refreshAgentRoster();
    emit(status(CODEX, 'Old line', 3));
    answer({ projectId: 'p1', rev: 4, agents: [entry(CODEX, 'Newer line')] });
    await reading;
    expect(useAgentRosterStore.getState().statuses.codex.text).toBe('Newer line');
  });

  it('reads again after the socket reconnects, and a failed read keeps what it had', async () => {
    emit(status(CODEX, 'Rendering', 1));
    rosterApi.fetchAgentRoster.mockRejectedValue(new Error('offline'));
    await refreshAgentRoster();
    expect(useAgentRosterStore.getState().statuses.codex.text).toBe('Rendering');

    rosterApi.fetchAgentRoster.mockResolvedValue({ projectId: 'p1', rev: 0, agents: [] });
    emit({ type: 'socketReconnected' });
    await vi.waitFor(() => expect(useAgentRosterStore.getState().statuses).toEqual({}));
  });

  it('only a plain hex colour reaches the page', () => {
    emit(status({ ...CODEX, color: 'red;background:url(x)' }, 'Rendering', 1));
    expect(useAgentRosterStore.getState().statuses.codex.agent.color).toBe('#E8825A');
  });
});

describe("the last action's own time (GM's review)", () => {
  it('a read places the action at its own secondsAgo, not the cursor\'s', () => {
    const at = 1_800_000_000_000;
    useAgentRosterStore.getState().applyRoster({ projectId: 'p1', rev: 1, agents: [{
      ...entry(CODEX, 'x'), status: null,
      lastAction: { verb: 'Renamed', nodeId: 'n1', label: 'Hero', secondsAgo: 90 },
      cursor: { nodeId: null, action: 'click', secondsAgo: 2 } }] } as never, at);
    const cursor = useAgentRosterStore.getState().cursors.codex;
    expect(cursor.at).toBe(at - 2_000);
    expect(cursor.did?.at).toBe(at - 90_000);
  });
});
