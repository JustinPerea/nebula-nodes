import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import type { PlaceholderRunConfirm, PlaceholderRunRow } from '../src/lib/placeholderRunConfirm';

// Review 17: (1) the screen-reader line dropped the "no longer in this run"
// line when a node left and another moved in the same update
// (PlaceholderRunDialog.tsx:137). Decision: announce both lines. (2) Nit:
// on an in-place price change, focus moves to Cancel, matching GM's re-ask
// rule (focus stays on Cancel on any re-ask).

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
const start = model([hero, alt, wide]);
const move = (r: PlaceholderRunRow, price = '$0.06') => ({ ...r, model: 'Grok Imagine 2.0 via xAI', modelKey: 'Grok Imagine 2.0 via xAI', price });
const live = () => document.querySelector('[aria-live="polite"]')!.textContent?.trim() ?? '';
const LEFT = '1 node Codex was setting up is no longer in this run.';
const dialog = (m: PlaceholderRunConfirm) => <PlaceholderRunDialog model={m} onDone={() => {}} />;
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name || b.textContent?.startsWith(name))!;

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('a screen reader hears every line an update brings', () => {
  it('a node leaves and another moves in the same update: both lines', () => {
    const view = render(dialog(start));
    view.rerender(dialog(model([hero, move(alt)], { leftLine: LEFT })));
    expect(live()).toBe(`“Alt still” changed while this was open. ${LEFT}`);
  });
  it('only a node leaving: the left line alone; only a move: the changed line alone', () => {
    const view = render(dialog(start));
    view.rerender(dialog(model([hero, alt], { leftLine: LEFT })));
    expect(live()).toBe(LEFT);
    cleanup();
    const again = render(dialog(start));
    again.rerender(dialog(model([hero, move(alt), wide])));
    expect(live()).toBe('“Alt still” changed while this was open.');
  });
});

describe('focus moves to Cancel when the price changes in place', () => {
  it('Run had focus; the price changes: Cancel has it', () => {
    const view = render(dialog(start));
    act(() => { vi.advanceTimersByTime(2_000); });
    act(() => { button('Run').focus(); });
    expect(document.activeElement).toBe(button('Run'));
    view.rerender(dialog(model([hero, move(alt), wide], { runLabel: 'Run for $0.12', confirmCost: 0.12 })));
    expect(document.activeElement).toBe(button('Cancel'));
  });
  it('a change that leaves the price alone leaves focus where it is', () => {
    const view = render(dialog(start));
    act(() => { button('Run').focus(); });
    view.rerender(dialog(model([hero, { ...alt, setting: 'Variant: Large' }, wide])));
    expect(document.activeElement).toBe(button('Run'));
  });
});
