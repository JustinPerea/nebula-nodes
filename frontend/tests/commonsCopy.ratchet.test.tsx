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
 * 4. Round 18l (review 17, GM r42, r43): the 401 line follows the tab's held state; while the close
 *    is out it is aria-busy and aria-disabled, focusable, its label "Closing…" after 300 ms, Cancel
 *    and Escape aria-disabled; 30 s without an answer re-reads the batch; Escape and Cancel give
 *    focus back to the opener; the parent's busy state is an aria lock with its line; with a lock
 *    line and offline both reasons, the line first, the row once it shows; a retry line goes
 *    offline for good; the grade wait follows the pane's poll and stops offline.
 * Focus here is asserted under tests/helpers/focusFixup (Chrome's focus fixup).
 * The table below is the one GM rules (scratchpad pr204-r18k-strings.md is written from it).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFocusFixup } from './helpers/focusFixup';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineLook, NEUTRAL } from './helpers/lineLook';
import { cascaded } from './helpers/cssCascade';

const api = vi.hoisted(() => ({ close: vi.fn(), get: vi.fn() }));
const reviewApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({ commonsEvaluationApi: api, commonsReviewApi: reviewApi }));

const { CommonsCloseBatch, GRADE_WAIT_MS, CLOSING_LABEL_MS, CLOSE_TIMEOUT_MS, EDITS_LINE_LABELING, EDITS_LINE_REVIEW } = await import('../src/components/commons/CommonsCloseBatch');
const { StudioOfflineRow } = await import('../src/components/StudioOfflineRow');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { CommonsRequestError } = await import('../src/lib/commonsRequestError');
const { copyForStatus, closeBatchFailedLine, closeLineRetries, CLOSE_GRADE_RUNNING, CLOSE_NO_RESPONSE } = await import('../src/lib/errorCopy');
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
  // Tested-only (GM r43 Q5): in the app a 404 "Commons is disabled" switches the Commons to its off
  // view and the dialog unmounts with the pane (tests/presenceRound18l.closeOff), so this line
  // shows only where the dialog renders alone.
  ['Commons off (tested-only)', 404, 'Commons is disabled',
    'Commons is turned off because Nebula started without it. Restart Nebula with NEBULA_COMMONS_ENABLED=1 to close this batch.', 'locked'],
];
/** 401: the Commons API turns every 401 into a refusal for this tab (lib/commonsApi sessionLost).
 * GM r42: the line follows the tab's held state, not the status: a held tab isn't connected as you
 * (it clears on the promote), any other is signed out. Both lock the close. */
const SIGNED_OUT = 'Nebula couldn’t close the batch because you’re signed out. Open the link Nebula printed when it started.';
const HELD = 'Nebula couldn’t close the batch because this tab isn’t connected as you. Open the link Nebula printed when it started.';
export const CLOSE_401_LINES: Array<[string, boolean, string]> = [
  // Tested-only (GM r44 2): in the app a held tab's Commons pane is replaced by its held view, dialog
  // and all, within the hold's 150 ms; the row keeps the string right if that swap ever changes.
  ['401, a held tab (not connected as you; tested-only)', true, HELD],
  ['401, a tab not held (signed out)', false, SIGNED_OUT],
];

/** The two panes' dialogs. */
const PANES = [
  { pane: 'Blind labeling', assisted: false, open: 'Close without sealing…', confirm: 'Close without sealing' },
  { pane: 'Agent review', assisted: true, open: 'Close review & resume library analysis…', confirm: 'Close as assisted review' },
] as const;

/** Let a failure's effects commit under fake timers, then advance. */
const settle = (ms = 10) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** The studio's offline row opens 1 s after Nebula goes offline (StudioOfflineRow), plus a frame. */
const STUDIO_ROW_MS = 1_100;

// Round 18l: Chrome's focus fixup, so focus asserted here is where Chrome would leave it.
const fixup = withFocusFixup();
beforeEach(() => {
  document.body.className = 'app-slava-restraint';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  api.close.mockReset(); api.get.mockReset(); reviewApi.get.mockReset();
});
afterEach(() => {
  cleanup(); resetLinesForTests(); vi.restoreAllMocks(); document.body.className = '';
  act(() => resetBackendConnectionForTests()); resetPersonSessionForTests(); vi.useRealTimers();
});

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
        // The lock rule (GM r41): live only for a line whose step is a retry (closeLineRetries). The
        // "Try again." ending itself is the shared ratchet's (tests/tryAgainLines.ratchet).
        expect(state === 'live', why).toBe(closeLineRetries(line));
        cleanup(); resetLinesForTests();
      }
    });
  }

  it('401: the line follows the held state (GM r42); both lock the close', () => {
    const refusal = new CommonsRequestError('x', 401, { heading: 'Couldn’t close the batch.', code: 'person_required' });
    for (const [why, held, line] of CLOSE_401_LINES) {
      expect(closeBatchFailedLine(refusal, held), why).toBe(line);
      expect(closeBatchFailedLine(failed(401, 'invalid UI session token'), held), why).toBe(line);
    }
    // The default reads the gate's live state.
    expect(closeBatchFailedLine(refusal)).toBe(SIGNED_OUT);
    act(() => reportPersonRequired());
    expect(closeBatchFailedLine(refusal)).toBe(HELD);
  });

  for (const [why, held, line] of CLOSE_401_LINES) {
    it(`${why}: the line, the close locked${held ? ', and live again once the line clears on the promote' : ''}`, async () => {
      if (held) act(() => reportPersonRequired());
      api.close.mockRejectedValue(new CommonsRequestError('x', 401, { heading: 'Couldn’t close the batch.', code: 'person_required' }));
      render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
      fireEvent.click(screen.getByText('Close without sealing…'));
      const close = screen.getByText('Close without sealing');
      close.focus();
      fireEvent.click(close);
      const box = await screen.findByText(line);
      expectState(close, box.closest('[data-commons-line]')!, 'locked', why);
      if (!held) return;
      act(() => notePersonPromoted());
      expect(screen.queryByText(line)).toBeNull();
      expect(close.getAttribute('aria-disabled'), why).toBeNull();
      expect(document.activeElement, why).toBe(close);
    });
  }

  it('NIT-1: an exception from Nebula itself keeps the request line, and goes to the console', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(closeBatchFailedLine(new TypeError('x is undefined'))).toBe('Nebula couldn’t close the batch because the server didn’t accept the request. Try again.');
    expect(error).toHaveBeenCalledTimes(1);
    error.mockClear();
    closeBatchFailedLine(failed(422));
    expect(error).not.toHaveBeenCalled();
  });

  it('N12: the 409 reasons are read only from a 409', () => {
    expect(closeBatchFailedLine(failed(422, 'A grading attempt is still running. Close after it finishes.')))
      .toBe('Nebula couldn’t close the batch because the server didn’t accept the request. Try again.');
  });
});

/** The close button's state beside its line: live, or aria-disabled with the line as its reason,
 * focus kept on it, a press doing nothing; Cancel live either way. */
function expectState(close: HTMLElement, box: Element, state: 'live' | 'locked', why: string) {
  act(() => fixup.current().flush());
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
  // N15: the locked close dims (GM r41: "chrome dims"), by the shared rule.
  expect(cascaded(close).get('|opacity')?.value, why).toBe('var(--sr-disabled-opacity)');
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

  it('offline: no line; the close is aria-disabled, its reason the offline row once that shows (LOW-1); Cancel live', async () => {
    vi.useFakeTimers();
    render(<><StudioOfflineRow /><CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} /></>);
    fireEvent.click(screen.getByText('Close without sealing…'));
    const close = screen.getByText('Close without sealing');
    close.focus();
    act(() => noteBackendConnection('offline'));
    expect(close.getAttribute('aria-disabled')).toBe('true');
    expect(close.hasAttribute('disabled')).toBe(false);
    // The row opens after 1 s: until then the close points at nothing that isn't there.
    expect(close.getAttribute('aria-describedby')).toBeNull();
    await settle(STUDIO_ROW_MS);
    expect(close.getAttribute('aria-describedby')).toBe(STUDIO_OFFLINE_LINE_ID);
    // N14: the row is the element the id names.
    expect(document.getElementById(STUDIO_OFFLINE_LINE_ID)?.closest('.studio-offline-row')).not.toBeNull();
    act(() => fixup.current().flush());
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(api.close).not.toHaveBeenCalled();
    expect(document.querySelector('[data-commons-line]')).toBeNull();
    expect(screen.getByText('Cancel').hasAttribute('disabled')).toBe(false);
    act(() => resetBackendConnectionForTests());
    expect(close.getAttribute('aria-disabled')).toBeNull();
    expect(close.getAttribute('aria-describedby')).toBeNull();
  });

  it('own check (Blind labeling): it stops offline and starts again online (LOW-2)', async () => {
    vi.useFakeTimers();
    reviewApi.get.mockImplementation(async () => ({ items: [{ status: 'running' }] }));
    api.close.mockRejectedValue(failed(409, 'A grading attempt is still running. Close after it finishes.'));
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    fireEvent.click(screen.getByText('Close without sealing'));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(CLOSE_GRADE_RUNNING);
    act(() => noteBackendConnection('offline'));
    await settle(GRADE_WAIT_MS * 3);
    expect(reviewApi.get).not.toHaveBeenCalled();
    // A lock line is still true offline: it stays (GM r43 Q4).
    expect(screen.getByRole('alert').textContent).toBe(CLOSE_GRADE_RUNNING);
    act(() => resetBackendConnectionForTests());
    await settle(GRADE_WAIT_MS);
    expect(reviewApi.get).toHaveBeenCalledTimes(1);
  });

  it('N22: only the grade line waits; another lock line never asks', async () => {
    vi.useFakeTimers();
    api.close.mockRejectedValue(failed(409, "These labels are sealed as blind ground truth, so there's nothing to close."));
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    fireEvent.click(screen.getByText('Close without sealing'));
    await settle();
    await settle(GRADE_WAIT_MS * 3);
    expect(reviewApi.get).not.toHaveBeenCalled();
  });

  it('N5: a check that answers after Cancel never clears the next line', async () => {
    vi.useFakeTimers();
    let answer: (value: unknown) => void = () => {};
    reviewApi.get.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    api.close.mockRejectedValueOnce(failed(409, 'A grading attempt is still running. Close after it finishes.'));
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    fireEvent.click(screen.getByText('Close without sealing'));
    await settle();
    await settle(GRADE_WAIT_MS);
    expect(reviewApi.get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Close without sealing…'));
    api.close.mockRejectedValueOnce(failed(409, "These labels are sealed as blind ground truth, so there's nothing to close."));
    fireEvent.click(screen.getByText('Close without sealing'));
    await settle();
    const sealed = 'Nebula couldn’t close the batch because its labels were already sealed as blind ground truth. Reload to see them.';
    expect(screen.getByRole('alert').textContent).toBe(sealed);
    await act(async () => { answer({ items: [] }); });
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(sealed);
  });
});

describe('the grade wait follows Agent review\'s own poll (GM r43 Q7)', () => {
  it('the line goes on the first poll read after it that sees no grade running; the dialog asks nothing itself', async () => {
    vi.useFakeTimers();
    api.close.mockRejectedValue(failed(409, 'A grading attempt is still running. Close after it finishes.'));
    const view = (running: boolean, reads: number) => <CommonsCloseBatch revision={1} assisted disabled={false}
      gradePoll={{ running, reads }} onClosed={vi.fn()} />;
    const { rerender } = render(view(true, 0));
    fireEvent.click(screen.getByText('Close review & resume library analysis…'));
    const close = screen.getByText('Close as assisted review');
    close.focus();
    fireEvent.click(close);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(CLOSE_GRADE_RUNNING);
    // While the line shows, the dialog asks nothing itself: the pane's poll is the check.
    await settle(GRADE_WAIT_MS * 2);
    expect(reviewApi.get).not.toHaveBeenCalled();
    // No new read yet: what the pane saw before the line doesn't count.
    rerender(view(false, 0));
    expect(screen.getByRole('alert').textContent).toBe(CLOSE_GRADE_RUNNING);
    rerender(view(true, 1));
    expect(screen.getByRole('alert').textContent).toBe(CLOSE_GRADE_RUNNING);
    rerender(view(false, 2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(close.getAttribute('aria-disabled')).toBeNull();
    act(() => fixup.current().flush());
    expect(document.activeElement).toBe(close);
    await settle(GRADE_WAIT_MS * 3);
    expect(reviewApi.get).not.toHaveBeenCalled();
  });
});

describe('while the close is out (review 17 MEDIUM-1, GM r43 Q1)', () => {
  for (const { pane, assisted, open, confirm } of PANES) {
    it(`${pane}: aria-busy and aria-disabled, focusable, focus kept; "Closing…" after 300 ms; Cancel and Escape do nothing`, async () => {
      vi.useFakeTimers();
      let fail: (error: unknown) => void = () => {};
      api.close.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
      render(<CommonsCloseBatch revision={1} assisted={assisted} reviewed={0} total={15} disabled={false} onClosed={vi.fn()} />);
      fireEvent.click(screen.getByText(open));
      const close = screen.getByText(confirm);
      const cancel = screen.getByText('Cancel');
      close.focus();
      fireEvent.click(close);
      await settle();
      expect(close.getAttribute('aria-busy'), pane).toBe('true');
      expect(close.getAttribute('aria-disabled'), pane).toBe('true');
      expect(close.hasAttribute('disabled'), pane).toBe(false);
      expect(cancel.getAttribute('aria-disabled'), pane).toBe('true');
      expect(cancel.hasAttribute('disabled'), pane).toBe(false);
      expect(close.id, pane).not.toBe('');
      expect(cancel.getAttribute('aria-describedby'), pane).toBe(close.id);
      act(() => fixup.current().flush());
      expect(document.activeElement, pane).toBe(close);
      // The label stays for 300 ms.
      await settle(CLOSING_LABEL_MS - 20);
      expect(close.textContent, pane).toBe(confirm);
      await settle(20);
      expect(close.textContent, pane).toBe('Closing…');
      // Presses do nothing: no second close, no Cancel, no Escape.
      fireEvent.click(close);
      expect(api.close, pane).toHaveBeenCalledTimes(1);
      fireEvent.click(cancel);
      fireEvent.keyDown(close, { key: 'Escape' });
      expect(screen.getByRole('alertdialog'), pane).toBeTruthy();
      // The answer: the label back, both live, focus still on the close.
      await act(async () => { fail(failed(503)); });
      await settle();
      expect(close.textContent, pane).toBe(confirm);
      expect(close.getAttribute('aria-busy'), pane).toBeNull();
      expect(close.getAttribute('aria-disabled'), pane).toBeNull();
      expect(cancel.getAttribute('aria-disabled'), pane).toBeNull();
      expect(cancel.getAttribute('aria-describedby'), pane).toBeNull();
      act(() => fixup.current().flush());
      expect(document.activeElement, pane).toBe(close);
    });
  }

  it('an answer inside 300 ms never shows "Closing…"', async () => {
    vi.useFakeTimers();
    let fail: (error: unknown) => void = () => {};
    api.close.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    const close = screen.getByText('Close without sealing');
    fireEvent.click(close);
    await settle(100);
    await act(async () => { fail(failed(503)); });
    await settle(CLOSING_LABEL_MS * 2);
    expect(close.textContent).toBe('Close without sealing');
  });

  const hang = () => api.close.mockImplementation((_revision: number, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  }));

  it('30 s without an answer: the batch read back closed is a success', async () => {
    vi.useFakeTimers();
    hang();
    api.get.mockResolvedValue({ state: 'closed', revision: 2 });
    const onClosed = vi.fn();
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={onClosed} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    fireEvent.click(screen.getByText('Close without sealing'));
    await settle(CLOSE_TIMEOUT_MS - 100);
    expect(api.get).not.toHaveBeenCalled();
    await settle(200);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith({ state: 'closed', revision: 2 });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  for (const [why, read] of [['read back open', async () => ({ state: 'open' })], ['the read failing too', async () => { throw failed(503); }]] as const) {
    it(`30 s without an answer, ${why}: "the server didn’t respond. Try again.", the close and Cancel live`, async () => {
      vi.useFakeTimers();
      hang();
      api.get.mockImplementation(read);
      const onClosed = vi.fn();
      render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={onClosed} />);
      fireEvent.click(screen.getByText('Close without sealing…'));
      const close = screen.getByText('Close without sealing');
      close.focus();
      fireEvent.click(close);
      await settle(CLOSE_TIMEOUT_MS + 100);
      expect(screen.getByRole('alert').textContent).toBe(CLOSE_NO_RESPONSE);
      expect(onClosed).not.toHaveBeenCalled();
      expect(close.getAttribute('aria-disabled')).toBeNull();
      expect(close.getAttribute('aria-busy')).toBeNull();
      expect(screen.getByText('Cancel').getAttribute('aria-disabled')).toBeNull();
      act(() => fixup.current().flush());
      expect(document.activeElement).toBe(close);
    });
  }

  it('the close sends its abort signal, and an answer in time clears the timer', async () => {
    vi.useFakeTimers();
    api.close.mockResolvedValue({ state: 'closed' });
    render(<CommonsCloseBatch revision={7} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    fireEvent.click(screen.getByText('Close without sealing'));
    await settle();
    expect(api.close).toHaveBeenCalledWith(7, expect.any(AbortSignal));
    expect((api.close.mock.calls[0][1] as AbortSignal).aborted).toBe(false);
    await settle(CLOSE_TIMEOUT_MS * 2);
    expect((api.close.mock.calls[0][1] as AbortSignal).aborted).toBe(false);
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('Escape and Cancel (GM r43 Q6, review 17 LOW-4)', () => {
  for (const how of ['Escape', 'Cancel'] as const) {
    it(`${how} closes the dialog with no call, and focus goes back to the opener`, () => {
      render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
      fireEvent.click(screen.getByText('Close without sealing…'));
      expect(document.activeElement?.textContent).toBe('Cancel');
      if (how === 'Escape') fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
      else fireEvent.click(screen.getByText('Cancel'));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(api.close).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByText('Close without sealing…'));
    });
  }

  it('offline, the opener outside the dialog is natively disabled (the dialog\'s close never is)', () => {
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    act(() => noteBackendConnection('offline'));
    expect((screen.getByText('Close without sealing…') as HTMLButtonElement).disabled).toBe(true);
    act(() => resetBackendConnectionForTests());
    expect((screen.getByText('Close without sealing…') as HTMLButtonElement).disabled).toBe(false);
  });

  it('another key does nothing; Escape stops at the dialog', () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} /></div>);
    fireEvent.click(screen.getByText('Close without sealing…'));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Enter' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(outer.mock.calls.filter(([event]) => (event as KeyboardEvent).key === 'Escape')).toEqual([]);
  });

  it('N8: Cancel takes the line with it: reopened, no line and the close live', async () => {
    api.close.mockRejectedValue(failed(409, "These labels are sealed as blind ground truth, so there's nothing to close."));
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    fireEvent.click(screen.getByText('Close without sealing'));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Close without sealing…'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Close without sealing').getAttribute('aria-disabled')).toBeNull();
  });
});

describe('the parent\'s busy state inside the dialog is an aria lock with its line (review 17 MEDIUM-2)', () => {
  const view = (lock: 'grade' | 'edits' | null) => <CommonsCloseBatch revision={1} assisted disabled={false} lock={lock}
    editsLine={EDITS_LINE_REVIEW} onClosed={vi.fn()} />;

  it('Agent review, a grade running: the grade line, the close locked, focusable, focus kept; live again after', () => {
    const { rerender } = render(view(null));
    fireEvent.click(screen.getByText('Close review & resume library analysis…'));
    const close = screen.getByText('Close as assisted review');
    close.focus();
    rerender(view('grade'));
    const box = screen.getByRole('alert');
    expect(box.textContent).toBe(CLOSE_GRADE_RUNNING);
    expectState(close, box, 'locked', 'grade');
    rerender(view(null));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(close.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(close);
  });

  it('unsaved edits inside the dialog (tested-only, GM r44 1: the opener locks first): the pane\'s line, locked, focusable, focus kept', () => {
    const { rerender } = render(view(null));
    fireEvent.click(screen.getByText('Close review & resume library analysis…'));
    const close = screen.getByText('Close as assisted review');
    close.focus();
    rerender(view('edits'));
    const box = screen.getByRole('alert');
    expect(box.textContent).toBe(EDITS_LINE_REVIEW);
    // A lock line, not a failure: neutral.
    expect(box.hasAttribute('data-line-neutral')).toBe(true);
    expect(lineLook(box)).toEqual(NEUTRAL);
    expectState(close, box, 'locked', 'edits');
  });

  it('a retry line gives way to a parent lock (the close can\'t retry), a lock line stays', async () => {
    api.close.mockRejectedValue(failed(503));
    const { rerender } = render(view(null));
    fireEvent.click(screen.getByText('Close review & resume library analysis…'));
    fireEvent.click(screen.getByText('Close as assisted review'));
    await screen.findByRole('alert');
    rerender(view('edits'));
    expect(screen.getByRole('alert').textContent).toBe(EDITS_LINE_REVIEW);
    // Busy (a save or a grade in flight): locked with no line, so the retry line goes too.
    rerender(<CommonsCloseBatch revision={1} assisted disabled lock={null} editsLine={EDITS_LINE_REVIEW} onClosed={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(view('grade'));
    expect(screen.getByRole('alert').textContent).toBe(CLOSE_GRADE_RUNNING);
  });
});

describe('the opener, outside the dialog (GM r44 1)', () => {
  const PANE_LINES = [
    { pane: 'Blind labeling', assisted: false, open: 'Close without sealing…', line: EDITS_LINE_LABELING },
    { pane: 'Agent review', assisted: true, open: 'Close review & resume library analysis…', line: EDITS_LINE_REVIEW },
  ] as const;

  it('the lines, as GM wrote them', () => {
    expect(EDITS_LINE_LABELING).toBe('Save or discard your label changes to close this batch.');
    expect(EDITS_LINE_REVIEW).toBe('Save or discard your corrections to close this batch.');
  });

  for (const { pane, assisted, open, line } of PANE_LINES) {
    it(`${pane}: unsaved edits lock it in place, its line right under it; focusable, presses ignored; live again after`, async () => {
      const { lockPlacementProblems } = await import('../src/lib/lockPlacement');
      const view = (lock: 'edits' | null) => <CommonsCloseBatch revision={1} assisted={assisted} disabled={false} lock={lock}
        editsLine={line} onClosed={vi.fn()} />;
      const { rerender } = render(view(null));
      const opener = screen.getByText(open) as HTMLButtonElement;
      opener.focus();
      rerender(view('edits'));
      act(() => fixup.current().flush());
      expect(opener.disabled, pane).toBe(false);
      expect(opener.getAttribute('aria-disabled'), pane).toBe('true');
      const reason = document.getElementById(opener.getAttribute('aria-describedby')!)!;
      expect(reason.textContent, pane).toBe(line);
      expect(opener.nextElementSibling, pane).toBe(reason);
      expect(lockPlacementProblems(), pane).toEqual([]);
      expect(document.activeElement, pane).toBe(opener);
      expect(cascaded(opener).get('|opacity')?.value, pane).toBe('var(--sr-disabled-opacity)');
      fireEvent.click(opener);
      expect(screen.queryByRole('alertdialog'), pane).toBeNull();
      rerender(view(null));
      expect(opener.getAttribute('aria-disabled'), pane).toBeNull();
      expect(screen.queryByText(line), pane).toBeNull();
      fireEvent.click(opener);
      expect(screen.getByRole('alertdialog'), pane).toBeTruthy();
    });
  }

  it('busy (a save or a grade in flight) or offline: natively disabled for that moment, no line', () => {
    const { rerender } = render(<CommonsCloseBatch revision={1} assisted disabled lock="edits" editsLine={EDITS_LINE_REVIEW} onClosed={vi.fn()} />);
    const opener = screen.getByText('Close review & resume library analysis…') as HTMLButtonElement;
    expect(opener.disabled).toBe(true);
    expect(opener.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByText(EDITS_LINE_REVIEW)).toBeNull();
    rerender(<CommonsCloseBatch revision={1} assisted disabled={false} lock="edits" editsLine={EDITS_LINE_REVIEW} onClosed={vi.fn()} />);
    act(() => noteBackendConnection('offline'));
    expect(opener.disabled).toBe(true);
    expect(screen.queryByText(EDITS_LINE_REVIEW)).toBeNull();
  });
});

describe('every unsaved-edits line is in the house lock form (GM r44 1, r45 Q1)', () => {
  it('"Save or discard your <edits> to <what the control does>.", one sentence with its period', async () => {
    const lines = await import('../src/lib/commonsEditLines');
    expect({ ...lines }).toEqual({
      EDITS_LINE_LABELING: 'Save or discard your label changes to close this batch.',
      EDITS_LINE_REVIEW: 'Save or discard your corrections to close this batch.',
      REVIEW_BATCH_LINE: 'Save or discard your label changes to review the batch.',
      CHANGE_REFERENCE_LINE_LABELING: 'Save or discard your label changes to change the reference.',
      CHANGE_REFERENCE_LINE_REVIEW: 'Save or discard your corrections to change the reference.',
    });
    for (const line of Object.values(lines)) expect(line).toMatch(/^Save or discard your (?:label changes|corrections) to [^.]+\.$/);
  });

  it('the old status line is gone from the app', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
    const src = join(__dirname, '..', 'src');
    expect(files(src).filter((path) => /\.tsx?$/.test(path) && /Save before changing reference/i.test(readFileSync(path, 'utf8')))).toEqual([]);
  });
});

describe('a lock line and offline together (GM r43 Q3, Q4)', () => {
  const SEALED = 'Nebula couldn’t close the batch because its labels were already sealed as blind ground truth. Reload to see them.';
  it('Q3: both reasons, the lock line first, the offline row only once it shows; the line stays through the reconnect', async () => {
    vi.useFakeTimers();
    api.close.mockRejectedValue(failed(409, "These labels are sealed as blind ground truth, so there's nothing to close."));
    render(<><StudioOfflineRow /><CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} /></>);
    fireEvent.click(screen.getByText('Close without sealing…'));
    const close = screen.getByText('Close without sealing');
    close.focus();
    fireEvent.click(close);
    await settle();
    const box = screen.getByRole('alert');
    expect(box.textContent).toBe(SEALED);
    act(() => noteBackendConnection('offline'));
    expect(close.getAttribute('aria-describedby')).toBe(box.id);
    await settle(STUDIO_ROW_MS);
    expect(close.getAttribute('aria-describedby')).toBe(`${box.id} ${STUDIO_OFFLINE_LINE_ID}`);
    for (const id of close.getAttribute('aria-describedby')!.split(' ')) expect(document.getElementById(id), id).not.toBeNull();
    act(() => resetBackendConnectionForTests());
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(SEALED);
    expect(close.getAttribute('aria-describedby')).toBe(box.id);
    expect(close.getAttribute('aria-disabled')).toBe('true');
  });

  it('Q4: a retry line goes offline and stays gone after the reconnect: the close live, no line', async () => {
    vi.useFakeTimers();
    api.close.mockRejectedValue(failed(503));
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    const close = screen.getByText('Close without sealing');
    fireEvent.click(close);
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/Try again\.$/);
    act(() => noteBackendConnection('offline'));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => resetBackendConnectionForTests());
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(close.getAttribute('aria-disabled')).toBeNull();
    expect(close.getAttribute('aria-describedby')).toBeNull();
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
