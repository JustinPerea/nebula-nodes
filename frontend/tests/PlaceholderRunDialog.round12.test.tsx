import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import type { PlaceholderRunConfirm, PlaceholderRunRow } from '../src/lib/placeholderRunConfirm';
import { resolvedStyle } from './helpers/cssCascade';

// GM - Design, round 12 (bug r11-topaz-rows): rows broke in the middle of a
// segment ("Grain model:" / "gaussian", "on your Krea" / "plan"). Each
// segment stays on one line, “Name” included, and a row wraps only between
// segments, at the " · ", with the current indent for its second line. Every
// row in the dialog, every node kind: the agents' rows (with a dot) and the
// muted rows of the run's other paid nodes.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const topaz: PlaceholderRunRow = { nodeId: 't', name: '“Clean plate”', model: 'Topaz Standard (Krea)', modelKey: 'Topaz Standard (Krea)',
  setting: 'Model: not chosen', price: 'on your Krea plan', agent: codex };
const bloom: PlaceholderRunRow = { nodeId: 'b', name: '“Bloom pass”', model: 'Topaz Bloom 2 (Krea)', modelKey: 'Topaz Bloom 2 (Krea)',
  setting: 'Variant: Large · Grain model: gaussian', price: 'on your Krea plan', agent: null };
const model: PlaceholderRunConfirm = {
  heading: 'Run 1 node Codex is still setting up?', intro: "Codex hasn't finished this, so its settings may not be final.",
  savedLine: null, leftLine: null, rows: [topaz, bloom], freeLine: null, totalLine: null, notes: [], costNotes: [],
  runLabel: 'Run', confirmIds: ['t'], confirmCost: null,
};

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('the dialog rows wrap only between segments', () => {
  it('every row, dotted or muted, is made of its whole segments; the text reads as before', () => {
    render(<PlaceholderRunDialog model={model} onDone={() => {}} />);
    const dialog = screen.getByRole('alertdialog');
    const rows = [...dialog.querySelectorAll('.placeholder-run__row')];
    expect(rows.map((row) => row.textContent)).toEqual([
      '“Clean plate” · Topaz Standard (Krea) · Model: not chosen · on your Krea plan',
      '“Bloom pass” · Topaz Bloom 2 (Krea) · Variant: Large · Grain model: gaussian · on your Krea plan',
    ]);
    const segments = rows.map((row) => [...row.querySelectorAll(':scope > .placeholder-run__seg')]
      .map((segment) => segment.textContent));
    // The " ·" stays with the segment before it, so a wrapped line never starts with a dot.
    expect(segments).toEqual([
      ['“Clean plate” ·', 'Topaz Standard (Krea) ·', 'Model: not chosen ·', 'on your Krea plan'],
      ['“Bloom pass” ·', 'Topaz Bloom 2 (Krea) ·', 'Variant: Large ·', 'Grain model: gaussian ·', 'on your Krea plan'],
    ]);
    // The agent's dot is in the first segment, with the name.
    expect(rows[0].querySelector(':scope > .placeholder-run__seg .placeholder-run__dot')).not.toBeNull();
  });

  it('a segment is one unit on the line (inline-block), never indented itself, never wider than the row', () => {
    render(<PlaceholderRunDialog model={model} onDone={() => {}} />);
    const segments = [...document.querySelectorAll('.placeholder-run__row > .placeholder-run__seg:not(.placeholder-run__seg--lead)')];
    expect(segments).toHaveLength(7);
    for (const segment of segments) {
      const style = resolvedStyle(segment);
      expect(style['|display']).toBe('inline-block');
      expect(style['|text-indent']).toBe('0');
      expect(style['|max-width']).toBe('100%');
    }
  });

  it("the first segment of a dotted row keeps the row's hanging indent if a long name wraps", () => {
    render(<PlaceholderRunDialog model={model} onDone={() => {}} />);
    const lead = document.querySelector('.placeholder-run__row:not(.placeholder-run__row--muted) > .placeholder-run__seg--lead')!;
    const style = resolvedStyle(lead);
    expect(style['|display']).toBe('inline-block');
    expect(style['|padding-left']).toBe('16px');
    expect(style['|text-indent']).toBe('-16px');
    const muted = document.querySelector('.placeholder-run__row--muted > .placeholder-run__seg--lead')!;
    expect(resolvedStyle(muted)['|text-indent']).toBe('0');
  });
});
