import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ProposalView, ProposalWait } from '../src/lib/wsClient';
import type { AgentNote } from '../src/lib/agentNotes';

/**
 * The spend record's 24-hour hold (review of PR #242): Settings reads "Counted as used up" with a
 * line under the intro, and the proposal bar and the Updates card add the backend's sentence, each
 * until the hold ends, with no reload.
 */

const api = vi.hoisted(() => ({ getOutsideSpend: vi.fn(), fetchPersonalAgents: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  getOutsideSpend: (...args: unknown[]) => api.getOutsideSpend(...args),
  fetchPersonalAgents: (...args: unknown[]) => api.fetchPersonalAgents(...args),
}));
const flow = vi.hoisted(() => ({ fitBounds: vi.fn(), getInternalNode: vi.fn() }));
vi.mock('@xyflow/react', () => ({
  Panel: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  useReactFlow: () => flow,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(),
}));
vi.mock('../src/store/graphStore', () => {
  const state = { nodes: [], edges: [], isExecuting: false };
  const useGraphStore = (selector: (s: typeof state) => unknown) => selector(state);
  useGraphStore.getState = () => state;
  return { useGraphStore, nodeCardTitle: () => '', watchGraphSyncs: () => ({ seen: new Set<string>(), stop: () => {} }) };
});

const session = await import('../src/lib/personSession');
const { AgentSpendSection } = await import('../src/components/panels/settings/AgentSpendSection');
const { DailyTotalRow } = await import('../src/components/panels/settings/DailyTotalRow');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
const { ProposalBar } = await import('../src/components/canvas/ProposalBar');
const { NoteText } = await import('../src/components/agent-notes/AgentNoteParts');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const { LEDGER_HOLD_SENTENCE, COUNTED_AS_USED_UP, holdOn } = await import('../src/lib/ledgerHold');
const { useNowUntil, nextLocalMidnight } = await import('../src/hooks/useBefore');
const { useNodeWait } = await import('../src/lib/nodeWaitHeader');
const { waitFor, waitDescription } = await import('../src/lib/nodeWait');

const NOON = new Date(2026, 10, 14, 12, 0, 0, 0);
const UNTIL = new Date(2026, 10, 14, 15, 40, 0, 0).getTime() / 1000;
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
const pass = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE] });
  vi.setSystemTime(NOON);
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  vi.useRealTimers();
});

describe('Settings > Agent spending during the hold', () => {
  const view = (hold?: { until: number }) => ({
    outside: { spentUsd: 1.25, kreaPlanRuns: 2 },
    daily: { spentUsd: 3.4 },
    apps: [{ id: 'a1', name: 'Hermes', client: null, color: null, dailyUsd: 5, spentUsd: 0.5, kreaPlanRuns: 1 }],
    personal: [{ id: 'pa1', name: 'My agent', spentUsd: 0.75, kreaPlanRuns: 0 }],
    connect: { available: false, clients: [], reason: null },
    ...(hold ? { ledgerHold: hold } : {}),
  });
  const mount = async (hold?: { until: number }) => {
    session.resetPersonSessionForTests();
    api.getOutsideSpend.mockReset().mockResolvedValue(view(hold));
    api.fetchPersonalAgents.mockReset().mockResolvedValue({ warningAcknowledged: true, agents: [] });
    useSettingsDraftStore.setState({
      saved: { ...(useSettingsDraftStore.getState().saved ?? {}), agentSpend: { sessionUsd: 5, models: {} } } as never,
    });
    const result = render(<AgentSpendSection />);
    await flush();
    return result;
  };

  it('shows the figures when there is no hold', async () => {
    await mount();
    expect(screen.queryByTestId('settings-agent-ledger-hold')).toBeNull();
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe('$3.40 of $5 used in the last 24 hours.');
    expect(screen.getByTestId('settings-agent-outside-spent').textContent).toContain('$1.25 in the last 24 hours, 2 Krea plan runs');
    expect(screen.getByTestId('settings-personal-spend-row').textContent).toContain('$0.75 in the last 24 hours');
    expect(screen.getByTestId('settings-app-row').textContent).toContain('$0.50 in the last 24 h');
  });

  it('puts the line under the intro and reads "Counted as used up" in every usage row', async () => {
    const { container } = await mount({ until: UNTIL });
    const line = screen.getByTestId('settings-agent-ledger-hold');
    // Drawn in the figure's ink with its own gap to the card, not as fine print.
    expect(line.className).toBe('settings-hint settings-hint--state');
    expect(line.textContent).toBe(`${LEDGER_HOLD_SENTENCE} 3:40 PM.`);
    expect(line.tagName).toBe('P');
    expect(line.getAttribute('role')).toBeNull();
    // Directly under the intro paragraphs, above the limit rows.
    expect(line.previousElementSibling!.id).toBe('settings-agent-spend-who');
    expect(line.nextElementSibling!.className).toBe('settings-list');
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe(COUNTED_AS_USED_UP);
    expect(container.querySelector('[role="meter"]')).toBeNull();
    expect(screen.getByTestId('settings-agent-outside-spent').textContent!.trim()).toBe('This limit is counted as used up.');
    expect(screen.getByTestId('settings-personal-spend-row').textContent).toContain(`${COUNTED_AS_USED_UP}, inside the budget above`);
    expect(screen.getByTestId('settings-app-row').textContent).toContain(COUNTED_AS_USED_UP);
    expect(container.textContent).not.toContain('$3.40');
    expect(container.textContent).not.toContain('$1.25');
    expect(container.textContent).not.toContain('Krea plan runs, inside');
  });

  it('reads "Amount unknown" in a row whose limit is "No limit"', async () => {
    session.resetPersonSessionForTests();
    const held = view({ until: Date.now() / 1000 + 3600 });
    api.getOutsideSpend.mockReset().mockResolvedValue({ ...held, apps: [{ ...held.apps[0], dailyUsd: null }] });
    api.fetchPersonalAgents.mockReset().mockResolvedValue({ warningAcknowledged: true, agents: [] });
    useSettingsDraftStore.setState({
      saved: { ...(useSettingsDraftStore.getState().saved ?? {}),
        agentSpend: { sessionUsd: null, dailyTotalUsd: null, models: {} } } as never,
    });
    render(<AgentSpendSection />);
    await flush();
    expect(screen.getByTestId('settings-agent-ledger-hold')).toBeTruthy();
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe('Amount unknown');
    expect(screen.getByTestId('settings-agent-outside-spent').textContent!.trim()).toBe('The amount spent isn’t known.');
    expect(screen.getByTestId('settings-personal-spend-row').textContent).toContain('Amount unknown, inside the budget above');
    expect(screen.getByTestId('settings-app-row').textContent).toContain('Amount unknown');
    expect(document.body.textContent).not.toContain(COUNTED_AS_USED_UP);
    expect(document.body.textContent).not.toContain('in the last 24');
  });

  it('says the record can\'t be read, with no time, and every row reads "Amount unknown"', async () => {
    session.resetPersonSessionForTests();
    api.getOutsideSpend.mockReset().mockResolvedValue({ ...view(), ledgerBlocked: true });
    api.fetchPersonalAgents.mockReset().mockResolvedValue({ warningAcknowledged: true, agents: [] });
    useSettingsDraftStore.setState({
      saved: { ...(useSettingsDraftStore.getState().saved ?? {}), agentSpend: { sessionUsd: 5, models: {} } } as never,
    });
    render(<AgentSpendSection />);
    await flush();
    expect(screen.getByTestId('settings-agent-ledger-hold').textContent)
      .toBe('Nebula can’t open its record of what agents have spent, so agents can’t start paid runs until it can.');
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe('Amount unknown');
    expect(screen.getByTestId('settings-agent-outside-spent').textContent!.trim()).toBe('The amount spent isn’t known.');
    expect(screen.getByTestId('settings-personal-spend-row').textContent).toContain('Amount unknown, inside the budget above');
    expect(screen.getByTestId('settings-app-row').textContent).toContain('Amount unknown');
    expect(document.body.textContent).not.toContain(COUNTED_AS_USED_UP);
    expect(document.body.textContent).not.toContain('until 3');
  });

  it('says "tomorrow" when the hold ends on another date', async () => {
    await mount({ until: new Date(2026, 10, 15, 9, 5, 0, 0).getTime() / 1000 });
    expect(screen.getByTestId('settings-agent-ledger-hold').textContent).toBe(`${LEDGER_HOLD_SENTENCE} 9:05 AM tomorrow.`);
  });

  it('goes back to the figures when the hold ends, without a reload', async () => {
    const { container } = await mount({ until: UNTIL });
    expect(screen.getByTestId('settings-agent-ledger-hold')).toBeTruthy();
    await pass((UNTIL * 1000 - NOON.getTime()) - 1000);
    expect(screen.getByTestId('settings-agent-ledger-hold')).toBeTruthy();
    await pass(1500);
    expect(screen.queryByTestId('settings-agent-ledger-hold')).toBeNull();
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe('$3.40 of $5 used in the last 24 hours.');
    expect(container.querySelector('[role="meter"]')).not.toBeNull();
    expect(screen.getByTestId('settings-agent-outside-spent').textContent).toContain('$1.25');
    // The view still says the hold is on: the line went at its end, not with a read. The reads
    // every 30 s stop with it.
    const reads = api.getOutsideSpend.mock.calls.length;
    await pass(120_000);
    expect(api.getOutsideSpend).toHaveBeenCalledTimes(reads);
  });

  it('is not a hold at all when the end has already passed', async () => {
    await mount({ until: NOON.getTime() / 1000 - 60 });
    expect(screen.queryByTestId('settings-agent-ledger-hold')).toBeNull();
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe('$3.40 of $5 used in the last 24 hours.');
  });

  it('clears its timer on unmount', async () => {
    const { unmount } = await mount({ until: UNTIL });
    const before = vi.getTimerCount();
    unmount();
    expect(vi.getTimerCount()).toBeLessThan(before);
  });

  it('drops "tomorrow" at local midnight while the panel stays open', async () => {
    vi.setSystemTime(new Date(2026, 10, 14, 23, 50, 0, 0)); // Saturday
    await mount({ until: new Date(2026, 10, 15, 15, 40, 0, 0).getTime() / 1000 });
    expect(screen.getByTestId('settings-agent-ledger-hold').textContent).toBe(`${LEDGER_HOLD_SENTENCE} 3:40 PM tomorrow.`);
    await pass(9 * 60_000);
    expect(screen.getByTestId('settings-agent-ledger-hold').textContent).toBe(`${LEDGER_HOLD_SENTENCE} 3:40 PM tomorrow.`);
    await pass(2 * 60_000);
    expect(screen.getByTestId('settings-agent-ledger-hold').textContent).toBe(`${LEDGER_HOLD_SENTENCE} 3:40 PM.`);
  });

  const mountBlocked = async () => {
    session.resetPersonSessionForTests();
    api.getOutsideSpend.mockReset().mockResolvedValue({ ...view(), ledgerBlocked: true });
    api.fetchPersonalAgents.mockReset().mockResolvedValue({ warningAcknowledged: true, agents: [] });
    useSettingsDraftStore.setState({
      saved: { ...(useSettingsDraftStore.getState().saved ?? {}), agentSpend: { sessionUsd: 5, models: {} } } as never,
    });
    const result = render(<AgentSpendSection />);
    await flush();
    return result;
  };

  it('reads the view again every 30 s while the record can\'t be opened, keeping the last one until the next arrives', async () => {
    await mountBlocked();
    expect(screen.getByTestId('settings-agent-ledger-hold').textContent).toContain('can’t open its record');
    let answer!: (value: unknown) => void;
    api.getOutsideSpend.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    await pass(29_000);
    expect(api.getOutsideSpend).toHaveBeenCalledTimes(1);
    await pass(1_000);
    expect(api.getOutsideSpend).toHaveBeenCalledTimes(2);
    // Still waiting on the read: the line and the rows are as they were.
    expect(screen.getByTestId('settings-agent-ledger-hold').textContent).toContain('can’t open its record');
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe('Amount unknown');
    await act(async () => { answer(view()); });
    await flush();
    expect(screen.queryByTestId('settings-agent-ledger-hold')).toBeNull();
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe('$3.40 of $5 used in the last 24 hours.');
    // Neither state is on: no more reads.
    await pass(120_000);
    expect(api.getOutsideSpend).toHaveBeenCalledTimes(2);
  });

  it('reads the view again when the window is shown again, and stops on unmount', async () => {
    const shown = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    try {
      const { unmount } = await mountBlocked();
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await flush();
      expect(api.getOutsideSpend).toHaveBeenCalledTimes(2);
      unmount();
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await pass(120_000);
      expect(api.getOutsideSpend).toHaveBeenCalledTimes(2);
    } finally {
      shown.mockRestore();
    }
  });
});

describe('the hold clock (useNowUntil)', () => {
  function Probe({ until, seen }: { until?: number; seen: boolean[] }) {
    const now = useNowUntil(until);
    seen.push(holdOn(until === undefined ? null : { until }, now));
    return null;
  }

  it('compares a hold that arrives after mount with the clock then, so an end already past never shows', () => {
    const seen: boolean[] = [];
    const { rerender } = render(<Probe seen={seen} />);
    // Two hours on, with no timer run: the hold arrives with an end one hour after mount.
    vi.setSystemTime(NOON.getTime() + 2 * 3_600_000);
    rerender(<Probe seen={seen} until={(NOON.getTime() + 3_600_000) / 1000} />);
    expect(seen).not.toContain(true);
  });

  it('finds the next local midnight on every day of the year, the days the clocks change included', () => {
    // From 1 AM it is 23 wall-clock hours to midnight, plus whatever the zone's offset changed by
    // on the way (an hour on the days the clocks change, in a zone that changes them).
    for (let day = 1; day <= 365; day++) {
      const at = new Date(2026, 0, day, 1, 0, 0, 0);
      const midnight = new Date(nextLocalMidnight(at.getTime()));
      expect([midnight.getHours(), midnight.getMinutes()]).toEqual([0, 0]);
      const shift = (at.getTimezoneOffset() - midnight.getTimezoneOffset()) * 60_000;
      expect(midnight.getTime() - at.getTime()).toBe(23 * 3_600_000 - shift);
    }
  });
});

describe('the Daily total row, counted as used up', () => {
  it('reads the line and draws no meter', () => {
    const { container } = render(<DailyTotalRow limits={{ sessionUsd: null, models: {} }} spentUsd={3.4} counted
      disabled={false} onChange={() => {}} />);
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe(COUNTED_AS_USED_UP);
    expect(container.querySelector('[role="meter"]')).toBeNull();
  });
  it('reads "Amount unknown" when the total is "No limit": what the record counts is not the true amount', () => {
    const { container } = render(<DailyTotalRow limits={{ sessionUsd: null, dailyTotalUsd: null, models: {} }} spentUsd={3.4}
      counted disabled={false} onChange={() => {}} />);
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe('Amount unknown');
    expect(container.querySelector('.settings-daily__meter')).toBeNull();
  });
  it('keeps the meter\'s place, unshown, so the row does not jump when the hold ends', () => {
    const props = { limits: { sessionUsd: null, models: {} }, spentUsd: 3.4, disabled: false, onChange: () => {} };
    const { container, rerender } = render(<DailyTotalRow {...props} counted />);
    const held = container.querySelector('.settings-daily__meter');
    expect(held?.hasAttribute('data-held')).toBe(true);
    expect(held?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[role="meter"]')).toBeNull();
    rerender(<DailyTotalRow {...props} />);
    // The same element comes back as the meter, so its fill moves with its own transition.
    expect(container.querySelector('[role="meter"]')).toBe(held);
    expect(held?.hasAttribute('data-held')).toBe(false);
  });
  it('reads the line even while the figure loads', () => {
    render(<DailyTotalRow limits={{ sessionUsd: null, models: {} }} spentUsd={null} counted disabled={false} onChange={() => {}} />);
    expect(screen.getByTestId('settings-agent-daily-spent').textContent).toBe(COUNTED_AS_USED_UP);
  });
});

describe('a held run on the proposal bar and the Updates card', () => {
  const BAR = 'This would pass the $5 daily total, which has $0.20 left.';
  const LINE = `${LEDGER_HOLD_SENTENCE} 3:40 PM on Sunday.`;
  const wait = (ledgerHold?: ProposalWait['ledgerHold']): ProposalWait => ({
    limitUsd: 5, usedUsd: 4.8, leftUsd: 0.2, runUsd: 0.4, also: null, alsoLimitUsd: null, alsoModel: null,
    alsoFor: null, alsoPlanRuns: null, barLine: BAR, nodeIds: ['n3'], names: ['Writer'],
    ...(ledgerHold ? { ledgerHold } : {}),
  });
  const proposal = (held?: ProposalWait['ledgerHold']): ProposalView => ({
    id: 'p_wait', status: 'open', agent: { id: 'ext:claude-code', name: 'Claude Code', color: '#E8825A', verified: false },
    note: BAR, projectId: 'p', createdAt: Date.now(), expiresAt: Date.now() + 600_000, nodes: [], edges: [], params: [],
    run: ['n3'], cost: { paidRuns: 1, freeRuns: 0, estimate: null, upTo: false, providers: ['openai'], nodes: [], note: '' },
    references: ['n3'], reason: null, idMap: null, runNodeIds: null, wait: wait(held),
  });
  const reset = () => useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  const note = (): AgentNote => ({
    id: 'u1', author: { kind: 'agent', id: 'ext:claude-code', name: 'Claude Code', color: '#E8825A' }, source: 'nebula',
    about: 'other', at: NOON.toISOString(), text: 'Claude Code wants to run “Writer”. ' + BAR,
    parts: [{ text: 'Claude Code wants to run “Writer”. ' + BAR }], refs: [],
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'p_wait', target: 'canvas' } }],
    readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
  });
  const endsIn = (ms: number) => (NOON.getTime() + ms) / 1000;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    reset();
  });
  afterEach(() => { reset(); vi.unstubAllGlobals(); });

  it('adds the sentence after the bar line, then drops it when the hold ends', async () => {
    useCanvasProposalsStore.getState().open(proposal({ until: endsIn(60_000), line: LINE }), 'key-a');
    const { container } = render(<ProposalBar />);
    expect(container.querySelector('.proposal-bar__note')!.textContent).toBe(`${BAR} ${LINE}`);
    await pass(61_000);
    expect(container.querySelector('.proposal-bar__note')!.textContent).toBe(BAR);
  });

  it('shows only the bar line with no hold, or one that has ended', () => {
    useCanvasProposalsStore.getState().open(proposal(), 'key-a');
    const first = render(<ProposalBar />);
    expect(first.container.querySelector('.proposal-bar__note')!.textContent).toBe(BAR);
    first.unmount();
    reset();
    useCanvasProposalsStore.getState().open(proposal({ until: endsIn(-1000), line: LINE }), 'key-a');
    const second = render(<ProposalBar />);
    expect(second.container.querySelector('.proposal-bar__note')!.textContent).toBe(BAR);
  });

  it('adds it after the Updates card\'s sentence, and drops it at the end', async () => {
    useCanvasProposalsStore.getState().open(proposal({ until: endsIn(60_000), line: LINE }), 'key-a');
    const { container } = render(<p><NoteText note={note()} /></p>);
    expect(container.textContent).toBe(`${note().text} ${LINE}`);
    await pass(61_000);
    expect(container.textContent).toBe(note().text);
  });

  it('gives the node header\'s screen-reader reason the sentence too, and drops it at the end', async () => {
    useCanvasProposalsStore.getState().open(proposal({ until: endsIn(60_000), line: LINE }), 'key-a');
    expect(waitFor(useCanvasProposalsStore.getState(), 'n3', NOON.getTime())!.reason).toBe(`${BAR} ${LINE}`);
    expect(waitFor(useCanvasProposalsStore.getState(), 'n3', NOON.getTime() + 60_000)!.reason).toBe(BAR);
    function Reason() {
      const wait = useNodeWait('n3');
      return <span>{wait ? waitDescription(wait) : ''}</span>;
    }
    const { container } = render(<Reason />);
    expect(container.textContent).toBe(`A proposal is waiting for your OK. ${BAR} ${LINE}`);
    await pass(61_000);
    expect(container.textContent).toBe(`A proposal is waiting for your OK. ${BAR}`);
  });

  it('leaves an Update of another proposal, or with no hold, as it is', () => {
    useCanvasProposalsStore.getState().open(proposal(), 'key-a');
    expect(render(<p><NoteText note={note()} /></p>).container.textContent).toBe(note().text);
    cleanup();
    const other = { ...note(), actions: [] };
    expect(render(<p><NoteText note={other} /></p>).container.textContent).toBe(other.text);
  });
});
