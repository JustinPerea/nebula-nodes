/**
 * PR #204 round 18j (GM r40): the Commons copy ratchet for the close-batch dialog, in both panes
 * (Blind labeling's "Close without sealing", Agent review's "Close as assisted review"). A failed
 * close destroyed nothing, so its line is a load's shape: the because form with Nebula the
 * subject, curly apostrophes, neutral, never the server's own words. The old shape ("Couldn't
 * close the batch. Nebula didn't respond. Try again.", straight apostrophes, the warning red)
 * can't come back:
 *
 * 1. Every reason a close can get renders, in either pane, as the exact line below, neutral.
 * 2. CommonsCloseBatch words its line only through closeBatchFailedLine (lib/errorCopy), and the
 *    person refusal's through notConnectedBecause: no failureMessage, no heading-and-reason form.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineLook, NEUTRAL } from './helpers/lineLook';

const api = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({ commonsEvaluationApi: api }));

const { CommonsCloseBatch } = await import('../src/components/commons/CommonsCloseBatch');
const { CommonsRequestError } = await import('../src/lib/commonsRequestError');
const { copyForStatus, closeBatchFailedLine, notConnectedBecause } = await import('../src/lib/errorCopy');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');

/** A close's failure as lib/commonsApi throws it: the status and what the backend sent. */
const failed = (status: number, detail?: string) => new CommonsRequestError(
  status === 0 ? "Nebula's server isn't answering. Make sure it's running, then try again." : copyForStatus(status, detail), status,
  { detail, heading: 'Couldn’t close the batch.' });

/** Every close failure, and its line, verbatim (GM r40). */
export const CLOSE_LINES: Array<[string, number, string | undefined, string]> = [
  ['no answer in time (GM r40\'s line)', 503, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.'],
  ['a gateway', 502, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.'],
  ['a gateway timeout', 504, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.'],
  ['a request timeout', 408, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.'],
  ['the server\'s own error', 500, 'Internal Server Error', 'Nebula couldn’t close the batch because the server hit an error. Try again.'],
  ['a rate limit', 429, undefined, 'Nebula couldn’t close the batch because the server is busy. Try again in a moment.'],
  ['no answer at all', 0, undefined, 'Nebula couldn’t close the batch because the server isn’t answering. Check that Nebula is running, then try again.'],
  ['a grade still running', 409, 'A grading attempt is still running. Close after it finishes.',
    'Nebula couldn’t close the batch because a grade is still running. Close the batch again when it finishes.'],
  ['sealed meanwhile', 409, "These labels are sealed as blind ground truth, so there's nothing to close.",
    'Nebula couldn’t close the batch because its labels are sealed as blind ground truth, so there’s nothing to close. Reload to see them.'],
  ['changed in another window', 409, 'Labels changed in another window. Reload before saving.',
    'Nebula couldn’t close the batch because it changed in another window. Reload, then close the batch again.'],
  ['no set anymore', 409, "There's no held-out set yet. Prepare a folder first.",
    'Nebula couldn’t close the batch because there’s no held-out set anymore. Reload to get the latest.'],
  ['the integrity check', 409, "The held-out set doesn't match what was saved, so Nebula stopped and changed nothing.",
    'Nebula couldn’t close the batch because the held-out set doesn’t match what was saved, so Nebula stopped and changed nothing.'],
  ['a reason not listed (its words go to the console)', 409, 'Try again, or reload if it keeps happening.',
    'Nebula couldn’t close the batch because the server didn’t accept it. Try again.'],
  ['a 4xx with no reason', 422, undefined, 'Nebula couldn’t close the batch because the server didn’t accept it. Try again.'],
  ['the window\'s session ended', 401, 'invalid UI session token',
    'Nebula couldn’t close the batch because this window’s session ended. Reload to sign in again.'],
  ['the Commons turned off (the off view takes over)', 404, 'Commons is disabled', 'Commons is turned off for this Nebula.'],
  ['no access', 403, undefined, 'Nebula couldn’t close the batch because you don’t have access to this anymore. Reload to sign in again.'],
];

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
    it(`${pane}: the line shows as listed, neutral, never the old shape`, async () => {
      for (const [why, status, detail, line] of CLOSE_LINES) {
        api.close.mockReset().mockRejectedValue(failed(status, detail));
        render(<CommonsCloseBatch revision={1} assisted={assisted} reviewed={0} total={15} disabled={false} onClosed={vi.fn()} />);
        fireEvent.click(screen.getByText(open));
        fireEvent.click(screen.getByText(confirm));
        const box = await screen.findByRole('alert');
        expect(box.textContent, why).toBe(line);
        expect(box.textContent, why).not.toMatch(/'|^Couldn|Nebula didn/);
        expect(box.hasAttribute('data-line-neutral'), why).toBe(true);
        expect(lineLook(box), why).toEqual(NEUTRAL);
        cleanup(); resetLinesForTests();
      }
    });
  }

  it('a refusal because this tab isn\'t connected as you says that, in the same form', async () => {
    api.close.mockRejectedValue(new CommonsRequestError('x', 401, { heading: 'Couldn’t close the batch.', code: 'person_required' }));
    render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
    fireEvent.click(screen.getByText('Close without sealing…'));
    fireEvent.click(screen.getByText('Close without sealing'));
    expect((await screen.findByRole('status')).textContent).toBe(notConnectedBecause('close the batch'));
  });
});

describe('CommonsCloseBatch words its line only through closeBatchFailedLine', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'components', 'commons', 'CommonsCloseBatch.tsx'), 'utf8');
  it('no failureMessage, and line.show only for the person refusal', () => {
    expect(source).not.toMatch(/failureMessage|copyForStatus/);
    expect(source.match(/line\.show\(/g)).toHaveLength(1);
    expect(source).toContain('if (isPersonRefusal(e)) line.show(e, ');
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
