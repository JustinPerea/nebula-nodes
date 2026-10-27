import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import { askPlaceholderRun } from '../src/components/askPlaceholderRun';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';

// GM - Design, round 6 (2026-10-26): a paid node that isn't a placeholder
// gets a muted row with no agent dot (item 3), and "This run changed since
// you last reviewed it." shows for in-place updates too (note 2). Review 5:
// the change is announced to screen readers (L7), and Run hands back the
// words it was showing when it was clicked (L6).

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const CHANGED = 'This run changed since you last reviewed it.';
/** The visible line (the live region says it too, for screen readers). */
const changedLine = () => document.querySelector('.placeholder-run__changed')?.textContent ?? null;

const model = (price: string, total: string, heading = 'Run 1 node Codex is still setting up?'): PlaceholderRunConfirm => ({
  heading,
  intro: "Codex hasn't finished this, so its settings may not be final.",
  rows: [{ nodeId: 'i', name: '“Hero still”', model: 'FLUX.2 [pro]', price, agent: codex },
    { nodeId: 's', name: '“Shot 1”', model: 'Nano Banana', price: '$0.07', agent: null }],
  freeLine: 'Plus 1 free node.',
  totalLine: `This run could cost up to ${total} at list prices.`,
  notes: [],
  runLabel: `Run for ${total}`,
  confirmIds: ['i'],
  confirmCost: Number(total.slice(1)),
});

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('GM round 6, item 3: the muted row', () => {
  it('has no agent dot and reads as the others do, above the free line', () => {
    render(<PlaceholderRunDialog model={model('$0.03', '$0.10')} onDone={() => {}} />);
    const rows = [...document.querySelectorAll('.placeholder-run__row')];
    expect(rows.map((row) => row.textContent)).toEqual(['“Hero still” · FLUX.2 [pro] · $0.03', '“Shot 1” · Nano Banana · $0.07']);
    expect(rows[0].querySelector('.placeholder-run__dot')).not.toBeNull();
    expect(rows[1].querySelector('.placeholder-run__dot')).toBeNull();
    expect(rows[1].classList.contains('placeholder-run__row--muted')).toBe(true);
    const free = screen.getByText('Plus 1 free node.');
    expect(rows[1].compareDocumentPosition(free) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// GM round 17 (1) replaced note 2's line with the nodes that moved, named
// (PlaceholderRunDialog.round17); these keep what still holds of it.
describe('GM round 6, note 2, as round 17 rules it: in-place updates', () => {
  it('a price that moves names its node, and the line stays', () => {
    const { rerender } = render(<PlaceholderRunDialog model={model('price not listed', '$0.07')} onDone={() => {}} />);
    expect(changedLine()).toBeNull();
    rerender(<PlaceholderRunDialog model={model('$9.95', '$10.02')} onDone={() => {}} />);
    expect(changedLine()).toBe('“Hero still” changed while this was open.');
    rerender(<PlaceholderRunDialog model={model('price not listed', '$0.07')} onDone={() => {}} />);
    expect(changedLine()).toBe('“Hero still” changed while this was open.');
    expect(screen.queryByText(CHANGED)).toBeNull();
  });

  it('a new heading alone holds Run, with no changed line (no node moved; H1: no placeholder left)', () => {
    const answers: boolean[] = [];
    const { rerender } = render(<PlaceholderRunDialog model={model('$0.03', '$0.10')} onDone={(ok) => answers.push(ok)} />);
    rerender(<PlaceholderRunDialog model={model('$0.03', '$0.10', "Run with Codex's changes?")} onDone={(ok) => answers.push(ok)} />);
    expect(changedLine()).toBeNull();
    fireEvent.click(screen.getByText('Run for $0.10'));
    expect(answers).toEqual([]); // held for 500 ms
  });

  it('review 5, L7: each in-place change is announced through a polite live region', () => {
    const { rerender } = render(<PlaceholderRunDialog model={model('price not listed', '$0.07')} onDone={() => {}} />);
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live).not.toBeNull();
    expect(live.textContent).toBe('');
    rerender(<PlaceholderRunDialog model={model('$9.95', '$10.02')} onDone={() => {}} />);
    const first = live.textContent;
    expect(first?.trim()).toBe('“Hero still” changed while this was open.');
    rerender(<PlaceholderRunDialog model={model('$12.00', '$12.07')} onDone={() => {}} />);
    expect(live.textContent?.trim()).toBe('“Hero still” changed while this was open.');
    expect(live.textContent).not.toBe(first); // a fresh announcement, not the same text left in place
  });
});

describe('review 5, L6: Run hands back the words on screen when it was clicked', () => {
  it('askPlaceholderRun resolves with the model the dialog showed, or null for Cancel', async () => {
    let push: ((next: PlaceholderRunConfirm) => void) | undefined;
    let answer: Promise<PlaceholderRunConfirm | null> | undefined;
    await act(async () => {
      answer = askPlaceholderRun(model('price not listed', '$0.07'), { watch: (show) => { push = show; return () => {}; } });
    });
    act(() => { push!(model('$9.95', '$10.02')); });
    act(() => { vi.advanceTimersByTime(500); });
    await act(async () => { fireEvent.click(screen.getByText('Run for $10.02')); });
    await expect(answer).resolves.toMatchObject({ runLabel: 'Run for $10.02', confirmCost: 10.02 });
    let cancelled: Promise<PlaceholderRunConfirm | null> | undefined;
    await act(async () => { cancelled = askPlaceholderRun(model('$0.03', '$0.10')); });
    await act(async () => { fireEvent.click(screen.getByText('Cancel')); });
    await expect(cancelled).resolves.toBeNull();
  });

  it('the dialog passes the model it rendered to onDone', () => {
    const seen: Array<PlaceholderRunConfirm | undefined> = [];
    render(<PlaceholderRunDialog model={model('$0.03', '$0.10')} onDone={(_ok, shown) => seen.push(shown)} />);
    fireEvent.click(screen.getByText('Run for $0.10'));
    expect(seen[0]?.runLabel).toBe('Run for $0.10');
  });
});
