import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import { changedNodesLine, movedRowIds, type PlaceholderRunConfirm, type PlaceholderRunRow } from '../src/lib/placeholderRunConfirm';

// GM - Design, round 17 (1), verbatim: "In-place dialog update names the
// nodes, same form as the re-ask: replace round 6's "This run changed since
// you last reviewed it." with "“Alt still” changed while this was open." (up
// to 3 names in row order: "“A” and “B” …", "“A”, “B” and “C” …"; from 4 up
// the count: "4 nodes changed while this was open."). Name only nodes whose
// route or price moved. When a node joins or leaves the run, the existing
// lines cover it (e.g. "2 nodes the agents were setting up are no longer in
// this run."); don't add the changed line on top of those. The 500 ms click
// guard applies whenever the run button's price changes in place, not only
// on a re-ask (the pointer may be resting on the button)."
// Review 16, L-1 (coordinator's decision, GM confirmed): the line names each
// node the way its row reads now.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const row = (nodeId: string, name: string, model: string, price: string): PlaceholderRunRow =>
  ({ nodeId, name: `“${name}”`, model, modelKey: model, setting: null, price, agent: codex });
const model = (rows: PlaceholderRunRow[], extra: Partial<PlaceholderRunConfirm> = {}): PlaceholderRunConfirm => {
  const total = rows.length * 3;
  return {
    heading: `Run ${rows.length} nodes Codex is still setting up?`,
    intro: "Codex hasn't finished these, so their settings may not be final.",
    savedLine: null, leftLine: null, rows, freeLine: null,
    totalLine: `This run could cost up to $0.${String(total).padStart(2, '0')} at list prices.`,
    notes: [], costNotes: [], runLabel: `Run for $0.${String(total).padStart(2, '0')}`,
    confirmIds: rows.map((r) => r.nodeId), confirmCost: total / 100, ...extra,
  };
};
const hero = row('a', 'Hero still', 'Krea 2 Medium (Krea)', '$0.03');
const alt = row('b', 'Alt still', 'Krea 2 Medium (Krea)', '$0.03');
const wide = row('c', 'Wide', 'Krea 2 Medium (Krea)', '$0.03');
const close = row('d', 'Close', 'Krea 2 Medium (Krea)', '$0.03');
const start = model([hero, alt, wide, close]);
const move = (r: PlaceholderRunRow, price = '$0.06') => ({ ...r, model: 'Grok Imagine 2.0 via xAI', modelKey: 'Grok Imagine 2.0 via xAI', price });
const changedLine = () => document.querySelector('.placeholder-run__changed')?.textContent ?? null;
const live = () => document.querySelector('[aria-live="polite"]')!.textContent?.trim() ?? '';
const dialog = (m: PlaceholderRunConfirm, extra: { changed?: boolean; moved?: string[] } = {}) =>
  <PlaceholderRunDialog model={m} {...extra} onDone={() => {}} />;

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('L-1: the changed line names a node as its row reads now', () => {
  it('a node renamed with its route reads by its new name', () => {
    const before = model([row('g', 'Grok Imagine 2.0 (Krea)', 'Grok Imagine 2.0 (Krea)', 'price not listed')]);
    const now = model([row('g', 'Grok Imagine 2.0 via xAI', 'Grok Imagine 2.0 via xAI', '$0.06')]);
    expect(changedNodesLine(before, now)).toBe('“Grok Imagine 2.0 via xAI” changed while this was open.');
  });

  it('movedRowIds: the rows whose model, setting or price moved, in row order', () => {
    expect(movedRowIds(start, model([hero, move(alt), wide, move(close)]))).toEqual(['b', 'd']);
    expect(movedRowIds(start, start)).toEqual([]);
  });
});

describe('GM round 17 (1): an in-place update names the nodes that moved', () => {
  it('one node: “Alt still” changed while this was open.', () => {
    const view = render(dialog(start));
    expect(changedLine()).toBeNull();
    view.rerender(dialog(model([hero, move(alt), wide, close])));
    expect(changedLine()).toBe('“Alt still” changed while this was open.');
    expect(document.body.textContent).not.toContain('This run changed since you last reviewed it.');
  });

  it('two and three, in row order; four and up, the count', () => {
    const view = render(dialog(start));
    view.rerender(dialog(model([hero, alt, move(wide), close])));
    view.rerender(dialog(model([move(hero), alt, move(wide), close])));
    expect(changedLine()).toBe('“Hero still” and “Wide” changed while this was open.');
    view.rerender(dialog(model([move(hero), move(alt), move(wide), close])));
    expect(changedLine()).toBe('“Hero still”, “Alt still” and “Wide” changed while this was open.');
    view.rerender(dialog(model([move(hero), move(alt), move(wide), move(close)])));
    expect(changedLine()).toBe('4 nodes changed while this was open.');
  });

  it('the line stays, and keeps every node that moved since it opened (one moving back still moved)', () => {
    const view = render(dialog(start));
    view.rerender(dialog(model([hero, move(alt), wide, close])));
    view.rerender(dialog(start));
    expect(changedLine()).toBe('“Alt still” changed while this was open.');
  });

  it('a node joining or leaving adds no changed line: the left line covers it', () => {
    const view = render(dialog(start));
    view.rerender(dialog(model([hero, alt, wide], { leftLine: '1 node Codex was setting up is no longer in this run.' })));
    expect(changedLine()).toBeNull();
    expect(live()).toBe('1 node Codex was setting up is no longer in this run.');
    view.rerender(dialog(model([hero, alt, wide, close, row('e', 'Plate', 'Krea 2 Medium (Krea)', '$0.03')])));
    expect(changedLine()).toBeNull();
  });

  it('a node that moved and then left the run is no longer named', () => {
    const view = render(dialog(start));
    view.rerender(dialog(model([hero, move(alt), wide, close])));
    view.rerender(dialog(model([hero, wide, close], { leftLine: '1 node Codex was setting up is no longer in this run.' })));
    expect(changedLine()).toBeNull();
  });

  it('a screen reader hears the named line at each change', () => {
    const view = render(dialog(start));
    view.rerender(dialog(model([hero, move(alt), wide, close])));
    const first = document.querySelector('[aria-live="polite"]')!.textContent;
    expect(live()).toBe('“Alt still” changed while this was open.');
    view.rerender(dialog(model([hero, move(alt, '$0.09'), wide, close])));
    expect(live()).toBe('“Alt still” changed while this was open.');
    expect(document.querySelector('[aria-live="polite"]')!.textContent).not.toBe(first);
  });

  it('the 500 ms guard holds Run when its price changes in place', () => {
    const answers: boolean[] = [];
    const view = render(<PlaceholderRunDialog model={start} onDone={(ok) => answers.push(ok)} />);
    act(() => { vi.advanceTimersByTime(2_000); });
    const run = document.querySelector<HTMLButtonElement>('.prompt-dialog__confirm')!;
    const pricier = model([hero, move(alt), wide, close], { runLabel: 'Run for $0.15', totalLine: 'This run could cost up to $0.15 at list prices.' });
    view.rerender(<PlaceholderRunDialog model={pricier} onDone={(ok) => answers.push(ok)} />);
    expect(run.textContent).toBe('Run for $0.15');
    fireEvent.click(run);
    act(() => { vi.advanceTimersByTime(499); });
    fireEvent.click(run);
    expect(answers).toEqual([]);
    act(() => { vi.advanceTimersByTime(1); });
    fireEvent.click(run);
    expect(answers).toEqual([true]);
  });
});

describe('the re-ask keeps its line, and an in-place change adds to it', () => {
  it('a re-ask names its moved nodes; one moving in place joins them', () => {
    const asked = model([hero, move(alt), wide, close]);
    const view = render(dialog(asked, { changed: true, moved: ['b'] }));
    expect(changedLine()).toBe('“Alt still” changed while this was open.');
    view.rerender(dialog(model([move(hero), move(alt), wide, close]), { changed: true, moved: ['b'] }));
    expect(changedLine()).toBe('“Hero still” and “Alt still” changed while this was open.');
  });

  it('a re-ask with no moved node keeps the round-5 line', () => {
    render(dialog(start, { changed: true }));
    expect(changedLine()).toBe('This run changed since you last reviewed it.');
  });
});
