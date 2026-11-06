/**
 * PR #204 round 18o (GM r51, review 18): the Commons panes' locks and where focus goes.
 * - Q1: offline, Agent review keeps its last read on screen, and an open close dialog stays; the
 *   poll reads again on reconnect and focus stays where it was.
 * - Q2: a running grade locks the opener in place with its own line (commonsCopy.ratchet and
 *   commonsReview cover the component; here, through the pane's poll).
 * - Q3: unsaved edits lock the reference buttons in place, the status line their reason, in both
 *   panes; Generate remaining grades locks with its own line; Download review record stays live.
 * - Q4: Discard hands focus to the reference's heading, Save labels keeps it, Save corrections &
 *   next hands it to the next reference's heading. Focus is asserted under the focus fixup
 *   (tests/helpers/focusFixup), so it is where Chrome would leave it, never <body>.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withFocusFixup } from './helpers/focusFixup';
import { lockPlacementProblems } from '../src/lib/lockPlacement';
import type { ReviewBatch } from '../src/lib/commonsReviewTypes';
import type { EvaluationBatch } from '../src/lib/commonsEvaluationTypes';
import { CommonsRequestError } from '../src/lib/commonsRequestError';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { cascaded } from './helpers/cssCascade';

const api = vi.hoisted(() => ({
  get: vi.fn(), propose: vi.fn(), accept: vi.fn(), image: vi.fn(), close: vi.fn(),
  evalGet: vi.fn(), prepare: vi.fn(), accents: vi.fn(), labels: vi.fn(), seal: vi.fn(),
}));
vi.mock('../src/lib/commonsApi', () => ({
  commonsReviewApi: { get: api.get, propose: api.propose, accept: api.accept },
  commonsEvaluationApi: { get: api.evalGet, image: api.image, close: api.close, prepare: api.prepare, accents: api.accents, labels: api.labels, seal: api.seal },
}));
const { CommonsReview } = await import('../src/components/commons/CommonsReview');
const { CommonsEvaluation } = await import('../src/components/commons/CommonsEvaluation');

const proposal = {
  model: 'fixture-model', prompt_version: 'fixture-prompt',
  labels: { tags: { type_style: 'none' }, axes: { quiet_loud: 0.25 }, palette_roles: { '0': 'accent' }, keywords: [], no_keywords: true, flagged: false },
  fields: { summary: { value: 'An agent proposal', why: 'A visible feature' }, composition_notes: { value: 'Open space', why: 'A margin' },
    type_style: { value: 'none', why: 'No text is visible.' }, axes: { quiet_loud: { value: 0.25, why: 'A bright focal point.' } } },
};
const reviewItem = (position: number) => ({ position, image_sha256: `fixture-${position}`, width: 40, height: 32, status: 'ready', revision: 1,
  palette: [{ index: 0, hex: '#ff0000', share: 1 }], reviewed_labels: null, reviewer: null, reviewed_at: null, error: null,
  proposal: structuredClone(proposal) });
const review = (count = 2): ReviewBatch => ({ mode: 'assisted_review', independent_ground_truth: false, manifest_hash: 'fixture',
  state: 'open', batch_revision: 7, closed_at: null, close_hash: null, model: 'fixture-model', fields: { type_style: ['none', 'serif'] },
  axes: ['quiet_loud'], roles: ['accent'], keywords: ['geometric_type'], call_budget: 0, attempts: 1,
  items: Array.from({ length: count }, (_, n) => reviewItem(n)) } as ReviewBatch);
const evaluation = (): EvaluationBatch => ({ revision: 0, state: 'open', denominator: 150, tuning_count: 30, manifest_hash: 'fixture', sealed: null,
  seal_hash: null, closed: null, close_hash: null, fields: { type_style: ['none'] }, axes: ['quiet_loud'], roles: ['accent'],
  keywords: ['geometric_type'], excluded_count: 0, assisted_reviews: 0,
  items: [0, 1].map((position) => ({ position, image_sha256: `fixture-${position}`, width: 40, height: 32, accent_locked: true, labels: null,
    palette: [{ index: 0, hex: '#ff0000', share: 1 }] })) } as EvaluationBatch);

const fixup = withFocusFixup();
/** Settle focus as Chrome would after a frame. */
const frame = () => act(() => fixup.current().flush());
const focused = () => document.activeElement;
const OPENER = 'Close review & resume library analysis…';

function capturePoll() {
  const timer = vi.spyOn(window, 'setInterval');
  return async () => {
    const callback = timer.mock.calls.find(([, ms]) => ms === 5000)?.[0];
    if (typeof callback !== 'function') throw new Error('Review poll was not registered');
    await act(async () => { callback(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(review()); api.image.mockResolvedValue(new Blob(['fixture'])); api.evalGet.mockResolvedValue(evaluation());
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Image', class { onload?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()); } });
});
afterEach(() => { cleanup(); act(() => resetBackendConnectionForTests()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Q1: offline, Agent review keeps its last read', () => {
  const noAnswer = () => new CommonsRequestError("Nebula's server isn't answering. Make sure it's running, then try again.", 0,
    { heading: 'Couldn’t load Agent review.' });

  it('an answered batch, the poll refused offline: the workspace and the open dialog stay; back online the poll reads again, focus kept', async () => {
    const poll = capturePoll();
    render(<CommonsReview />);
    fireEvent.click(await screen.findByText(OPENER));
    const close = screen.getByText('Close as assisted review');
    act(() => close.focus());
    act(() => noteBackendConnection('offline'));
    api.get.mockRejectedValueOnce(noAnswer());
    await poll();
    frame();
    expect(screen.getByRole('navigation', { name: 'References to review' })).toBeTruthy();
    expect(screen.getByText('0 / 2 reviewed')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(focused()).toBe(close);
    // Back online: the poll reads again; the dialog and focus stay.
    act(() => resetBackendConnectionForTests());
    await poll();
    frame();
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(focused()).toBe(close);
  });

  it('no draft: offline the read stays, the same opener (natively disabled offline with no lock, so CommonsView\'s handover moves focus to the heading and back)', async () => {
    const poll = capturePoll();
    render(<CommonsReview />);
    const opener = await screen.findByText(OPENER) as HTMLButtonElement;
    const reference = screen.getByRole('button', { name: /Reference 02/ });
    act(() => reference.focus());
    act(() => noteBackendConnection('offline'));
    api.get.mockRejectedValueOnce(noAnswer());
    await poll();
    frame();
    expect(screen.getByText('An agent proposal')).toBeTruthy();
    expect(screen.getByText(OPENER)).toBe(opener);
    expect(opener.disabled).toBe(true);
    // A control the outage doesn't disable keeps focus: nothing remounted.
    expect(focused()).toBe(reference);
    act(() => resetBackendConnectionForTests());
    await poll();
    expect(opener.disabled).toBe(false);
    expect(focused()).toBe(reference);
  });

  it('a read that failed just before the app knew it was offline doesn\'t hide the last read once offline', async () => {
    const poll = capturePoll();
    render(<CommonsReview />);
    await screen.findByText('An agent proposal');
    api.get.mockRejectedValueOnce(noAnswer());
    await poll();
    // Online, a failed read shows its line alone (GM r39 Fix B).
    expect(screen.queryByText('An agent proposal')).toBeNull();
    act(() => noteBackendConnection('offline'));
    expect(screen.getByText('An agent proposal')).toBeTruthy();
  });

  it('a reference image that failed to load while offline reads again quietly on reconnect', async () => {
    render(<CommonsReview />);
    await screen.findByText('An agent proposal');
    act(() => noteBackendConnection('offline'));
    api.image.mockRejectedValueOnce(noAnswer());
    // The image loads again (Try again, a remount): it fails offline, and its line hides offline.
    fireEvent.click(screen.getByRole('button', { name: /Reference 02/ }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/couldn’t load this reference/)).toBeNull();
    const before = api.image.mock.calls.length;
    act(() => resetBackendConnectionForTests());
    await waitFor(() => expect(api.image.mock.calls.length).toBe(before + 1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/couldn’t load this reference/)).toBeNull();
  });

  it('online, a failed read still shows only its line (GM r39 Fix B unchanged)', async () => {
    const poll = capturePoll();
    render(<CommonsReview />);
    await screen.findByText('An agent proposal');
    api.get.mockRejectedValueOnce(new CommonsRequestError('Server error', 500, { heading: 'Couldn’t load Agent review.' }));
    await poll();
    expect(screen.queryByRole('navigation', { name: 'References to review' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/^Nebula couldn’t load Agent review because/);
  });
});

describe('Q2: a grade starting and finishing, through the pane\'s poll', () => {
  it('focus on the opener stays as the grade starts (aria lock, its line) and as it finishes (live)', async () => {
    const poll = capturePoll();
    render(<CommonsReview />);
    const opener = await screen.findByText(OPENER) as HTMLButtonElement;
    act(() => opener.focus());
    const running = review(); running.items[1].status = 'running'; running.items[1].proposal = null;
    api.get.mockResolvedValueOnce(running);
    await poll();
    frame();
    expect(opener.disabled).toBe(false);
    expect(opener.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(opener.getAttribute('aria-describedby')!)?.textContent).toBe('You can close this batch when the grade finishes.');
    expect(lockPlacementProblems()).toEqual([]);
    expect(focused()).toBe(opener);
    api.get.mockResolvedValueOnce(review());
    await poll();
    frame();
    expect(opener.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByText('You can close this batch when the grade finishes.')).toBeNull();
    expect(focused()).toBe(opener);
  });
});

async function correct() {
  fireEvent.click(await screen.findByText('Edit grades'));
  fireEvent.change(screen.getByLabelText('type style'), { target: { value: 'serif' } });
}

describe('Q3: what unsaved corrections lock', () => {
  it('Agent review: the reference buttons and Generate lock in place with their reasons; Download stays live', async () => {
    const value = review(); value.call_budget = 15;
    value.items[1].status = 'pending'; value.items[1].proposal = null;
    api.get.mockResolvedValue(value);
    render(<CommonsReview />);
    await correct();
    const reference = screen.getByRole('button', { name: /Reference 02/ }) as HTMLButtonElement;
    act(() => reference.focus());
    frame();
    expect(reference.disabled).toBe(false);
    expect(reference.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(reference.getAttribute('aria-describedby')!)?.textContent).toBe('Save or discard your corrections to change the reference.');
    fireEvent.click(reference);
    expect(screen.getByRole('button', { name: /Reference 01/ }).getAttribute('aria-current')).toBe('true');
    expect(focused()).toBe(reference);
    const generate = screen.getByText('Generate remaining grades') as HTMLButtonElement;
    expect(generate.disabled).toBe(false);
    expect(generate.getAttribute('aria-disabled')).toBe('true');
    const line = document.getElementById(generate.getAttribute('aria-describedby')!)!;
    expect(line.textContent).toBe('Save or discard your corrections to grade the rest.');
    expect(generate.nextElementSibling).toBe(line);
    expect(lockPlacementProblems()).toEqual([]);
    fireEvent.click(generate);
    expect(api.propose).not.toHaveBeenCalled();
    const download = screen.getByText('Download review record') as HTMLButtonElement;
    expect(download.disabled).toBe(false);
    expect(download.getAttribute('aria-disabled')).toBeNull();
    const created = vi.mocked(URL.createObjectURL).mock.calls.length;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(download);
    expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBe(created + 1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('Blind labeling: the reference buttons lock in place, the status line their reason', async () => {
    render(<CommonsEvaluation />);
    fireEvent.click(await screen.findByText('Set neutral'));
    const reference = screen.getByRole('button', { name: /Reference 02/ }) as HTMLButtonElement;
    act(() => reference.focus());
    frame();
    expect(reference.disabled).toBe(false);
    expect(reference.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(reference.getAttribute('aria-describedby')!)?.textContent).toBe('Save or discard your label changes to change the reference.');
    // It dims as a natively disabled reference button does.
    expect(cascaded(reference).get('|opacity')?.value).toBe('.45');
    fireEvent.click(reference);
    expect(screen.getByRole('button', { name: /Reference 01/ }).getAttribute('aria-current')).toBe('true');
    expect(focused()).toBe(reference);
  });
});

/** The heading a pane hands focus to: tabindex -1, so no ring (slava-restraint's code-focus rule). */
function expectHeading(name: string) {
  const heading = focused() as HTMLElement;
  expect(heading.tagName).toBe('H3');
  expect(heading.textContent).toBe(name);
  expect(heading.getAttribute('tabindex')).toBe('-1');
}

describe('Q4: focus after Discard and Save', () => {
  it('Agent review, Discard changes: focus on the current reference\'s heading', async () => {
    render(<CommonsReview />);
    await correct();
    const discard = screen.getByText('Discard changes');
    act(() => discard.focus());
    fireEvent.click(discard);
    frame();
    expectHeading('Reference 01');
  });

  it('Blind labeling, Discard unsaved changes: focus on the current reference\'s heading', async () => {
    render(<CommonsEvaluation />);
    fireEvent.click(await screen.findByText('Set neutral'));
    const discard = screen.getByText('Discard unsaved changes');
    act(() => discard.focus());
    fireEvent.click(discard);
    frame();
    expectHeading('Reference 01');
  });

  it('Agent review, Save corrections & next: aria-busy and focus kept while it saves, then the next reference\'s heading', async () => {
    let finish: (value: ReviewBatch) => void = () => {};
    api.accept.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<CommonsReview />);
    await correct();
    const save = screen.getAllByText('Save corrections & next')[1] as HTMLButtonElement;
    act(() => save.focus());
    fireEvent.click(save);
    frame();
    expect(save.textContent).toBe('Saving…');
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('aria-busy')).toBe('true');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(focused()).toBe(save);
    fireEvent.click(save);
    expect(api.accept).toHaveBeenCalledTimes(1);
    const saved = review(); saved.items[0].reviewed_at = '2026-11-03'; saved.items[0].revision++;
    saved.items[0].reviewed_labels = structuredClone(saved.items[0].proposal!.labels);
    await act(async () => { finish(saved); });
    frame();
    expectHeading('Reference 02');
  });

  it('Agent review, a failed save: focus stays on the button, live again', async () => {
    api.accept.mockRejectedValue(new CommonsRequestError('Labels changed in another window. Reload before saving.', 409));
    render(<CommonsReview />);
    await correct();
    const save = screen.getAllByText('Save corrections & next')[0] as HTMLButtonElement;
    act(() => save.focus());
    fireEvent.click(save);
    await screen.findByRole('alert');
    frame();
    expect(focused()).toBe(save);
    expect(save.getAttribute('aria-disabled')).toBeNull();
  });

  it('Blind labeling, Save labels: outside the disabled fieldset, aria-busy while it saves, focus kept through the save and the remount', async () => {
    let finish: (value: EvaluationBatch) => void = () => {};
    api.labels.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<CommonsEvaluation />);
    fireEvent.click(await screen.findByText('Set neutral'));
    const save = screen.getByText('Save labels') as HTMLButtonElement;
    act(() => save.focus());
    fireEvent.click(save);
    frame();
    expect(save.disabled).toBe(false);
    expect(save.closest('fieldset')).toBeNull();
    expect(document.querySelector('fieldset')?.disabled).toBe(true);
    expect(save.getAttribute('aria-busy')).toBe('true');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(focused()).toBe(save);
    fireEvent.click(save);
    expect(api.labels).toHaveBeenCalledTimes(1);
    const saved = evaluation(); saved.revision = 1;
    await act(async () => { finish(saved); });
    frame();
    const after = screen.getByText('Save labels') as HTMLButtonElement;
    expect(focused()).toBe(after);
    // Nothing left to save: focusable, presses ignored.
    expect(after.disabled).toBe(false);
    expect(after.getAttribute('aria-disabled')).toBe('true');
    expect(after.getAttribute('aria-busy')).toBeNull();
    fireEvent.click(after);
    expect(api.labels).toHaveBeenCalledTimes(1);
  });

  it('Blind labeling, a failed Save labels: focus stays on it, live again; the flag is cleared, so a later remount takes nothing', async () => {
    api.labels.mockRejectedValue(new CommonsRequestError('Labels changed in another window. Reload before saving.', 409));
    render(<CommonsEvaluation />);
    fireEvent.click(await screen.findByText('Set neutral'));
    const save = screen.getByText('Save labels') as HTMLButtonElement;
    act(() => save.focus());
    fireEvent.click(save);
    await screen.findByRole('alert');
    frame();
    expect(focused()).toBe(save);
    expect(save.getAttribute('aria-disabled')).toBeNull();
    // Discard, then the form remounts (the review view and back): Save labels doesn't take focus.
    fireEvent.click(screen.getByText('Discard unsaved changes'));
    frame();
    expectHeading('Reference 01');
    fireEvent.click(screen.getByText('Review batch · 0 / 15'));
    fireEvent.click(screen.getByText('Keep labeling'));
    await waitFor(() => expect(screen.getByText('Save labels')).toBeTruthy());
    frame();
    expect(focused()).not.toBe(screen.getByText('Save labels'));
  });
});
