import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusLine } from '../src/components/commons/CommonsView';
import { clockTime } from '../src/lib/clockTime';
import type { CommonsStatus } from '../src/lib/commonsTypes';

vi.mock('../src/lib/commonsApi', () => ({ commonsApi: {}, commonsEvaluationApi: {}, commonsReviewApi: {}, filtersToRequest: vi.fn() }));
afterEach(() => cleanup());

const RESETS_AT = '2026-09-28T00:00:00Z';
const status = (patch: Partial<CommonsStatus>): CommonsStatus => ({
  worker: { state: 'idle', running: true, budget_used: 0, budget: null },
  meter: { calls: 0, cap: 20, remaining: 20, resets_at: RESETS_AT },
  queue: { queued: 0, analyzing: 0, analysis_failed: 0, held: 0, ready: 0 }, load: 1, load_threshold: 8, ...patch,
});
const stopped = { state: 'stopped', running: false, budget_used: 0, budget: null };
const queue = (queued: number, held: number) => ({ queued, analyzing: 0, analysis_failed: 0, held, ready: 0 });
// The cap's reset time, local time written like "12:00 AM" (design).
const resetTime = clockTime(new Date(RESETS_AT));

function rendered(value: CommonsStatus | null) {
  const { container } = render(<StatusLine status={value} onStart={vi.fn()} onStop={vi.fn()} />);
  const line = container.querySelector('.commons-status')!;
  const label = line.querySelector<HTMLElement>('.commons-status__text')!;
  return { line, label, text: label.textContent ?? '', title: label.getAttribute('title') ?? '' };
}

it('points to closing the agent review when grades exist', () => {
  render(<StatusLine status={status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: true })} onStart={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByText('Paused · close agent review to resume')).toBeTruthy();
});

it('waits for sealed labels on a blind batch', () => {
  render(<StatusLine status={status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false })} onStart={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByText('Paused until labels are sealed')).toBeTruthy();
});

it('shows the normal worker line once the batch is closed', () => {
  render(<StatusLine status={status({ evaluation_waiting: false, evaluation_state: 'closed', evaluation_assisted: true })} onStart={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByText('Idle')).toBeTruthy();
  expect(screen.queryByText(/paused/i)).toBeNull();
});

// Design (after #157): "Keep the worker status to its state plus one
// action, short enough to show whole at 1280 (about 36 characters), with the
// full explanation in the tooltip." Its two exact strings are pinned; every
// other status follows the same rule. The cap is design's own assisted string
// (37 characters, 200.6 px at Inter 400 11px, measured): the room the toolbar
// gives the text is 244-245 px beside Start/Stop and 301 px without (Updates
// chip present, 1280 and 1440, measured live).
const STATE_CAP = 37;
const cases: Array<[string, Partial<CommonsStatus>, string, string | null, RegExp[]]> = [
  ['the sealed-labels pause', { evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false },
    'Paused until labels are sealed', null,
    [/^Library analysis is paused while blind labeling is open/, /reference labels/, /Seal the labels/, /Blind labeling to resume\.$/]],
  ['the agent-review pause', { evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: true },
    'Paused · close agent review to resume', null,
    [/^Library analysis is paused: the agent graded these references before the blind labels were sealed/, /Close them as an assisted review/, /to resume\.$/]],
  // A pause only lifts: a stopped worker still needs Start. Design:
  // "\"Paused\" next to \"Start\" reads as a contradiction, and it hides the
  // state the person has to act on first. When the worker is stopped, start
  // the label with \"Stopped\" and give it the stopped colour." The tooltip
  // says both steps, and Start is there.
  ['the sealed-labels pause with the worker stopped', { evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false, worker: stopped },
    'Stopped · labels not sealed', 'Start',
    [/^Library analysis is paused while blind labeling is open/, /Seal the labels/, /then press Start/, /won’t resume on its own\.$/]],
  ['the agent-review pause with the worker stopped', { evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: true, worker: stopped },
    'Stopped · agent review open', 'Start',
    [/^Library analysis is paused: the agent graded these references/, /Close them as an assisted review/, /then press Start/, /won’t resume on its own\.$/]],
  // Design: "the label names whatever has to be fixed first, and the tooltip lists
  // anything still blocking after that." A used budget needs a restart first.
  ['the sealed-labels pause with the call budget used', { evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false,
    worker: { state: 'budget_exhausted', running: false, budget_used: 40, budget: 40 } },
    'Stopped · call budget used, 40 of 40', null,
    [/^Library analysis is stopped because it used 40 of this run’s 40 calls/,
      /Restart Nebula to reset it\. Analysis then stays paused until the reference labels are sealed\.$/]],
  ['the agent-review pause with the call budget used', { evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: true,
    worker: { state: 'budget_exhausted', running: false, budget_used: 40, budget: 40 } },
    'Stopped · call budget used, 40 of 40', null,
    [/^Library analysis is stopped because it used 40 of this run’s 40 calls/,
      /Restart Nebula to reset it\. Analysis then stays paused until the agent review is closed\.$/]],
  ['a stopped worker', { worker: stopped }, 'Stopped', 'Start',
    [/^Library analysis is stopped\./, /Start runs it/]],
  ['a stopped worker with a queue', { worker: stopped, queue: queue(12, 3) }, 'Stopped · 12 queued · 3 held', 'Start',
    [/^Library analysis is stopped\./, /12 references are waiting to be read/, /3 references added by agents are held until you accept them in the Inbox/, /Start runs it/]],
  ['a busy machine', { worker: { state: 'paused_load', running: true, budget_used: 0, budget: null }, load: 41.5, load_threshold: 32 },
    'Paused · computer busy', 'Stop',
    [/^Library analysis is paused while this computer is busy\./, /Load 41\.5 is above your pause limit of 32 \(“Pause above load”, under Meter in Settings\)\./, /resumes on its own/]],
  ['the daily cap', { worker: { state: 'cap_reached', running: true, budget_used: 0, budget: null },
    meter: { calls: 20, cap: 20, remaining: 0, resets_at: RESETS_AT } },
    'Paused · daily cap', 'Stop',
    [/^Library analysis is paused\. It made 20 analysis calls today, and Settings has “Analysis calls per day” at 20\./, new RegExp(`Resumes at ${resetTime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, when the daily cap resets\\.`)]],
  // Settings takes a cap from 0: a cap of 0 never resets, and a
  // cap lowered below today's calls reports the calls made, not the cap.
  ['a daily cap of 0', { worker: { state: 'cap_reached', running: true, budget_used: 0, budget: null },
    meter: { calls: 0, cap: 0, remaining: 0, resets_at: RESETS_AT } },
    'Paused · daily cap is 0', 'Stop',
    [/^Library analysis is paused\. Settings has “Analysis calls per day” at 0, so it reads nothing\. Raise it to resume\.$/]],
  ['a cap lowered below today\'s calls', { worker: { state: 'cap_reached', running: true, budget_used: 0, budget: null },
    meter: { calls: 25, cap: 10, remaining: 0, resets_at: RESETS_AT } },
    'Paused · daily cap', 'Stop',
    [/It made 25 analysis calls today, and Settings has “Analysis calls per day” at 10\./, /Resumes at /]],
  ['a used budget', { worker: { state: 'budget_exhausted', running: false, budget_used: 40, budget: 40 } },
    'Stopped · call budget used, 40 of 40', null,
    [/^Library analysis is stopped because it used 40 of this run’s 40 calls/, /Restart Nebula to reset it\.$/]],
  ['an analyzing worker', { worker: { state: 'analyzing', running: true, budget_used: 0, budget: null }, queue: queue(12, 0) },
    'Analyzing · 12 queued', 'Stop', [/^Library analysis is reading references: 12 waiting\.$/]],
  ['the last reference in analysis', { worker: { state: 'analyzing', running: true, budget_used: 0, budget: null } },
    'Analyzing', 'Stop', [/^Library analysis is reading references\.$/]],
  ['an idle worker', {}, 'Idle', 'Stop',
    [/^Library analysis is running and has nothing to read\./, /New references are read as they arrive\.$/]],
  ['one held reference', { queue: queue(0, 1) }, 'Idle · 1 held', 'Stop',
    [/1 reference added by an agent is held until you accept it in the Inbox\./]],
];

it.each(cases)('says %s in a short status, with the full explanation as its tooltip', (_, patch, text, control, explains) => {
  const { line, label, title } = rendered(status(patch));
  expect(label, 'the status text has its own element').toBeTruthy();
  expect(label.textContent).toBe(text);
  // The status is its state plus at most one action (the counts are its parts).
  const state = text.replace(/ · \d+ held$/, '');
  expect([...state].length, `"${state}"`).toBeLessThanOrEqual(STATE_CAP);
  expect(text).not.toMatch(/worker|Library analysis/i);
  // The tooltip carries the full explanation: nothing the old wording said is lost.
  expect(title).not.toBe(text);
  for (const pattern of explains) expect(title).toMatch(pattern);
  for (const count of text.match(/\d+(\.\d+)?/g) ?? []) expect(title, `the tooltip names ${count}`).toContain(count);
  expect(label.getAttribute('aria-hidden')).toBeNull();
  expect(screen.getByTitle(title)).toBe(label);
  // Its length in characters caps how much room a short status reserves (commons.css).
  expect(label.style.getPropertyValue('--commons-status-chars')).toBe(String([...text].length));
  // The status is the element's own text, so assistive tech reads it.
  expect(screen.getByText(text)).toBe(label);
  const buttons = [...line.querySelectorAll('button')];
  expect(buttons.map((b) => b.textContent)).toEqual(control ? [control] : []);
  // The control is the text's sibling, never inside the part that truncates.
  for (const button of buttons) {
    expect(label.contains(button)).toBe(false);
    expect(button.parentElement).toBe(line);
  }
});

// The parts (counts, the reset time) make some statuses longer than the state
// alone. Live widths at Inter 400 11px with the Updates chip showing (the
// normal state): the status has 190 px beside Stop or Start and 246 px with no
// control, at both 1280 and 1440. Natural widths of the longest realistic ones
// beside a control: "Paused · computer busy · 99 held" 174.6 px, "Stopped ·
// 9,999 queued · 999 held" 180.9, "Analyzing · 999 queued · 99 held" 171.8,
// "Paused · daily cap · 99 held" 143.3. With no control: "Stopped · call budget
// used, 9,999 of 9,999" 222.7 (the hold branch, no tail). The budget line with
// held adds can run past its room: "... 9,999 of 9,999 · 99 held" is 271.1 and
// "... 999 of 999 · 99 held" 251.9, so they take the ellipsis (below); "... 999
// of 999 · 9 held" is 245.0 and fits. Characters stand in for pixels here
// (jsdom has no layout); the ellipsis stays as the safety net beyond these.
it.each([
  // The busy line keeps its reading in the tooltip, so it is the shortest of these.
  ['beside a control', { worker: { state: 'paused_load', running: true, budget_used: 0, budget: null }, load: 140.2, load_threshold: 128, queue: queue(0, 99) }, 32],
  ['beside a control', { worker: stopped, queue: queue(9999, 999) }, 43],
  ['beside a control', { worker: { state: 'analyzing', running: true, budget_used: 0, budget: null }, queue: queue(999, 99) }, 43],
  ['beside a control', { worker: { state: 'cap_reached', running: true, budget_used: 0, budget: null }, queue: queue(0, 99),
    meter: { calls: 999, cap: 999, remaining: 0, resets_at: '2026-09-28T23:59:00' } }, 28],
  ['with no control', { evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false,
    worker: { state: 'budget_exhausted', running: false, budget_used: 9999, budget: 9999 } }, 42],
] as Array<[string, Partial<CommonsStatus>, number]>)('keeps a long realistic status short enough to show whole %s', (_, patch, cap) => {
  const { text } = rendered(status(patch));
  expect([...text].length, `"${text}"`).toBeLessThanOrEqual(cap);
});

// The budget is set by a developer (NEBULA_COMMONS_CALL_BUDGET), so this line
// may take the ellipsis; the tooltip still carries both numbers and the held count.
it('lets the call-budget worst case with held adds truncate, and keeps its numbers in the title', () => {
  const { text, title } = rendered(status({ worker: { state: 'budget_exhausted', running: false, budget_used: 9999, budget: 9999 }, queue: queue(0, 99) }));
  expect(text).toBe('Stopped · call budget used, 9,999 of 9,999 · 99 held');
  expect(title).toMatch(/used 9,999 of this run’s 9,999 calls/);
  expect(title).toMatch(/99 references added by agents are held/);
});

it('promises nothing it cannot keep: a stopped worker never resumes on its own', () => {
  const sealed = rendered(status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false, worker: stopped }));
  expect(sealed.title).not.toMatch(/to resume\./);
  cleanup();
  const assisted = rendered(status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: true, worker: stopped }));
  expect(assisted.title).not.toMatch(/to resume\./);
  cleanup();
  const zero = rendered(status({ worker: { state: 'cap_reached', running: true, budget_used: 0, budget: null },
    meter: { calls: 0, cap: 0, remaining: 0, resets_at: RESETS_AT } }));
  expect(zero.text).not.toMatch(/until/);
  expect(zero.title).not.toMatch(/on its own|used today's 0/);
});

it('gives a stopped worker the stopped colour even while a pause also holds', () => {
  for (const assisted of [false, true]) {
    const { line } = rendered(status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: assisted, worker: stopped }));
    expect(line.classList.contains('commons-status--stopped')).toBe(true);
    cleanup();
  }
  const budget = rendered(status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false,
    worker: { state: 'budget_exhausted', running: false, budget_used: 40, budget: 40 } }));
  expect(budget.line.classList.contains('commons-status--stopped')).toBe(true);
  cleanup();
  // Running, the pause keeps design's pause strings and no stopped colour.
  const running = rendered(status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false }));
  expect(running.text).toBe('Paused until labels are sealed');
  expect(running.line.classList.contains('commons-status--stopped')).toBe(false);
});

it('starts the worker from the pause line when it is stopped', () => {
  const onStart = vi.fn();
  const { container } = render(<StatusLine status={status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false, worker: stopped })}
    onStart={onStart} onStop={vi.fn()} />);
  container.querySelector<HTMLButtonElement>('.commons-status button')!.click();
  expect(onStart).toHaveBeenCalledTimes(1);
});

it('gives "Connecting…" the same truncating element, with what it waits for as its tooltip', () => {
  const { text, title } = rendered(null);
  expect(text).toBe('Connecting…');
  expect(title).toBe('Connecting to library analysis…');
});
