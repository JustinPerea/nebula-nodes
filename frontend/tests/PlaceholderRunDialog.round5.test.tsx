import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import { askPlaceholderRun } from '../src/components/askPlaceholderRun';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';

// GM - Design, round 5 (2026-10-25), verbatim: "When the dialog comes back
// because the run changed, add this line above the rows: 'This run changed
// since you last reviewed it.'" and "When a row or the total changes while
// the dialog is open, ignore clicks on the Run button for ~500 ms and keep
// focus where it was." The guard also applies when it reopens with changed
// numbers (confirmed by GM). Review 4, M3.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const CHANGED = 'This run changed since you last reviewed it.';

const model = (price: string, total: string): PlaceholderRunConfirm => ({
  heading: 'Run 1 node Codex is still setting up?',
  intro: "Codex hasn't finished this, so its settings may not be final.",
  rows: [{ nodeId: 'i', name: '“Hero still”', model: 'FLUX.2 [pro]', price, agent: codex }],
  freeLine: null,
  totalLine: `This run could cost up to ${total} at list prices.`,
  notes: [],
  runLabel: `Run for ${total}`,
  confirmIds: ['i'],
  confirmCost: Number(total.slice(1)),
});

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('the re-asked dialog', () => {
  it('says why it came back, above the rows', () => {
    render(<PlaceholderRunDialog model={model('$0.03', '$0.03')} changed onDone={() => {}} />);
    const changed = screen.getByText(CHANGED);
    const rows = document.querySelector('.placeholder-run__rows')!;
    expect(changed.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a first ask has no such line', () => {
    render(<PlaceholderRunDialog model={model('$0.03', '$0.03')} onDone={() => {}} />);
    expect(screen.queryByText(CHANGED)).toBeNull();
  });

  it('ignores Run for 500 ms after it reopens, then takes it', () => {
    const answers: boolean[] = [];
    render(<PlaceholderRunDialog model={model('$0.03', '$0.03')} changed onDone={(ok) => answers.push(ok)} />);
    fireEvent.click(screen.getByText('Run for $0.03'));
    expect(answers).toEqual([]);
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.click(screen.getByText('Run for $0.03'));
    expect(answers).toEqual([true]);
  });

  it('Cancel is never held back', () => {
    const answers: boolean[] = [];
    render(<PlaceholderRunDialog model={model('$0.03', '$0.03')} changed onDone={(ok) => answers.push(ok)} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(answers).toEqual([false]);
  });
});

describe('a price that changes while the dialog is open', () => {
  it('holds Run for 500 ms and keeps focus where it was', () => {
    const answers: boolean[] = [];
    const { rerender } = render(<PlaceholderRunDialog model={model('price not listed', '$0')} onDone={(ok) => answers.push(ok)} />);
    const run = document.querySelector<HTMLButtonElement>('.prompt-dialog__confirm')!;
    act(() => { run.focus(); });
    rerender(<PlaceholderRunDialog model={model('$35', '$35')} onDone={(ok) => answers.push(ok)} />);
    expect(document.activeElement).toBe(run);
    expect(run.textContent).toBe('Run for $35');
    fireEvent.click(run);
    expect(answers).toEqual([]);
    act(() => { vi.advanceTimersByTime(499); });
    fireEvent.click(run);
    expect(answers).toEqual([]);
    act(() => { vi.advanceTimersByTime(1); });
    fireEvent.click(run);
    expect(answers).toEqual([true]);
  });

  it('the same words again hold nothing back', () => {
    const answers: boolean[] = [];
    const { rerender } = render(<PlaceholderRunDialog model={model('$0.03', '$0.03')} onDone={(ok) => answers.push(ok)} />);
    rerender(<PlaceholderRunDialog model={model('$0.03', '$0.03')} onDone={(ok) => answers.push(ok)} />);
    fireEvent.click(screen.getByText('Run for $0.03'));
    expect(answers).toEqual([true]);
  });

  it('askPlaceholderRun shows what its watch sends, at once, and stops watching once answered', async () => {
    let push: ((next: PlaceholderRunConfirm) => void) | undefined;
    const stop = vi.fn();
    let answer: Promise<PlaceholderRunConfirm | null> | undefined;
    await act(async () => {
      answer = askPlaceholderRun(model('price not listed', '$0'), { watch: (show) => { push = show; return stop; } });
    });
    act(() => { push!(model('$35', '$35')); });
    // Already drawn: a click right after the push can't land on the old words.
    expect(document.querySelector('.placeholder-run__row')!.textContent).toContain('$35');
    fireEvent.click(screen.getByText('Run for $35'));
    act(() => { vi.advanceTimersByTime(500); });
    await act(async () => { fireEvent.click(screen.getByText('Run for $35')); });
    // Review 5, L6: it hands back the words it showed.
    await expect(answer).resolves.toMatchObject({ runLabel: 'Run for $35' });
    expect(stop).toHaveBeenCalledOnce();
  });
});
