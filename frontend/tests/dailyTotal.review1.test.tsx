import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

/**
 * The daily total, PR #212 round 2: review 1's findings and GM - Design's
 * answers (2026-10-31). Escape in "Other amount…" goes back without closing
 * Settings; focus returns to the select after Enter saves; the draft reads
 * 7.50; what can't be saved keeps the field open with a line and never saves
 * No limit; and a run whose proposal slots are full is a neutral Agent log line.
 * (The waiting state in the node's header is tests/nodeWaitHeader.test.tsx.)
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
const { agentActionEntry } = await import('../src/store/agentLogStore');

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

describe('a run whose proposal slots are full', () => {
  const event = (extra: Partial<AgentPresenceEvent>): AgentPresenceEvent => ({
    type: 'agentPresence', agent: { id: 'ext:claude-code', name: 'Claude Code', color: '#c7f36b' },
    action: 'click', say: '', at: 1_000, ...extra,
  } as AgentPresenceEvent);
  const LINE = 'Couldn’t run “Writer” because it would pass the $5 daily total and all 3 proposal slots are full.';

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
