import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import { askPlaceholderRun } from '../src/components/askPlaceholderRun';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';

// Q133 (Justin, 2026-10-25): the in-app dialog before the person's direct run
// of paid placeholders. GM - Design's copy, verbatim.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const cursor = { id: 'self:cursor', name: 'Cursor', color: '#5B8DEF', verified: false };

const several: PlaceholderRunConfirm = {
  heading: 'Run 3 nodes agents are still setting up?',
  intro: "Agents haven't finished these, so their settings may not be final.",
  rows: [
    { nodeId: 'i', name: '“Hero still”', model: 'FLUX.2 [pro]', price: '$0.06', agent: codex },
    { nodeId: 'j', name: '“Alt still”', model: 'FLUX.2 [pro]', price: '$0.06', agent: cursor },
  ],
  freeLine: 'Plus 1 free node.',
  totalLine: 'This run could cost up to $0.12 at list prices.',
  notes: [],
  runLabel: 'Run for $0.12',
  confirmIds: ['i', 'j'],
};

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('PlaceholderRunDialog', () => {
  it("draws GM's copy: heading, intro, a row per paid placeholder with its agent's dot or ring, the free line, the total, the buttons", () => {
    render(<PlaceholderRunDialog model={several} onDone={() => {}} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Run 3 nodes agents are still setting up?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain("Agents haven't finished these, so their settings may not be final.");
    const rows = [...dialog.querySelectorAll('.placeholder-run__row')];
    expect(rows.map((row) => row.textContent)).toEqual(['“Hero still” · FLUX.2 [pro] · $0.06', '“Alt still” · FLUX.2 [pro] · $0.06']);
    const dots = rows.map((row) => row.querySelector('.placeholder-run__dot')!);
    expect(dots.map((dot) => dot.getAttribute('data-verified'))).toEqual(['true', 'false']);
    expect(dots.every((dot) => dot.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(dialog.textContent).toContain('Plus 1 free node.');
    expect(dialog.textContent).toContain('This run could cost up to $0.12 at list prices.');
    const buttons = [...dialog.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toEqual(['Cancel', 'Run for $0.12']);
    // Focus starts on Cancel: Enter never spends by accident.
    expect(document.activeElement?.textContent).toBe('Cancel');
  });

  it('Cancel and Escape say no; Run says yes', () => {
    const answers: boolean[] = [];
    render(<PlaceholderRunDialog model={several} onDone={(ok) => answers.push(ok)} />);
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    fireEvent.click(screen.getByText('Run for $0.12'));
    expect(answers).toEqual([false, false, true]);
  });

  it('askPlaceholderRun resolves with the answer and takes the dialog away', async () => {
    let answer: Promise<boolean> | undefined;
    await act(async () => { answer = askPlaceholderRun(several); });
    expect(document.querySelector('.placeholder-run')).not.toBeNull();
    await act(async () => { fireEvent.click(screen.getByText('Cancel')); });
    await expect(answer).resolves.toBe(false);
    expect(document.querySelector('.placeholder-run')).toBeNull();
  });
});
