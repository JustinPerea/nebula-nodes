import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent's mark on a node (Q125 item 3). GM - Design, 2026-10-25,
 * verbatim: "Content: the agent's dot or ring, then its name, then the
 * status. For runs: “Running FLUX.2 [pro] · 0:41” (provider's model name;
 * m:ss elapsed) ... Two or more agents on one node: one full pill for the
 * most recent agent, then a “+1” chip ... Low zoom: below 60%, collapse to
 * the dot alone." The mark shows while the agent has a status on the node
 * or a run it started is going there, and goes when that ends.
 */

const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
const rosterApi = vi.hoisted(() => ({ fetchAgentRoster: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; } },
}));
vi.mock('../src/lib/agentRoster', () => rosterApi);

const { useAgentRosterStore } = await import('../src/components/agent-notes/agentRosterStore');
const { formatElapsed, isLowZoom, LOW_ZOOM, markLabel, marksByNode, moreLabel, othersLabel, RUN_MARK_DELAY_MS } = await import('../src/components/canvas/agentNodeMarks');

const CODEX = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: false };
const CLAUDE = { id: 'claude', name: 'Claude Code', color: '#D97757', verified: true };

function emit(event: unknown) {
  for (const handler of ws.handlers) handler(event);
}

function run(agent: typeof CODEX, change: 'started' | 'ended', nodeId = 'n4', extra: Record<string, unknown> = {}) {
  return { type: 'agentRun', agent, runId: 'r1', nodeId, model: 'FLUX.2 [pro]', projectId: 'p1', change,
    secondsAgo: 0, ...extra };
}

beforeEach(() => {
  useAgentRosterStore.getState().reset();
});

describe('elapsed time and zoom', () => {
  it('is m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(41_000)).toBe('0:41');
    expect(formatElapsed(61_900)).toBe('1:01');
    expect(formatElapsed(12 * 60_000 + 5_000)).toBe('12:05');
    expect(formatElapsed(-5)).toBe('0:00');
  });

  it('collapses below 60%', () => {
    expect(LOW_ZOOM).toBe(0.6);
    expect(isLowZoom(0.59)).toBe(true);
    expect(isLowZoom(0.6)).toBe(false);
    // GM, 2026-10-25: only BELOW 60%; at exactly 60% (as the toolbar shows
    // it, rounded) the full pill shows, whatever float React Flow holds.
    expect(isLowZoom(0.6 - 1e-9)).toBe(false);
    expect(isLowZoom(0.5999)).toBe(false);
    expect(isLowZoom(0.594)).toBe(true);
    expect(moreLabel(1)).toBe('+1');
    expect(moreLabel(2)).toBe('+2');
  });
});

describe('the run marks in the store', () => {
  it('follow agentRun events: started adds, ended removes', () => {
    emit(run(CODEX, 'started', 'n4', { secondsAgo: 3 }));
    const runs = Object.values(useAgentRosterStore.getState().runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agent: CODEX, nodeId: 'n4', model: 'FLUX.2 [pro]', projectId: 'p1', runId: 'r1' });
    emit(run(CODEX, 'ended'));
    expect(useAgentRosterStore.getState().runs).toEqual({});
  });

  it('come from the roster read for a tab that loads mid-run', () => {
    useAgentRosterStore.getState().applyRoster({
      projectId: 'p1', rev: 1,
      agents: [{ agent: CODEX, group: 'working', status: null, lastAction: null, cursor: null,
        needsYou: { questions: 0, proposals: 0 }, waitingSeconds: null, activeSecondsAgo: 0,
        pending: ['n9'], running: [{ runId: 'r1', nodeId: 'n4', model: 'FLUX.2 [pro]', secondsAgo: 41 }] }],
    }, 100_000);
    const [mark] = Object.values(useAgentRosterStore.getState().runs);
    expect(mark).toMatchObject({ nodeId: 'n4', projectId: 'p1', at: 100_000 - 41_000 });
  });
});

describe('marksByNode', () => {
  const now = 200_000;

  it('shows a run with its model and elapsed time, and a status line on a node', () => {
    const marks = marksByNode({
      projectId: 'p1', now,
      runs: [{ agent: CODEX, runId: 'r1', nodeId: 'n4', model: 'FLUX.2 [pro]', projectId: 'p1', at: now - 41_000 }],
      statuses: [{ agent: CLAUDE, text: 'Writing the prompts', nodeId: 'n2', projectId: 'p1', at: now - 5_000 }],
    });
    expect(marks.get('n4')).toEqual([expect.objectContaining({ agent: CODEX, text: 'Running FLUX.2 [pro] · 0:41' })]);
    expect(marks.get('n2')).toEqual([expect.objectContaining({ agent: CLAUDE, text: 'Writing the prompts' })]);
  });

  it('lists the most recent agent first, and one mark per agent (its run over its status)', () => {
    const marks = marksByNode({
      projectId: 'p1', now,
      runs: [{ agent: CODEX, runId: 'r1', nodeId: 'n4', model: 'FLUX.2 [pro]', projectId: 'p1', at: now - 10_000 }],
      statuses: [
        { agent: CLAUDE, text: 'Checking the crops', nodeId: 'n4', projectId: 'p1', at: now - 2_000 },
        { agent: CODEX, text: 'Rendering', nodeId: 'n4', projectId: 'p1', at: now - 1_000 },
      ],
    });
    const list = marks.get('n4')!;
    expect(list.map((mark) => mark.agent.name)).toEqual(['Claude Code', 'Codex']);
    expect(list[1].text).toBe('Running FLUX.2 [pro] · 0:10');
  });

  it("leaves out another project's marks and statuses with no node", () => {
    const marks = marksByNode({
      projectId: 'p1', now,
      runs: [{ agent: CODEX, runId: 'r1', nodeId: 'n4', model: 'X', projectId: 'p2', at: now }],
      statuses: [{ agent: CLAUDE, text: 'Thinking', nodeId: null, projectId: 'p1', at: now },
        { agent: CODEX, text: 'Elsewhere', nodeId: 'n4', projectId: 'p2', at: now }],
    });
    expect(marks.size).toBe(0);
  });
});

describe('accessible names (GM - Design, 2026-10-25, verbatim)', () => {
  const VERIFIED_CODEX = { ...CODEX, verified: true };
  const VERIFIED_CLAUDE = { ...CLAUDE, verified: true };

  it('names the pill "{agent}, {status}", with "unverified" for an agent that named itself', () => {
    expect(markLabel({ agent: VERIFIED_CODEX, text: 'Writing the hero prompt' })).toBe('Codex, Writing the hero prompt');
    expect(markLabel({ agent: CODEX, text: 'Writing the hero prompt' })).toBe('Codex, unverified, Writing the hero prompt');
  });

  it('names the +N chip with the count, then each agent as its own sentence', () => {
    expect(othersLabel([
      { agent: VERIFIED_CODEX, text: 'Writing the hero prompt' },
      { agent: VERIFIED_CLAUDE, text: 'Checking the crop' },
    ])).toBe('2 more agents. Codex, Writing the hero prompt. Claude Code, Checking the crop.');
    expect(othersLabel([{ agent: VERIFIED_CODEX, text: 'Writing the hero prompt' }]))
      .toBe('1 more agent. Codex, Writing the hero prompt.');
    // A status that already ends a sentence isn't given a second full stop.
    expect(othersLabel([{ agent: CODEX, text: 'Checking the crop.' }]))
      .toBe('1 more agent. Codex, unverified, Checking the crop.');
  });
});

describe('the run pill (GM - Design, 2026-10-25)', () => {
  const now = 500_000;
  const runAt = (at: number, model = 'FLUX.2 [pro]') => marksByNode({
    projectId: 'p1', now, statuses: [],
    runs: [{ agent: CODEX, runId: 'r1', nodeId: 'n4', model, projectId: 'p1', at }],
  });

  it('shows only once the run has been going 1 s, so an instant local run never flashes a pill', () => {
    expect(RUN_MARK_DELAY_MS).toBe(1000);
    expect(runAt(now).size).toBe(0);
    expect(runAt(now - 999).size).toBe(0);
    expect(runAt(now - 1000).get('n4')?.[0].text).toBe('Running FLUX.2 [pro] · 0:01');
  });

  it("shows the agent's status line on the node meanwhile", () => {
    const marks = marksByNode({
      projectId: 'p1', now,
      runs: [{ agent: CODEX, runId: 'r1', nodeId: 'n4', model: 'X', projectId: 'p1', at: now - 200 }],
      statuses: [{ agent: CODEX, text: 'Rendering', nodeId: 'n4', projectId: 'p1', at: now - 5_000 }],
    });
    expect(marks.get('n4')?.map((mark) => mark.text)).toEqual(['Rendering']);
  });

  it('keeps a node name quoted as the backend sends it', () => {
    expect(runAt(now - 2_000, '“Text Input”').get('n4')?.[0].text).toBe('Running “Text Input” · 0:02');
  });
});
