import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusLine } from '../src/components/commons/CommonsView';
import type { CommonsStatus } from '../src/lib/commonsTypes';

vi.mock('../src/lib/commonsApi', () => ({ commonsApi: {}, commonsEvaluationApi: {}, commonsReviewApi: {}, filtersToRequest: vi.fn() }));
afterEach(() => cleanup());

const status = (patch: Partial<CommonsStatus>): CommonsStatus => ({
  worker: { state: 'idle', running: true, budget_used: 0, budget: null },
  meter: { calls: 0, cap: 20, remaining: 20, resets_at: '2026-09-28T00:00:00Z' },
  queue: { queued: 0, analyzing: 0, analysis_failed: 0, held: 0, ready: 0 }, load: 1, load_threshold: 8, ...patch,
});

it('points to closing the agent review when grades exist', () => {
  render(<StatusLine status={status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: true })} onStart={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByText('Library analysis paused · close the agent review to resume')).toBeTruthy();
});

it('waits for sealed labels on a blind batch', () => {
  render(<StatusLine status={status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false })} onStart={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByText('Library analysis paused until reference labels are sealed')).toBeTruthy();
});

it('shows the normal worker line once the batch is closed', () => {
  render(<StatusLine status={status({ evaluation_waiting: false, evaluation_state: 'closed', evaluation_assisted: true })} onStart={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByText(/Worker idle/)).toBeTruthy();
  expect(screen.queryByText(/paused/)).toBeNull();
});

// p157c (GM: a header that wraps to two rows is a defect). The worker status
// is the one toolbar item whose length the person doesn't control: "Library
// analysis paused until reference labels are sealed" wrapped the Commons
// header to 86 px at 1280-1440. The text now gives way first: it truncates on
// one line (commons.css), its control stays whole beside it, and the full
// status stays in the DOM text (what a screen reader reads) and the title
// (the tooltip). jsdom has no layout; the live check measures the widths.
const LONG_SEALED = 'Library analysis paused until reference labels are sealed';
const LONG_ASSISTED = 'Library analysis paused · close the agent review to resume';
const cases: Array<[string, Partial<CommonsStatus>, string, string | null]> = [
  ['the sealed-labels pause', { evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false }, LONG_SEALED, null],
  ['the agent-review pause', { evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: true }, LONG_ASSISTED, null],
  ['a stopped worker with a queue', { worker: { state: 'stopped', running: false, budget_used: 0, budget: null },
    queue: { queued: 12, analyzing: 0, analysis_failed: 0, held: 3, ready: 0 } }, 'Worker stopped · 12 queued · 3 held', 'Start'],
  ['a busy machine', { worker: { state: 'paused_load', running: true, budget_used: 0, budget: null }, load: 41.5, load_threshold: 32 },
    'Paused: machine busy (load 41.5 / 32)', 'Stop'],
  ['a used budget', { worker: { state: 'budget_exhausted', running: true, budget_used: 40, budget: 40 } }, 'Call budget used (40/40)', 'Stop'],
  ['an idle worker', {}, 'Worker idle', 'Stop'],
];

it.each(cases)('keeps the text of %s in its own truncating element, with the whole status as its title', (_, patch, text, control) => {
  const { container } = render(<StatusLine status={status(patch)} onStart={vi.fn()} onStop={vi.fn()} />);
  const line = container.querySelector('.commons-status')!;
  const label = line.querySelector('.commons-status__text')!;
  expect(label, 'the status text has its own element').toBeTruthy();
  expect(label.textContent).toBe(text);
  expect(label.getAttribute('title')).toBe(text);
  expect(label.getAttribute('aria-hidden')).toBeNull();
  expect(screen.getByTitle(text)).toBe(label);
  // Its length in characters caps how much room a short status reserves (commons.css).
  expect((label as HTMLElement).style.getPropertyValue('--commons-status-chars')).toBe(String([...text].length));
  // The whole status is the element's own text, so assistive tech reads all of it.
  expect(screen.getByText(text)).toBe(label);
  const buttons = [...line.querySelectorAll('button')];
  expect(buttons.map((b) => b.textContent)).toEqual(control ? [control] : []);
  // The control is the text's sibling, never inside the part that truncates.
  for (const button of buttons) {
    expect(label.contains(button)).toBe(false);
    expect(button.parentElement).toBe(line);
  }
});

it('gives "Connecting…" the same truncating element', () => {
  const { container } = render(<StatusLine status={null} onStart={vi.fn()} onStop={vi.fn()} />);
  const label = container.querySelector('.commons-status .commons-status__text')!;
  expect(label.textContent).toBe('Connecting…');
  expect(label.getAttribute('title')).toBe('Connecting…');
});
