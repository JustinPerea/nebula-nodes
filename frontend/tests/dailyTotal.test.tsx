import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProposalView, ProposalWait } from '../src/lib/wsClient';

/**
 * The daily total (Justin decided, 2026-10-31; GM - Design's design,
 * verbatim): the Settings row, the proposal bar's line, the waiting node's
 * status and line, and the lock a tab not opened from the link keeps.
 */

const flow = vi.hoisted(() => ({
  fitBounds: vi.fn(), getInternalNode: vi.fn(),
  state: { transform: [0, 0, 1] as [number, number, number], nodeLookup: new Map<string, unknown>() },
}));
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => flow,
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
  useStoreApi: () => ({ getState: () => flow.state, subscribe: () => () => {} }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/lib/backend', () => ({ apiFetch: vi.fn() }));
vi.mock('../src/store/graphStore', () => {
  const state = { nodes: [], edges: [], isExecuting: false };
  const useGraphStore = (selector: (s: typeof state) => unknown) => selector(state);
  useGraphStore.getState = () => state;
  return { useGraphStore, watchGraphSyncs: () => ({ seen: new Set<string>(), stop: () => {} }) };
});

const {
  DAILY_TOTAL_CHOICES, dailyLimit, dailyMeterShown, dailyUsageLine, limitUsd, parseDailyAmount,
} = await import('../src/lib/dailyTotal');
const { DailyTotalRow } = await import('../src/components/panels/settings/DailyTotalRow');
const { ProposalBar } = await import('../src/components/canvas/ProposalBar');
const { ProposalLayer } = await import('../src/components/canvas/ProposalLayer');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const { readAgentSpend } = await import('../src/store/settingsDraftStore');
const { PROPOSAL_GATE_COPY, WAITING_FOR_OK, waitLineId } = await import('../src/lib/canvasProposals');
const { notePersonPromoted, reportPersonRequired } = await import('../src/lib/personSession');

// GM - Design, 2026-10-31, verbatim.
const DESCRIPTION = 'Shared by everything that isn’t you: agent chats, agents outside Nebula, scripts and tabs '
  + 'not opened from your link. Counts the last 24 hours.';
const BAR = 'This would pass the $5 daily total, which has $0.20 left.';
const CARD = 'This run would pass the $5 daily total.';

describe('the lines', () => {
  it('reads usage as GM wrote it', () => {
    expect(dailyUsageLine(0, 5)).toBe('Nothing spent in the last 24 hours.');
    expect(dailyUsageLine(3.4, 5)).toBe('$3.40 of $5 used in the last 24 hours.');
    expect(dailyUsageLine(5.2, 5)).toBe('$5.20 of $5 used in the last 24 hours. New runs wait for your OK.');
    expect(dailyUsageLine(5, 5)).toBe('$5.00 of $5 used in the last 24 hours. New runs wait for your OK.');
    expect(dailyUsageLine(3.4, null)).toBe('$3.40 spent in the last 24 hours.');
    expect(dailyUsageLine(0, null)).toBe('Nothing spent in the last 24 hours.');
  });

  it('writes limits as the backend does (agent_spend.limit_usd)', () => {
    expect([5, 7.5, 0.5, 1000, 2.999].map(limitUsd)).toEqual(['$5', '$7.50', '$0.50', '$1,000', '$3']);
  });

  it('defaults to $5 and keeps an explicit "No limit"', () => {
    expect(dailyLimit(undefined)).toBe(5);
    expect(dailyLimit(null)).toBeNull();
    expect(readAgentSpend({}).dailyTotalUsd).toBeUndefined();
    expect(readAgentSpend({ dailyTotalUsd: null }).dailyTotalUsd).toBeNull();
    expect(readAgentSpend({ dailyTotalUsd: 7.5 }).dailyTotalUsd).toBe(7.5);
    // Unreadable is the default, never no limit (as the backend reads it).
    expect(readAgentSpend({ dailyTotalUsd: 'lots' }).dailyTotalUsd).toBeUndefined();
  });

  it('shows the meter only with a limit and something spent', () => {
    expect(dailyMeterShown(0, 5)).toBe(false);
    expect(dailyMeterShown(1, null)).toBe(false);
    expect(dailyMeterShown(1, 5)).toBe(true);
  });

  it('takes a typed dollar amount', () => {
    expect(parseDailyAmount('7.50')).toBe(7.5);
    expect(parseDailyAmount('$12')).toBe(12);
    expect(parseDailyAmount('0')).toBeNull();
    expect(parseDailyAmount('abc')).toBeNull();
    expect(parseDailyAmount('1.234')).toBeNull();
  });
});

describe('Settings: the Daily total row', () => {
  const base = { sessionUsd: null, models: {} };
  const row = (limits: Record<string, unknown>, spentUsd: number | null = 0) => {
    const onChange = vi.fn();
    const view = render(<DailyTotalRow limits={{ ...base, ...limits }} spentUsd={spentUsd} disabled={false}
      onChange={onChange} />);
    return { onChange, ...view };
  };

  afterEach(cleanup);

  it('labels it as GM wrote it, with $5 preselected and no "(default)"', () => {
    const { container } = row({});
    expect(screen.getByLabelText('Daily total')).toBeTruthy();
    expect(container.querySelector('#settings-agent-daily-help')!.textContent).toBe(
      `${DESCRIPTION} Nothing spent in the last 24 hours.`);
    const select = container.querySelector<HTMLSelectElement>('#settings-agent-daily')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(
      ['$1 / day', '$2 / day', '$5 / day', '$10 / day', '$20 / day', '$50 / day', 'Other amount…', 'No limit']);
    expect(select.value).toBe('5');
    expect(container.textContent).not.toContain('(default)');
    expect(DAILY_TOTAL_CHOICES).toEqual([1, 2, 5, 10, 20, 50]);
  });

  it('saves a choice and "No limit" as null', () => {
    const { onChange, container } = row({});
    const select = container.querySelector<HTMLSelectElement>('#settings-agent-daily')!;
    fireEvent.change(select, { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...base, dailyTotalUsd: 20 });
    fireEvent.change(select, { target: { value: 'none' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...base, dailyTotalUsd: null });
  });

  it('shows "No limit" when that is saved, and its usage line', () => {
    const { container } = row({ dailyTotalUsd: null }, 3.4);
    expect(container.querySelector<HTMLSelectElement>('#settings-agent-daily')!.value).toBe('none');
    expect(screen.getByTestId('settings-agent-daily-spent').textContent!.trim()).toBe('$3.40 spent in the last 24 hours.');
    expect(container.querySelector('[role="meter"]')).toBeNull();
  });

  it('opens "Other amount…" as a $ … / day field: Enter saves, Escape goes back, blur saves', () => {
    const { onChange, container } = row({});
    fireEvent.change(container.querySelector('#settings-agent-daily')!, { target: { value: 'other' } });
    const input = container.querySelector<HTMLInputElement>('#settings-agent-daily-amount')!;
    expect(document.activeElement).toBe(input);
    const field = container.querySelector('.settings-daily__field')!;
    expect(field.textContent).toBe('$/ day');
    fireEvent.change(input, { target: { value: '7.50' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ ...base, dailyTotalUsd: 7.5 });
    expect(container.querySelector('#settings-agent-daily-amount')).toBeNull();
    // Escape: back to the select, nothing saved.
    onChange.mockClear();
    fireEvent.change(container.querySelector('#settings-agent-daily')!, { target: { value: 'other' } });
    const again = container.querySelector<HTMLInputElement>('#settings-agent-daily-amount')!;
    fireEvent.change(again, { target: { value: '9' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(container.querySelector('#settings-agent-daily'));
    // Blur saves.
    fireEvent.change(container.querySelector('#settings-agent-daily')!, { target: { value: 'other' } });
    const third = container.querySelector<HTMLInputElement>('#settings-agent-daily-amount')!;
    fireEvent.change(third, { target: { value: '12' } });
    fireEvent.blur(third);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ ...base, dailyTotalUsd: 12 });
  });

  it('shows a custom amount as its own option', () => {
    const { container } = row({ dailyTotalUsd: 7.5 });
    const select = container.querySelector<HTMLSelectElement>('#settings-agent-daily')!;
    expect(select.value).toBe('7.5');
    expect(select.options[0].textContent).toBe('$7.50 / day');
  });

  it('reads partial and at-the-limit use, with a neutral meter that says the same', () => {
    const partial = row({}, 3.4);
    const meter = partial.container.querySelector<HTMLElement>('[role="meter"]')!;
    expect(screen.getByTestId('settings-agent-daily-spent').textContent!.trim()).toBe('$3.40 of $5 used in the last 24 hours.');
    expect(meter.getAttribute('aria-valuenow')).toBe('3.4');
    expect(meter.getAttribute('aria-valuemax')).toBe('5');
    expect(meter.getAttribute('aria-valuetext')).toBe('$3.40 of $5 used in the last 24 hours.');
    expect(meter.querySelector<HTMLElement>('.settings-daily__meter-fill')!.style.getPropertyValue('--daily-fill')).toBe('0.68');
    cleanup();
    const over = row({}, 5.2);
    expect(screen.getByTestId('settings-agent-daily-spent').textContent!.trim()).toBe(
      '$5.20 of $5 used in the last 24 hours. New runs wait for your OK.');
    expect(over.container.querySelector('[role="meter"]')!.getAttribute('aria-valuetext')).toBe(
      '$5.20 of $5 used in the last 24 hours. New runs wait for your OK.');
    cleanup();
    const none = row({}, 0);
    expect(none.container.querySelector('[role="meter"]')).toBeNull();
  });
});

describe('a run the daily total holds', () => {
  const wait: ProposalWait = {
    limitUsd: 5, usedUsd: 4.8, leftUsd: 0.2, runUsd: 0.4, also: null, perRunLimitUsd: null,
    barLine: BAR, cardLine: CARD, nodeIds: ['n3'], names: ['Writer'],
  };
  const view = (): ProposalView => ({
    id: 'p_wait', status: 'open', agent: { id: 'ext:claude-code', name: 'Claude Code', color: '#E8825A', verified: false },
    note: BAR, projectId: 'p', createdAt: Date.now(), expiresAt: Date.now() + 600_000, nodes: [], edges: [], params: [],
    run: ['n3'], cost: { paidRuns: 1, freeRuns: 0, estimate: null, upTo: false, providers: ['openai'], nodes: [], note: '' },
    references: ['n3'], reason: null, idMap: null, runNodeIds: null, wait,
  });

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    flow.state.nodeLookup = new Map([['n3', {
      id: 'n3', measured: { width: 240, height: 160 }, internals: { positionAbsolute: { x: 100, y: 200 } },
    }]]);
    useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, shownId: null,
      deferredRun: null });
    useCanvasProposalsStore.getState().open(view(), 'key-a');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    notePersonPromoted();
  });

  it('puts GM\'s line in the bar\'s line spot', () => {
    const { container } = render(<ProposalBar />);
    const line = container.querySelector('.proposal-bar__note')!;
    expect(line.textContent).toBe(BAR);
    expect(line.id).toBe(waitLineId('p_wait'));
    expect(screen.getByRole('button', { name: /^Accept & run/ })).toBeTruthy();
  });

  it('shows "Waiting for your OK" and the line on each waiting node, pointing at the bar while it shows', () => {
    const layer = render(<ProposalLayer />);
    const tag = layer.container.querySelector<HTMLElement>('.proposal-wait__tag')!;
    expect(layer.container.querySelector('.proposal-wait__status')!.textContent).toBe(WAITING_FOR_OK);
    expect(WAITING_FOR_OK).toBe('Waiting for your OK');
    expect(layer.container.querySelector('.proposal-wait__line')!.textContent).toBe(CARD);
    expect(layer.container.querySelector<HTMLElement>('.proposal-wait')!.style.transform).toBe('translate(100px, 200px)');
    expect(tag.getAttribute('aria-describedby')).toBeNull();
    render(<ProposalBar />);
    expect(tag.getAttribute('aria-describedby')).toBe(waitLineId('p_wait'));
    expect(document.getElementById(waitLineId('p_wait'))!.textContent).toBe(BAR);
  });

  it('keeps the not-connected lock on a tab not opened from the link', () => {
    act(() => reportPersonRequired());
    render(<ProposalBar />);
    const accept = screen.getByRole('button', { name: /^Accept & run/ });
    expect(accept.getAttribute('title')).toBe(PROPOSAL_GATE_COPY.accept);
    expect((accept as HTMLButtonElement).disabled || accept.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});
