import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';

// Review 6, M1 (GM - Design's answer: "rows scroll with everything else
// pinned: yes. The scroll area must be reachable by keyboard, and initial
// focus stays on Cancel."), and L-b's line for placeholders that left the run.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };

const model = (rows: number, extra: Partial<PlaceholderRunConfirm> = {}): PlaceholderRunConfirm => ({
  heading: 'Run 30 nodes Codex is still setting up?',
  intro: "Codex hasn't finished these, so their settings may not be final.",
  leftLine: null,
  rows: Array.from({ length: rows }, (_, i) => ({ nodeId: `n${i}`, name: `“Still ${i + 1}”`, model: 'FLUX.2 [pro]', price: '$0.03', agent: codex })),
  freeLine: null,
  totalLine: 'This run could cost up to $0.90 at list prices.',
  notes: [],
  runLabel: 'Run for $0.90',
  confirmIds: [],
  confirmCost: 0.9,
  ...extra,
});

/** jsdom lays nothing out: the rows' box says whether it overflows. */
function rowsOverflow(overflows: boolean) {
  const list = document.querySelector<HTMLElement>('.placeholder-run__rows')!;
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: overflows ? 900 : 200 });
  fireEvent(window, new Event('resize'));
  return list;
}

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('review 6, M1: many rows scroll inside the dialog', () => {
  it('a list that overflows is in the Tab order, and focus still starts on Cancel', () => {
    render(<PlaceholderRunDialog model={model(30)} onDone={() => {}} />);
    const list = rowsOverflow(true);
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(list.tabIndex).toBe(0);
    // Tab from Run wraps to the rows first; Shift+Tab from the rows goes to Run.
    const run = screen.getByRole('button', { name: 'Run for $0.90' });
    run.focus();
    fireEvent.keyDown(run, { key: 'Tab' });
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(run);
  });

  it('a list that fits is not a Tab stop', () => {
    render(<PlaceholderRunDialog model={model(2)} onDone={() => {}} />);
    const list = rowsOverflow(false);
    expect(list.hasAttribute('tabindex')).toBe(false);
  });

  it('the list is named by the heading, so a screen reader landing on it knows what it lists', () => {
    render(<PlaceholderRunDialog model={model(30)} onDone={() => {}} />);
    const list = rowsOverflow(true);
    const heading = screen.getByRole('heading');
    expect(list.getAttribute('aria-labelledby')).toBe(heading.id);
  });

  it('the CSS: the card stays inside the window, the rows scroll, everything else keeps its height', () => {
    const css = readFileSync(join(__dirname, '../src/styles/placeholder-run-dialog.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string) => new RegExp(`(^|\\})\\s*${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[2] ?? '';
    expect(rule('.placeholder-run__card')).toMatch(/max-height:\s*calc\(100(d)?vh - /);
    expect(rule('.placeholder-run__rows')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.placeholder-run__rows')).toMatch(/min-height:\s*0/);
    expect(rule('.placeholder-run__body')).toMatch(/min-height:\s*0/);
  });
});

describe('review 6, L-b: the line for placeholders that left the run', () => {
  it('shows under the intro, before the changed line and the rows', () => {
    render(<PlaceholderRunDialog changed model={model(1, { heading: "Run with Codex's changes?",
      intro: 'Codex finished setting up this node.', leftLine: '1 node Codex was setting up is no longer in this run.' })} onDone={() => {}} />);
    const lines = [...document.querySelectorAll('.placeholder-run__body .prompt-dialog__line')].map((el) => el.textContent);
    expect(lines.slice(0, 3)).toEqual(['Codex finished setting up this node.', '1 node Codex was setting up is no longer in this run.',
      'This run changed since you last reviewed it.']);
  });
});
