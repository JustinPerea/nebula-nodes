import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';

// GM - Design on review 8 L-b: under the still-setting-up heading, the
// "Codex changed…" sentence goes under its body, before the left line and the
// changed line.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const SAVED = 'Codex changed “Hero still” after the run was saved. The replay uses the saved settings.';
const model: PlaceholderRunConfirm = {
  heading: 'Run 1 node Codex is still setting up?', intro: "Codex hasn't finished this, so its settings may not be final.",
  savedLine: SAVED, leftLine: '1 node Codex was setting up is no longer in this run.',
  rows: [{ nodeId: 'q', name: '“Sky”', model: 'FLUX.2 [pro]', price: '$0.03', agent: codex },
    { nodeId: 'h', name: '“Hero still”', model: 'Nano Banana', price: '$0.10', agent: null }], freeLine: null,
  totalLine: 'This run could cost up to $0.13 at list prices.', notes: [], costNotes: [], runLabel: 'Run for $0.13',
  confirmIds: ['q'], confirmCost: 0.13,
};

afterEach(() => { cleanup(); });

describe('the replay sentence in the dialog', () => {
  it('order: body, the replay sentence, the left line, the changed line, then the rows', () => {
    render(<PlaceholderRunDialog model={model} changed onDone={() => {}} />);
    const dialog = screen.getByRole('alertdialog');
    const lines = [...dialog.querySelectorAll('.placeholder-run__body > p, .placeholder-run__body > ul')]
      .map((element) => element.tagName === 'UL' ? 'rows' : element.textContent);
    expect(lines.slice(0, 5)).toEqual([model.intro, SAVED, model.leftLine, 'This run changed since you last reviewed it.', 'rows']);
  });

  it('a change to it alone counts as a change in place: Run is held; no changed line, since no node moved (GM round 17)', () => {
    const answers: boolean[] = [];
    const view = render(<PlaceholderRunDialog model={{ ...model, savedLine: null }} onDone={(ok) => answers.push(ok)} />);
    view.rerender(<PlaceholderRunDialog model={model} onDone={(ok) => answers.push(ok)} />);
    expect(document.querySelector('.placeholder-run__changed')).toBeNull();
    fireEvent.click(screen.getByText('Run for $0.13'));
    expect(answers).toEqual([]);
  });
});
