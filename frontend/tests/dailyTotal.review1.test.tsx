import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { AgentPresenceEvent, ProposalView, ProposalWait } from '../src/lib/wsClient';

/**
 * The daily total, PR #212 round 2: review 1's findings and GM - Design's
 * answers (2026-10-31). Escape in "Other amount…" goes back without closing
 * Settings; focus returns to the select after Enter saves; the draft reads
 * 7.50; what can't be saved keeps the field open with a line and never saves
 * No limit; the waiting tag is a band inside the node card, one per node with
 * a count; and a run whose proposal slots are full is a neutral Agent log line.
 */

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ fitBounds: vi.fn(), getInternalNode: vi.fn() }),
  useStore: (selector: (state: unknown) => unknown) => selector({ transform: [0, 0, 1], nodeLookup: new Map() }),
  useStoreApi: () => ({ getState: () => ({ nodeLookup: new Map() }), subscribe: () => () => {} }),
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

const { DailyTotalRow } = await import('../src/components/panels/settings/DailyTotalRow');
const { usePanelFocus } = await import('../src/hooks/usePanelFocus');
const { DAILY_AMOUNT_INVALID, MAX_DAILY_TOTAL_USD, dailyAmountDraft, parseDailyAmount } = await import('../src/lib/dailyTotal');
const { NodeWaitBand } = await import('../src/components/nodes/NodeWaitBand');
const { ProposalBar } = await import('../src/components/canvas/ProposalBar');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const { WAITING_FOR_OK, waitLineId } = await import('../src/lib/canvasProposals');
const { agentActionEntry } = await import('../src/store/agentLogStore');
const { withNodeCardBoundary } = await import('../src/components/nodes/withNodeCardBoundary');
const { springLinear, SPRING_SOFT } = await import('../src/lib/springs');

const css = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8');
function rule(file: string, selector: string): string {
  const source = css(file);
  const at = source.indexOf(`${selector} {`);
  expect(at, `${selector} in ${file}`).toBeGreaterThanOrEqual(0);
  return source.slice(source.indexOf('{', at) + 1, source.indexOf('}', at));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const base = { sessionUsd: null, models: {} };

/** The row inside a panel that closes on Escape the way Settings does (usePanelFocus). */
function Panel({ onClose, onChange, disabled = false, limits = base }: {
  onClose: () => void; onChange: (next: unknown) => void; disabled?: boolean; limits?: typeof base & { dailyTotalUsd?: number | null };
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  usePanelFocus(true, ref, onClose);
  return (
    <div ref={ref} tabIndex={-1} role="dialog">
      <DailyTotalRow limits={limits} spentUsd={0} disabled={disabled} onChange={onChange} />
    </div>
  );
}

function other(container: HTMLElement): HTMLInputElement {
  fireEvent.change(container.querySelector('#settings-agent-daily')!, { target: { value: 'other' } });
  return container.querySelector<HTMLInputElement>('#settings-agent-daily-amount')!;
}

describe('"Other amount…" in Settings', () => {
  it('goes back on Escape without closing Settings', () => {
    const onClose = vi.fn();
    const onChange = vi.fn();
    const { container } = render(<Panel onClose={onClose} onChange={onChange} />);
    const input = other(container);
    fireEvent.change(input, { target: { value: '9.99' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('#settings-agent-daily-amount')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('#settings-agent-daily'));
    expect(container.querySelector('.settings-daily__field')).toBeNull();
    // Escape from the select (no field open) still closes the sheet.
    fireEvent.keyDown(container.querySelector('#settings-agent-daily')!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('claims Escape on the field, as the other rows do', () => {
    const { container } = render(<Panel onClose={() => {}} onChange={() => {}} />);
    other(container);
    expect(container.querySelector('.settings-daily__field')!.hasAttribute('data-claims-escape')).toBe(true);
  });

  it('hands focus back to the select once the save that disabled it is done', () => {
    function Saving() {
      const [pending, setPending] = useState(false);
      const [limits, setLimits] = useState<typeof base & { dailyTotalUsd?: number | null }>(base);
      return (
        <>
          <DailyTotalRow limits={limits} spentUsd={0} disabled={pending}
            onChange={(next) => { setPending(true); setLimits(next as typeof limits); }} />
          <button type="button" onClick={() => setPending(false)}>done</button>
        </>
      );
    }
    const { container, getByText } = render(<Saving />);
    const input = other(container);
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const select = container.querySelector<HTMLSelectElement>('#settings-agent-daily')!;
    expect(select.disabled).toBe(true);
    act(() => { getByText('done').click(); });
    expect(select.disabled).toBe(false);
    expect(document.activeElement).toBe(select);
  });

  it('drafts a saved amount to the cent', () => {
    expect([5, 7.5, 0.5, 12.25].map(dailyAmountDraft)).toEqual(['5', '7.50', '0.50', '12.25']);
    const { container } = render(<Panel onClose={() => {}} onChange={() => {}} limits={{ ...base, dailyTotalUsd: 7.5 }} />);
    expect(other(container).value).toBe('7.50');
  });

  it.each([['abc'], [''], ['0'], ['-3'], ['1.234'], ['100000.01']])(
    'never saves %j, and keeps the field open with a line saying why', (typed) => {
      const onChange = vi.fn();
      const { container } = render(<Panel onClose={() => {}} onChange={onChange} />);
      const input = other(container);
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onChange).not.toHaveBeenCalled();
      expect(container.querySelector('#settings-agent-daily-amount')).toBe(input);
      const line = container.querySelector('#settings-agent-daily-invalid')!;
      expect(line.textContent).toBe(DAILY_AMOUNT_INVALID);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toContain('settings-agent-daily-invalid');
      fireEvent.blur(input);
      expect(onChange).not.toHaveBeenCalled();
      // Typing again clears the line; a good amount saves.
      fireEvent.change(input, { target: { value: '6' } });
      expect(container.querySelector('#settings-agent-daily-invalid')).toBeNull();
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith({ ...base, dailyTotalUsd: 6 });
    });

  it('takes the most a total may be, and no more', () => {
    expect(MAX_DAILY_TOTAL_USD).toBe(100_000);
    expect(parseDailyAmount('100000')).toBe(100_000);
    expect(parseDailyAmount('$100,000')).toBe(100_000);
    expect(parseDailyAmount('100000.01')).toBeNull();
    expect(parseDailyAmount('1e308')).toBeNull();
  });
});

describe('the waiting band on the node card', () => {
  const wait = (nodeIds: string[]): ProposalWait => ({
    limitUsd: 5, usedUsd: 4.8, leftUsd: 0.2, runUsd: 0.4, also: null, alsoLimitUsd: null, alsoModel: null,
    alsoFor: null, alsoPlanRuns: null, barLine: 'This would pass the $5 daily total, which has $0.20 left.',
    cardLine: 'This run would pass the $5 daily total.', nodeIds, names: nodeIds,
  });
  const view = (id: string, nodeIds: string[], agent: { name: string; color: string }, createdAt: number): ProposalView => ({
    id, status: 'open', agent: { id: `ext:${agent.name}`, name: agent.name, color: agent.color, verified: false },
    note: wait(nodeIds).barLine, projectId: 'p', createdAt, expiresAt: Date.now() + 600_000,
    nodes: [], edges: [], params: [], run: nodeIds,
    cost: { paidRuns: 1, freeRuns: 0, estimate: 0.4, upTo: false, providers: ['openai'], nodes: [], note: '' },
    references: nodeIds, reason: null, idMap: null, runNodeIds: null, wait: wait(nodeIds),
  });
  const CLAUDE = { name: 'Claude Code', color: '#c7f36b' };
  const CODEX = { name: 'Codex', color: '#5b9dff' };

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, shownId: null,
      deferredRun: null });
  });

  it('shows on a waiting node only, above the card, inside the node\'s own box', () => {
    useCanvasProposalsStore.getState().open(view('p_one', ['n2'], CLAUDE, 1), 'key');
    const Card = () => <div className="model-node"><span className="node-title">Writer</span></div>;
    const Bounded = withNodeCardBoundary(Card as never);
    const props = (id: string) => ({ id, data: {}, type: 'model', selected: false } as never);
    const waiting = render(<div data-testid="node"><Bounded {...props('n2')} /></div>);
    const node = waiting.getByTestId('node');
    const band = node.querySelector<HTMLElement>('.node-wait-band')!;
    // First in the node, the card right after it: above the title, inside the node's box.
    expect(node.firstElementChild).toBe(band);
    expect(band.nextElementSibling!.className).toBe('model-node');
    expect(band.querySelector('.node-wait-band__status')!.textContent).toBe(WAITING_FOR_OK);
    expect(band.querySelector('.node-wait-band__line')!.textContent).toBe('This run would pass the $5 daily total.');
    expect(band.style.getPropertyValue('--agent-color')).toBe(CLAUDE.color);
    const other = render(<div data-testid="other"><Bounded {...props('n9')} /></div>);
    expect(other.getByTestId('other').querySelector('.node-wait-band')).toBeNull();
  });

  it('shows the shown proposal and a count when several wait on one node', () => {
    useCanvasProposalsStore.getState().open(view('p_one', ['n2'], CLAUDE, 1), 'key');
    useCanvasProposalsStore.getState().open(view('p_two', ['n2', 'n3'], CODEX, 2), 'key');
    const { container } = render(<NodeWaitBand nodeId="n2" />);
    const band = container.querySelector<HTMLElement>('.node-wait-band')!;
    expect(band.querySelector('.node-wait-band__status')!.textContent).toBe(`${WAITING_FOR_OK} · 2`);
    // Nothing shown on the bar: the newest speaks for the node.
    expect(band.dataset.proposal).toBe('p_two');
    act(() => useCanvasProposalsStore.getState().setShown('p_one'));
    expect(band.dataset.proposal).toBe('p_one');
    expect(band.style.getPropertyValue('--agent-color')).toBe(CLAUDE.color);
    expect(band.querySelector('.node-wait-band__line')!.textContent).toBe('This run would pass the $5 daily total.');
    // One band per node, whatever the count.
    expect(container.querySelectorAll('.node-wait-band')).toHaveLength(1);
    const lone = render(<NodeWaitBand nodeId="n3" />);
    expect(lone.container.querySelector('.node-wait-band__status')!.textContent).toBe(WAITING_FOR_OK);
  });

  it('points at the bar\'s line while the bar shows it, and stops when the bar goes', () => {
    useCanvasProposalsStore.getState().open(view('p_one', ['n2'], CLAUDE, 1), 'key');
    const band = render(<NodeWaitBand nodeId="n2" />);
    const tag = band.container.querySelector('.node-wait-band__tag')!;
    expect(tag.getAttribute('role')).toBe('status');
    expect(tag.getAttribute('aria-describedby')).toBeNull();
    const bar = render(<ProposalBar />);
    expect(tag.getAttribute('aria-describedby')).toBe(waitLineId('p_one'));
    expect(document.getElementById(waitLineId('p_one'))).not.toBeNull();
    bar.unmount();
    // The bar's unmount clears what it showed: no pointer at a line that's gone.
    expect(useCanvasProposalsStore.getState().shownId).toBeNull();
    expect(tag.getAttribute('aria-describedby')).toBeNull();
  });

  it('opens on the next frame and closes on the soft spring before it goes', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.useFakeTimers();
    useCanvasProposalsStore.getState().open(view('p_one', ['n2'], CLAUDE, 1), 'key');
    const { container } = render(<NodeWaitBand nodeId="n2" />);
    const band = () => container.querySelector<HTMLElement>('.node-wait-band');
    expect(band()!.dataset.open).toBe('false');
    act(() => { vi.advanceTimersByTime(20); });
    expect(band()!.dataset.open).toBe('true');
    // Accept or reject: it shrinks back, then goes.
    act(() => useCanvasProposalsStore.setState({ proposals: {} }));
    expect(band()!.dataset.open).toBe('false');
    act(() => { vi.advanceTimersByTime(springLinear(SPRING_SOFT).durationMs - 5); });
    expect(band()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(10); });
    expect(band()).toBeNull();
  });

  it('starts shrinking as soon as its proposal is closing, and stops counting it', () => {
    useCanvasProposalsStore.getState().open(view('p_one', ['n2'], CLAUDE, 1), 'key');
    useCanvasProposalsStore.getState().open(view('p_two', ['n2'], CODEX, 2), 'key');
    const { container } = render(<NodeWaitBand nodeId="n2" />);
    const status = () => container.querySelector('.node-wait-band__status')!.textContent;
    expect(status()).toBe(`${WAITING_FOR_OK} · 2`);
    // The ghosts fade out while a decided proposal is closing: the band no longer counts it.
    act(() => useCanvasProposalsStore.setState((state) => ({
      proposals: { ...state.proposals, p_two: { ...state.proposals.p_two, closing: 'rejected' } },
    })));
    expect(status()).toBe(WAITING_FOR_OK);
    expect(container.querySelector<HTMLElement>('.node-wait-band')!.dataset.proposal).toBe('p_one');
    act(() => useCanvasProposalsStore.setState((state) => ({
      proposals: { ...state.proposals, p_one: { ...state.proposals.p_one, closing: 'accepted' } },
    })));
    expect(container.querySelector<HTMLElement>('.node-wait-band')!.dataset.open).toBe('false');
  });

  it('changes at once under reduced motion', () => {
    useCanvasProposalsStore.getState().open(view('p_one', ['n2'], CLAUDE, 1), 'key');
    const { container } = render(<NodeWaitBand nodeId="n2" />);
    expect(container.querySelector<HTMLElement>('.node-wait-band')!.dataset.open).toBe('true');
    expect(css('node-wait-band.css')).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[^}]*\.node-wait-band,[^}]*\.node-wait-band\[data-open='true'\] \{\s*transition: none;/);
  });

  it('opens at once under reduced motion when the band arrives after the node, and closes at once', () => {
    vi.useFakeTimers();
    const { container } = render(<NodeWaitBand nodeId="n2" />);
    expect(container.querySelector('.node-wait-band')).toBeNull();
    act(() => useCanvasProposalsStore.getState().open(view('p_one', ['n2'], CLAUDE, 1), 'key'));
    // No frame has run: reduced motion opens it in the same render.
    expect(container.querySelector<HTMLElement>('.node-wait-band')!.dataset.open).toBe('true');
    act(() => useCanvasProposalsStore.setState({ proposals: {} }));
    expect(container.querySelector<HTMLElement>('.node-wait-band')!.dataset.open).toBe('false');
    act(() => { vi.advanceTimersByTime(1); });
    expect(container.querySelector('.node-wait-band')).toBeNull();
  });

  it('grows the node by its height on the springs, never stock easing, and takes no clicks', () => {
    const closed = rule('node-wait-band.css', 'body.app-slava-restraint .node-wait-band');
    expect(closed).toMatch(/grid-template-rows:\s*0fr/);
    expect(closed).toMatch(/transition:\s*grid-template-rows var\(--spring-soft-ms\) var\(--spring-soft\)/);
    expect(closed).toMatch(/pointer-events:\s*none/);
    // The card's width, never wider.
    expect(closed).toMatch(/width:\s*0;/);
    expect(closed).toMatch(/min-width:\s*100%/);
    const open = rule('node-wait-band.css', "body.app-slava-restraint .node-wait-band[data-open='true']");
    expect(open).toMatch(/grid-template-rows:\s*1fr/);
    expect(open).toMatch(/transition:\s*grid-template-rows var\(--spring-pop-ms\) var\(--spring-pop\)/);
    expect(css('node-wait-band.css')).not.toMatch(/ease-in-out|ease-out|ease-in|\bease\b/);
    expect(rule('node-wait-band.css', 'body.app-slava-restraint .node-wait-band__tag')).toMatch(
      /border:\s*1px solid var\(--agent-color\)/);
  });

  it('leaves no overlay tag on the canvas', () => {
    expect(css('canvasProposals.css')).not.toContain('.proposal-wait');
    const layer = readFileSync(join(__dirname, '../src/components/canvas/ProposalLayer.tsx'), 'utf8');
    expect(layer).not.toContain('proposal-wait');
  });
});

describe('a run whose proposal slots are full', () => {
  const event = (extra: Partial<AgentPresenceEvent>): AgentPresenceEvent => ({
    type: 'agentPresence', agent: { id: 'ext:claude-code', name: 'Claude Code', color: '#c7f36b' },
    action: 'click', say: '', at: 1_000, ...extra,
  } as AgentPresenceEvent);
  const LINE = 'couldn’t run “Writer” because it would pass the $5 daily total and its 3 proposal slots are full.';

  it('is a neutral line in the Agent log, under the agent\'s name', () => {
    const entry = agentActionEntry(event({ log: LINE, tone: 'muted' }))!;
    expect(entry.message).toBe(LINE);
    expect(entry.tone).toBe('muted');
    expect(entry.agent!.name).toBe('Claude Code');
    expect(agentActionEntry(event({ log: 'Added “Writer”' }))!.tone).toBeUndefined();
    const muted = rule('slava-restraint.css', 'body.app-slava-restraint .agent-log__entry--muted .agent-log__msg');
    expect(muted).toMatch(/color:\s*var\(--sr-ink-light\)/);
    expect(muted).not.toMatch(/error|danger/);
  });
});
