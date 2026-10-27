import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import { changedNodesLine, type PlaceholderRunConfirm, type PlaceholderRunRow } from '../src/lib/placeholderRunConfirm';

// GM - Design, round 16 (a), verbatim: "Re-ask after a route change says
// why. One line at the top of the body, above the rows: “Hero still”
// changed while this was open. 2-3 nodes, in row order: “A”, “B” and “C”
// changed while this was open. (“A” and “B” changed while this was open.
// for two). 4 or more: 4 nodes changed while this was open. Name only the
// nodes whose route or price moved. Keep the heading; rows and button show
// the new route and price. Safety: focus stays on Cancel, and the run
// button ignores clicks for the first 500 ms after the re-ask appears."

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const row = (nodeId: string, name: string, modelKey: string, price: string): PlaceholderRunRow =>
  ({ nodeId, name: `“${name}”`, model: modelKey, modelKey, setting: null, price, agent: codex });
const model = (rows: PlaceholderRunRow[]): PlaceholderRunConfirm => ({
  heading: 'Run 1 node Codex is still setting up?',
  intro: "Codex hasn't finished this, so its settings may not be final.",
  savedLine: null,
  leftLine: null,
  rows,
  freeLine: null,
  totalLine: null,
  notes: [],
  costNotes: [],
  runLabel: 'Run',
  confirmIds: rows.map((r) => r.nodeId),
  confirmCost: null,
});

describe('changedNodesLine: the nodes whose route or price moved, by name', () => {
  const before = model([row('a', 'Hero still', 'Grok Imagine 2.0 via xAI', '$0.06'), row('b', 'Alt still', 'Krea 2 Medium (Krea)', '$0.03'),
    row('c', 'Wide', 'Krea 2 Medium (Krea)', '$0.03'), row('d', 'Close', 'Krea 2 Medium (Krea)', '$0.03'), row('e', 'Plate', 'Krea 2 Medium (Krea)', '$0.03')]);
  const moved = (ids: string[]) => model(before.rows.map((r) => ids.includes(r.nodeId)
    ? { ...r, modelKey: 'Grok Imagine 2.0 (Krea)', model: 'Grok Imagine 2.0 (Krea)', price: 'price not listed' } : r));

  it('one node', () => {
    expect(changedNodesLine(before, moved(['a']))).toBe('“Hero still” changed while this was open.');
  });
  it('two nodes', () => {
    expect(changedNodesLine(before, moved(['a', 'c']))).toBe('“Hero still” and “Wide” changed while this was open.');
  });
  it('three nodes, in row order', () => {
    expect(changedNodesLine(before, moved(['c', 'a', 'b']))).toBe('“Hero still”, “Alt still” and “Wide” changed while this was open.');
  });
  it('four or more', () => {
    expect(changedNodesLine(before, moved(['a', 'b', 'c', 'd']))).toBe('4 nodes changed while this was open.');
  });
  it('a price alone moving counts; nothing moved, no line', () => {
    const cheaper = model(before.rows.map((r) => r.nodeId === 'b' ? { ...r, price: '$0.02' } : r));
    expect(changedNodesLine(before, cheaper)).toBe('“Alt still” changed while this was open.');
    expect(changedNodesLine(before, before)).toBeNull();
  });
});

describe('the re-asked dialog after a route change', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ''; });
  const line = '“Hero still” changed while this was open.';
  const shown = model([row('a', 'Hero still', 'Grok Imagine 2.0 (Krea)', 'price not listed')]);

  it('says which node changed in one line at the top of the body, above the rows, keeping the heading', () => {
    render(<PlaceholderRunDialog model={shown} changed moved={['a']} onDone={() => {}} />);
    const body = document.querySelector('.placeholder-run__body')!;
    expect(body.firstElementChild?.textContent).toBe(line);
    expect(screen.getByRole('heading').textContent).toBe(shown.heading);
    expect(screen.queryByText('This run changed since you last reviewed it.')).toBeNull();
  });

  it('focus stays on Cancel, and Run ignores clicks for its first 500 ms', () => {
    const answers: boolean[] = [];
    render(<PlaceholderRunDialog model={shown} changed moved={['a']} onDone={(ok) => answers.push(ok)} />);
    expect(document.activeElement?.textContent).toBe('Cancel');
    const run = document.querySelector<HTMLButtonElement>('.prompt-dialog__confirm')!;
    fireEvent.click(run);
    act(() => { vi.advanceTimersByTime(499); });
    fireEvent.click(run);
    expect(answers).toEqual([]);
    act(() => { vi.advanceTimersByTime(1); });
    fireEvent.click(run);
    expect(answers).toEqual([true]);
  });
});

// Naming the moved nodes when the open dialog updates in place: GM round 17
// (1), PlaceholderRunDialog.round17.
