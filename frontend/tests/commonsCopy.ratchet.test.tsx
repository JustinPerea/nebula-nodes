/**
 * PR #204 round 18j (GM r40): the Commons copy ratchet for the close-batch dialog, in both panes
 * (Blind labeling's "Close without sealing", Agent review's "Close as assisted review"). A failed
 * close destroyed nothing, so its line is a load's shape: the because form with Nebula the
 * subject, curly apostrophes, neutral, never the server's own words. The old shape ("Couldn't
 * close the batch. Nebula didn't respond. Try again.", straight apostrophes, the warning red)
 * can't come back:
 *
 * 1. Every reason a close can get renders, in either pane, as the exact line below, neutral.
 * 2. Round 18k (GM r41): a close line not ending in "Try again." or "Try again in a moment." means
 *    the close control is aria-disabled, the line its aria-describedby, focus kept on it; Cancel
 *    stays live. A grade still running locks it until the grade finishes, then the line clears
 *    itself. Offline: no line, the close aria-disabled with the offline row as its reason.
 * 3. CommonsCloseBatch words its line only through closeBatchFailedLine (lib/errorCopy): no
 *    failureMessage, no heading-and-reason form.
 * The table below is the one GM rules (scratchpad pr204-r18k-strings.md is written from it).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineLook, NEUTRAL } from './helpers/lineLook';

const api = vi.hoisted(() => ({ close: vi.fn() }));
const reviewApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({ commonsEvaluationApi: api, commonsReviewApi: reviewApi }));

const { CommonsCloseBatch, GRADE_WAIT_MS } = await import('../src/components/commons/CommonsCloseBatch');
const { CommonsRequestError } = await import('../src/lib/commonsRequestError');
const { copyForStatus, closeBatchFailedLine, CLOSE_GRADE_RUNNING } = await import('../src/lib/errorCopy');
const { STUDIO_OFFLINE_LINE_ID } = await import('../src/lib/useBackendOffline');
const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');

/** A close's failure as lib/commonsApi throws it: the status and what the backend sent. */
const failed = (status: number, detail?: string) => new CommonsRequestError(
  status === 0 ? "Nebula's server isn't answering. Make sure it's running, then try again." : copyForStatus(status, detail), status,
  { detail, heading: 'Couldn’t close the batch.' });

/** Every close failure: its line, verbatim (GM r41), and whether the close button stays live
 * (GM r41: only a line ending "Try again." or "Try again in a moment." leaves it live). */
export const CLOSE_LINES: Array<[string, number, string | undefined, string, 'live' | 'locked']> = [
  ['503, no answer in time', 503, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.', 'live'],
  ['502, a gateway', 502, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.', 'live'],
  ['504, a gateway timeout', 504, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.', 'live'],
  ['408, a request timeout', 408, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.', 'live'],
  ['500, the server\'s own error', 500, 'Internal Server Error', 'Nebula couldn’t close the batch because the server hit an error. Try again.', 'live'],
  ['501', 501, undefined, 'Nebula couldn’t close the batch because the server hit an error. Try again.', 'live'],
  ['429, a rate limit', 429, undefined, 'Nebula couldn’t close the batch because the server is busy. Try again in a moment.', 'live'],
  ['no answer at all', 0, undefined, 'Nebula couldn’t close the batch because the server isn’t answering. Try again.', 'live'],
  ['409, a grade still running', 409, 'A grading attempt is still running. Close after it finishes.',
    'Nebula couldn’t close the batch because a grade is still running. Close the batch again when it finishes.', 'locked'],
  ['409, sealed meanwhile', 409, "These labels are sealed as blind ground truth, so there's nothing to close.",
    'Nebula couldn’t close the batch because its labels were already sealed as blind ground truth. Reload to see them.', 'locked'],
  ['409, changed somewhere else', 409, 'Labels changed in another window. Reload before saving.',
    'Nebula couldn’t close the batch because it changed somewhere else. Reload, then close the batch again.', 'locked'],
  ['409, no set anymore', 409, "There's no held-out set yet. Prepare a folder first.",
    'Nebula couldn’t close the batch because its held-out set no longer exists. Reload to get the latest references.', 'locked'],
  ['409, the integrity check', 409, "The held-out set doesn't match what was saved, so Nebula stopped and changed nothing.",
    'Nebula couldn’t close the batch because the held-out set doesn’t match what was saved. Nothing was changed. Reload to check it again.', 'locked'],
  ['409, a reason not listed (its words to the console)', 409, 'Try again, or reload if it keeps happening.',
    'Nebula couldn’t close the batch because the server didn’t accept the request. Try again.', 'live'],
  ['422, another 4xx', 422, undefined, 'Nebula couldn’t close the batch because the server didn’t accept the request. Try again.', 'live'],
  ['415, another 4xx', 415, 'Content-Type must be application/json', 'Nebula couldn’t close the batch because the server didn’t accept the request. Try again.', 'live'],
  ['403, a request without the person\'s token (human_dep)', 403, 'only the human UI session can do this',
    'Nebula couldn’t close the batch because this sign-in isn’t allowed to do that. Open the link Nebula printed when it started.', 'locked'],
  ['403, a foreign Origin (local_guard)', 403, 'Origin not allowed',
    'Nebula couldn’t close the batch because this sign-in isn’t allowed to do that. Open the link Nebula printed when it started.', 'locked'],
  ['403, a foreign Host (local_guard)', 403, 'Host not allowed',
    'Nebula couldn’t close the batch because this sign-in isn’t allowed to do that. Open the link Nebula printed when it started.', 'locked'],
  ['Commons off', 404, 'Commons is disabled',
    'Commons is turned off because Nebula started without it. Restart Nebula with NEBULA_COMMONS_ENABLED=1 to close this batch.', 'locked'],
];
/** 401: the Commons API turns every 401 into a refusal for this tab (lib/commonsApi sessionLost). */
const SIGNED_OUT = 'Nebula couldn’t close the batch because you’re signed out. Open the link Nebula printed when it started.';

/** The two panes' dialogs. */
const PANES = [
  { pane: 'Blind labeling', assisted: false, open: 'Close without sealing…', confirm: 'Close without sealing' },
  { pane: 'Agent review', assisted: true, open: 'Close review & resume library analysis…', confirm: 'Close as assisted review' },
] as const;

beforeEach(() => { document.body.className = 'app-slava-restraint'; vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { cleanup(); resetLinesForTests(); vi.restoreAllMocks(); document.body.className = ''; });

describe('a failed close, in either pane: the because form, curly, neutral (GM r40)', () => {
  it('every reason reads as listed', () => {
    for (const [why, status, detail, line] of CLOSE_LINES) expect(closeBatchFailedLine(failed(status, detail)), why).toBe(line);
  });

  for (const { pane, assisted, open, confirm } of PANES) {
    it(`${pane}: the line shows as listed, neutral, never the old shape; a step other than Try again locks the close`, async () => {
      for (const [why, status, detail, line, state] of CLOSE_LINES) {
        api.close.mockReset().mockRejectedValue(failed(status, detail));
        render(<CommonsCloseBatch revision={1} assisted={assisted} reviewed={0} total={15} disabled={false} onClosed={vi.fn()} />);
        fireEvent.click(screen.getByText(open));
        const close = screen.getByText(confirm);
        close.focus();
        fireEvent.click(close);
        const box = await screen.findByRole('alert');
        expect(box.textContent, why).toBe(line);
        expect(box.textContent, why).not.toMatch(/'|^Couldn|Nebula didn/);
        expect(box.hasAttribute('data-line-neutral'), why).toBe(true);
        expect(lineLook(box), why).toEqual(NEUTRAL);
        expectState(close, box, state, why);
        // The ratchet's rule (GM r41): live only for a line ending in a retry.
        expect(state === 'live', why).toBe(/ Try again(?: in a moment)?\.$/.test(line));
        cleanup(); resetLinesForTests();
      }
    });
  }

  it('401: the Commons API makes it a refusal for this tab; the line says signed out and locks the close', async () => {
    expect(closeBatchFailedLine(new CommonsRequestError('x', 401, { heading: 'Couldn’t close the batch.', code: 'person_required' }))).toBe(SIGNED_OUT);
    expect(closeBatchFailedLine(failed(401, 'invalid UI session token'))).toBe(SIGNED_OUT);
    api.close.mockRejectedValue(new CommonsRequestError('x', 401, { heading: 'Couldn’t close the batch.', code: 'person_required' }));
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    const close = screen.getByText('Close without sealing');
    close.focus();
    fireEvent.click(close);
    const box = await screen.findByText(SIGNED_OUT);
    expectState(close, box.closest('[data-commons-line]')!, 'locked', '401');
  });
});

/** The close button's state beside its line: live, or aria-disabled with the line as its reason,
 * focus kept on it, a press doing nothing; Cancel live either way. */
function expectState(close: HTMLElement, box: Element, state: 'live' | 'locked', why: string) {
  expect(document.activeElement, why).toBe(close);
  const cancel = screen.getByText('Cancel');
  expect(cancel.hasAttribute('disabled') || cancel.getAttribute('aria-disabled') === 'true', why).toBe(false);
  if (state === 'live') {
    expect(close.getAttribute('aria-disabled'), why).toBeNull();
    return;
  }
  expect(close.getAttribute('aria-disabled'), why).toBe('true');
  expect(close.hasAttribute('disabled'), why).toBe(false);
  expect(close.getAttribute('aria-describedby'), why).toBe(box.id);
  expect(box.id, why).not.toBe('');
  const calls = api.close.mock.calls.length;
  fireEvent.click(close);
  expect(api.close.mock.calls.length, why).toBe(calls);
}

describe('the close waits for a running grade, and offline (GM r41)', () => {
  it('a grade still running: locked until the grade finishes, then live, the line gone by itself', async () => {
    vi.useFakeTimers();
    try {
      const review = { items: [{ status: 'running' }] };
      reviewApi.get.mockReset().mockImplementation(async () => review);
      api.close.mockReset().mockRejectedValue(failed(409, 'A grading attempt is still running. Close after it finishes.'));
      render(<CommonsCloseBatch revision={1} assisted disabled={false} onClosed={vi.fn()} />);
      fireEvent.click(screen.getByText('Close review & resume library analysis…'));
      const close = screen.getByText('Close as assisted review');
      close.focus();
      fireEvent.click(close);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(screen.getByRole('alert').textContent).toBe(CLOSE_GRADE_RUNNING);
      expect(close.getAttribute('aria-disabled')).toBe('true');
      // Still running at the next check: nothing changes.
      await act(async () => { await vi.advanceTimersByTimeAsync(GRADE_WAIT_MS); });
      expect(reviewApi.get).toHaveBeenCalledTimes(1);
      expect(close.getAttribute('aria-disabled')).toBe('true');
      // Finished: the line goes and the close is live, focus still on it.
      review.items[0].status = 'ready';
      await act(async () => { await vi.advanceTimersByTimeAsync(GRADE_WAIT_MS); });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(close.getAttribute('aria-disabled')).toBeNull();
      expect(document.activeElement).toBe(close);
      // And it asks no more.
      await act(async () => { await vi.advanceTimersByTimeAsync(GRADE_WAIT_MS * 3); });
      expect(reviewApi.get).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('a line that only asks to try again never starts the wait', async () => {
    vi.useFakeTimers();
    try {
      reviewApi.get.mockReset();
      api.close.mockReset().mockRejectedValue(failed(503));
      render(<CommonsCloseBatch revision={1} assisted disabled={false} onClosed={vi.fn()} />);
      fireEvent.click(screen.getByText('Close review & resume library analysis…'));
      fireEvent.click(screen.getByText('Close as assisted review'));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      await act(async () => { await vi.advanceTimersByTimeAsync(GRADE_WAIT_MS * 3); });
      expect(screen.getByRole('alert').textContent).toBe('Nebula couldn’t close the batch because the server didn’t respond. Try again.');
      expect(reviewApi.get).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('offline: no line; the close is aria-disabled with the offline row as its reason, Cancel live', async () => {
    api.close.mockReset();
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    const close = screen.getByText('Close without sealing');
    close.focus();
    act(() => noteBackendConnection('offline'));
    try {
      expect(close.getAttribute('aria-disabled')).toBe('true');
      expect(close.hasAttribute('disabled')).toBe(false);
      expect(close.getAttribute('aria-describedby')).toBe(STUDIO_OFFLINE_LINE_ID);
      expect(document.activeElement).toBe(close);
      fireEvent.click(close);
      expect(api.close).not.toHaveBeenCalled();
      expect(document.querySelector('[data-commons-line]')).toBeNull();
      expect(screen.getByText('Cancel').hasAttribute('disabled')).toBe(false);
    } finally { act(() => resetBackendConnectionForTests()); }
    expect(close.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('CommonsCloseBatch words its line only through closeBatchFailedLine', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'components', 'commons', 'CommonsCloseBatch.tsx'), 'utf8');
  it('no failureMessage or heading form, no line.show', () => {
    expect(source).not.toMatch(/failureMessage|copyForStatus|line\.show\(/);
    expect(source).toContain('line.keep(e, closeBatchFailedLine(e))');
  });
});

describe('the close dialog stacks in either pane (GM r40 1)', () => {
  it('the heading, the list, the line, then one row: Cancel, then the close with its look', async () => {
    const { cascaded } = await import('./helpers/cssCascade');
    for (const { pane, assisted, open, confirm } of PANES) {
      api.close.mockReset().mockRejectedValue(failed(503));
      // Blind labeling's dialog sits among the review's reference rows (.evaluation-review > div).
      render(<div className="commons-view"><section className="commons-evaluation"><div className="evaluation-review">
        <CommonsCloseBatch revision={1} assisted={assisted} reviewed={0} total={15} disabled={false} onClosed={vi.fn()} />
      </div></section></div>);
      fireEvent.click(screen.getByText(open));
      fireEvent.click(screen.getByText(confirm));
      await screen.findByRole('alert');
      const dialog = screen.getByRole('alertdialog');
      expect([...dialog.children].map((el) => el.tagName.toLowerCase() + (el.className ? `.${el.className.split(' ')[0]}` : '')), pane)
        .toEqual(['h3', 'ul', 'p.commons-notice', 'div.review-actions']);
      expect(cascaded(dialog).get('|display')?.value, pane).toBe('block');
      const row = dialog.querySelector('.review-actions')!;
      expect(cascaded(row).get('|display')?.value, pane).toBe('flex');
      expect([...row.querySelectorAll('button')].map((b) => [b.textContent, b.classList.contains('commons-button--primary')]), pane)
        .toEqual([['Cancel', false], [confirm, true]]);
      cleanup(); resetLinesForTests();
    }
  });
});
