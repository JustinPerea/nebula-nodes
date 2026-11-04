import { describe, expect, it } from 'vitest';
import { ConnectionLostError, RequestFailedError } from '../../lib/errorCopy';
import { MoodboardVersionConflict } from '../../lib/moodboardEdits';
import type { Moodboard } from '../../types';
import { UNDO_DROPPED_LINE, boardGoneKind, boardSaveCause, boardSaveFailure, boardSaveLine, deletedBoardsLine, restoredBoardsLine, isBoardNotSavedLine,
  changedAfterRemoveLine, isCreateIdRefusal, joinWithAnd, keptFromBoardLine, lostAddLine, lostTooLine, projectDeletedLine, projectGoneLine, projectRestoreFailedLine,
  projectRestoreFailure, projectRestoredLine, changeNotSavedLine } from './boardSaveLine';

const failed = (status: number, options: ConstructorParameters<typeof RequestFailedError>[2] = {}) =>
  new RequestFailedError("Couldn't save the board.", status, { reason: 'x', ...options });
const offline = () => new ConnectionLostError(new TypeError('Failed to fetch'));

// GM r16 (7a, 7b), verbatim.
const LINES = {
  noAnswer: 'Nebula couldn’t save the board because the server isn’t answering. Try again.',
  busy: 'Nebula couldn’t save the board because the server is busy. Try again.',
  noResponse: 'Nebula couldn’t save the board because the server didn’t respond. Try again.',
  serverError: 'Nebula couldn’t save the board because the server hit an error. Try again.',
  diskFull: 'Nebula couldn’t save the board because the disk is full. Free up some space, then try again.',
  tooLarge: 'Nebula couldn’t save the board because it’s too large. Remove some images, then try again.',
  signedOut: 'Nebula couldn’t save the board because you’re signed out. Open the link Nebula printed when it started.',
  changed: 'Nebula couldn’t save the board because it changed somewhere else. Reload to get the latest version.',
  refused: 'Nebula couldn’t save the board because the server didn’t accept this save. Try again.',
};

describe('a board save that failed (GM r16 7a): the because form, ending with the step that works', () => {
  it.each([
    ['no answer', offline(), LINES.noAnswer, 'save'],
    ['a gateway with no backend behind it', failed(502), LINES.noAnswer, 'save'],
    ['429', failed(429), LINES.busy, 'save'],
    ['408', failed(408), LINES.noResponse, 'save'],
    ['503 with words', failed(503, { detail: 'Busy restarting' }), LINES.noResponse, 'save'],
    ['500', failed(500), LINES.serverError, 'save'],
    ['a 507 that is not the disk', failed(507, { detail: 'store unreadable', code: 'project_store' }), LINES.serverError, 'save'],
    ['a full disk', failed(507, { detail: 'No space left on device', storageFull: true, code: 'project_store' }), LINES.diskFull, 'save'],
    ['413', failed(413, { detail: 'Too big', storageLimit: 'storage' }), LINES.tooLarge, 'save'],
    ['403 (the person gate)', failed(403, { detail: 'This tab is not connected as the person.', code: 'person_required' }), LINES.signedOut, 'reload'],
    ['401', failed(401), LINES.signedOut, 'reload'],
    ['a conflict the rebase gave up on', new MoodboardVersionConflict({ version: 3 } as Moodboard), LINES.changed, 'reload'],
    ['a 409 version_conflict with no board', failed(409, { detail: 'Version 2 is behind 3', code: 'version_conflict' }), LINES.changed, 'reload'],
    ['422', failed(422, { detail: 'name must be a string' }), LINES.refused, 'save'],
    ['any other 409', failed(409, { detail: 'locked' }), LINES.refused, 'save'],
    ['an error that is not a request', new Error('anything'), LINES.refused, 'save'],
  ])('%s', (_label, error, reason, retry) => {
    expect(boardSaveLine(error)).toEqual({ failure: { heading: '', reason }, retry });
    expect(boardSaveFailure(error)).toEqual({ heading: '', reason });
    expect(reason.startsWith(`Nebula couldn’t save the board because ${boardSaveCause(error)}. `)).toBe(true);
    // Neutral: nothing is lost.
    expect(isBoardNotSavedLine(boardSaveFailure(error))).toBe(true);
    expect(reason).not.toMatch(/creat/i);
  });

  it('offers Retry exactly where the line says to try again; signed out points to the printed link, as the banner does (GM r17)', () => {
    const errors: Record<keyof typeof LINES, unknown> = { noAnswer: offline(), busy: failed(429), noResponse: failed(408), serverError: failed(500),
      diskFull: failed(507, { storageFull: true }), tooLarge: failed(413), signedOut: failed(403), changed: failed(409, { code: 'version_conflict' }),
      refused: failed(422) };
    for (const [kind, error] of Object.entries(errors)) {
      const line = boardSaveLine(error);
      expect(line.failure.reason).toBe(LINES[kind as keyof typeof LINES]);
      expect(line.retry === 'save').toBe(/[Tt]ry again/.test(line.failure.reason));
    }
    expect(LINES.signedOut).not.toMatch(/Reload/);
  });

  // GM r16: backend wording never reaches the person.
  it('never renders the server\'s own detail or reason, for any status or code (ratchet)', () => {
    const known = new Set([...Object.values(LINES), deletedBoardsLine([''], 'trashed').text, deletedBoardsLine([''], 'purged').text]);
    const codes = [null, 'version_conflict', 'request_id_scope', 'in_trash', 'person_required', 'agent_refused', 'project_store', 'brief_override_protected', 'other'];
    for (let status = 400; status < 600; status += 1) {
      for (const code of codes) {
        for (const storageFull of [false, true]) {
          const error = failed(status, { detail: 'SENTINEL-DETAIL', reason: 'SENTINEL-REASON', code, storageFull });
          const { failure } = boardSaveLine(error);
          expect(JSON.stringify(failure)).not.toMatch(/SENTINEL/);
          expect(known.has(failure.reason)).toBe(true);
          expect(failure.heading).toBe('');
        }
      }
    }
    expect(JSON.stringify(boardSaveLine(new Error('SENTINEL-MESSAGE')))).not.toMatch(/SENTINEL/);
  });
});

// Round 6l (review 10 live MEDIUM-2, GM r21 Q3): a save that finds its board deleted says the deleted-board line,
// never "didn’t accept this save. Try again.", and no Retry (it can't work).
describe('a save that found its board deleted (GM r21 Q3)', () => {
  const TRASHED = 'Nebula couldn’t save your change to “Rivers” because the board was deleted. Restore it to keep the change.';
  const PURGED = 'Nebula couldn’t save your change to “Rivers” because the board was deleted somewhere else.';

  it('in Recently deleted: the r18 line with its Restore step; gone for good: the red line; no Retry either way', () => {
    const inTrash = failed(404, { detail: { code: 'in_trash', trashed: { deletedAt: '2026-11-03T10:00:00Z' } } });
    expect(boardGoneKind(inTrash)).toBe('trashed');
    expect(boardSaveLine(inTrash, 'Rivers')).toEqual({ failure: { heading: '', reason: TRASHED }, retry: 'reload' });
    expect(boardGoneKind(failed(404, { code: 'in_trash' }))).toBe('trashed');
    const purged = failed(404, { detail: 'Moodboard not found' });
    expect(boardGoneKind(purged)).toBe('purged');
    expect(boardSaveLine(purged, 'Rivers')).toEqual({ failure: { heading: '', reason: PURGED }, retry: 'reload' });
    expect(boardSaveFailure(purged, ' Rivers ')).toEqual({ heading: '', reason: PURGED });
    expect(boardSaveCause(inTrash)).toBe('the board was deleted');
    expect(boardSaveCause(purged)).toBe('the board was deleted somewhere else');
    // Neither is a save line ("Not saved" for the trashed one comes from the Studio's gone state).
    expect(isBoardNotSavedLine(boardSaveFailure(inTrash, 'Rivers'))).toBe(false);
  });

  it('no 404, in the trash or gone, ever maps to "refused", whatever its code or words', () => {
    const codes = [null, 'in_trash', 'not_found', 'version_conflict', 'request_id_scope', 'other'];
    const details = [undefined, 'SENTINEL', { code: 'in_trash' }, { code: 'other' }, { code: 'in_trash', trashed: {} }];
    for (const code of codes) {
      for (const detail of details) {
        const error = failed(404, { code, detail });
        const line = boardSaveLine(error, 'Rivers');
        expect(line.failure.reason).not.toBe(LINES.refused);
        expect(line.failure.reason).not.toMatch(/didn’t accept|Try again|SENTINEL/);
        expect(line.retry).toBe('reload');
        expect([TRASHED, PURGED]).toContain(line.failure.reason);
        expect(boardGoneKind(error)).toBe(code === 'in_trash' || (typeof detail === 'object' && detail.code === 'in_trash') ? 'trashed' : 'purged');
      }
    }
    // Only a 404 is a deleted board.
    for (const status of [400, 403, 409, 410, 422, 500]) expect(boardGoneKind(failed(status, { code: 'in_trash' }))).toBeNull();
    expect(boardGoneKind(new Error('in_trash'))).toBeNull();
  });
});

describe('which line is the neutral one (GM r12 1, r16)', () => {
  it('is a board save line only: the lost add and any other line keep the error look', () => {
    expect(isBoardNotSavedLine(boardSaveFailure(failed(403)))).toBe(true);
    expect(isBoardNotSavedLine(lostAddLine(['a.png']))).toBe(false);
    expect(isBoardNotSavedLine({ heading: '', reason: 'Nebula didn’t respond. Try again.' })).toBe(false);
    expect(isBoardNotSavedLine({ heading: "Couldn't save the board.", reason: LINES.busy })).toBe(false);
    expect(isBoardNotSavedLine({ heading: '', reason: '' })).toBe(false);
    expect(isBoardNotSavedLine(LINES.busy)).toBe(false);
    expect(isBoardNotSavedLine(null)).toBe(false);
  });
});

describe('a create refused for its id (round 6g, GM r16 7b)', () => {
  it('says 7(b)\'s neutral line, the 409 for another project\'s id included', () => {
    const refusal = failed(422, { detail: "requestId must be 8 to 128 letters, digits, '-' or '_'" });
    expect(isCreateIdRefusal(refusal)).toBe(true);
    expect(boardSaveLine(refusal)).toEqual({ failure: { heading: '', reason: LINES.refused }, retry: 'save' });
    const scope = failed(409, { detail: 'This request id already made a board in another project (or in Global). Use a new request id for this board.', code: 'request_id_scope' });
    expect(isCreateIdRefusal(scope)).toBe(true);
    expect(boardSaveLine(scope)).toEqual({ failure: { heading: '', reason: LINES.refused }, retry: 'save' });
  });

  it('is only a 422 naming requestId or the 409 with its code', () => {
    expect(isCreateIdRefusal(failed(422, { detail: [{ loc: ['body', 'requestId'], msg: 'bad' }] }))).toBe(true);
    expect(isCreateIdRefusal(failed(422, { detail: 'name must be a string' }))).toBe(false);
    expect(isCreateIdRefusal(failed(400, { detail: 'requestId is wrong' }))).toBe(false);
    expect(isCreateIdRefusal(failed(422, { detail: 'requestIdentity' }))).toBe(false);
    expect(isCreateIdRefusal(new Error('requestId'))).toBe(false);
    expect(isCreateIdRefusal(failed(409, { detail: 'requestId', code: 'version_conflict' }))).toBe(false);
    expect(isCreateIdRefusal(failed(409, { detail: 'locked' }))).toBe(false);
  });
});

describe('joining names (GM r16): "and", no serial comma', () => {
  it('joins 0 to 4', () => {
    expect(joinWithAnd([])).toBe('');
    expect(joinWithAnd(['a'])).toBe('a');
    expect(joinWithAnd(['a', 'b'])).toBe('a and b');
    expect(joinWithAnd(['a', 'b', 'c'])).toBe('a, b and c');
    expect(joinWithAnd(['a', 'b', 'c', 'd'])).toBe('a, b, c and d');
  });
});

describe('the red line for a truly lost add (GM r16 7a)', () => {
  it('names up to three files, then counts them', () => {
    expect(lostAddLine(['river.png'])).toEqual({ heading: '',
      reason: 'Nebula couldn’t add “river.png” because the board hadn’t loaded. Add it again.' });
    expect(lostAddLine(['river.png', 'dune.jpg']).reason)
      .toBe('Nebula couldn’t add “river.png” and “dune.jpg” because the board hadn’t loaded. Add them again.');
    expect(lostAddLine(['a.png', 'b.png', 'c.png']).reason)
      .toBe('Nebula couldn’t add “a.png”, “b.png” and “c.png” because the board hadn’t loaded. Add them again.');
    expect(lostAddLine(['a.png', 'b.png', 'c.png', 'd.png']).reason)
      .toBe('Nebula couldn’t add 4 images because the board hadn’t loaded. Add them again.');
    expect(lostAddLine([]).reason).toBe('Nebula couldn’t add the image because the board hadn’t loaded. Add it again.');
  });
});

describe('a kept edit whose board was deleted (round 6j, GM r18)', () => {
  it('in Recently deleted: one board by name, then up to three joined with "and", then a count', () => {
    expect(deletedBoardsLine(['Rivers'], 'trashed')).toEqual({
      text: 'Nebula couldn’t save your change to “Rivers” because the board was deleted. Restore it to keep the change.', title: '“Rivers”' });
    expect(deletedBoardsLine(['Rivers', 'Dusk'], 'trashed').text)
      .toBe('Nebula couldn’t save your changes to “Rivers” and “Dusk” because they were deleted. Restore them to keep the changes.');
    expect(deletedBoardsLine(['Rivers', 'Dusk', 'Sea'], 'trashed').text)
      .toBe('Nebula couldn’t save your changes to “Rivers”, “Dusk” and “Sea” because they were deleted. Restore them to keep the changes.');
    expect(deletedBoardsLine(['Rivers', 'Dusk', 'Sea', 'Moss'], 'trashed')).toEqual({
      text: 'Nebula couldn’t save your changes to 4 moodboards because they were deleted. Restore them to keep the changes.',
      title: '“Rivers”, “Dusk”, “Sea” and “Moss”' });
  });

  it('gone for good: the same names, deleted somewhere else, with no step', () => {
    expect(deletedBoardsLine(['Rivers'], 'purged').text).toBe('Nebula couldn’t save your change to “Rivers” because the board was deleted somewhere else.');
    expect(deletedBoardsLine(['Rivers', 'Dusk'], 'purged').text)
      .toBe('Nebula couldn’t save your changes to “Rivers” and “Dusk” because they were deleted somewhere else.');
    expect(deletedBoardsLine(['Rivers', 'Dusk', 'Sea'], 'purged').text)
      .toBe('Nebula couldn’t save your changes to “Rivers”, “Dusk” and “Sea” because they were deleted somewhere else.');
    expect(deletedBoardsLine(['a', 'b', 'c', 'd', 'e'], 'purged').text)
      .toBe('Nebula couldn’t save your changes to 5 moodboards because they were deleted somewhere else.');
  });

  it('clips each name past 40 characters with the full names in the title; a blank name is Untitled', () => {
    const long = 'An exceptionally long board name that keeps going well past forty';
    const line = deletedBoardsLine([`  ${long} `, 'Dusk'], 'trashed');
    expect(line.text).toBe(`Nebula couldn’t save your changes to “${long.slice(0, 39)}…” and “Dusk” because they were deleted. Restore them to keep the changes.`);
    expect(line.title).toBe(`“${long}” and “Dusk”`);
    const forty = 'x'.repeat(40);
    expect(deletedBoardsLine([forty], 'purged').text).toBe(`Nebula couldn’t save your change to “${forty}” because the board was deleted somewhere else.`);
    expect(deletedBoardsLine(['  '], 'purged')).toEqual({
      text: 'Nebula couldn’t save your change to “Untitled” because the board was deleted somewhere else.', title: '“Untitled”' });
  });
});

describe('a Restore\'s confirmation (round 6l, GM r20 A, r21 Q6)', () => {
  it('names the boards in two sentences, the second by how many were saved', () => {
    expect(restoredBoardsLine(['Rivers'], 1)).toEqual({ text: 'Restored “Rivers”. Your change is saved.', title: '“Rivers”' });
    expect(restoredBoardsLine(['Rivers', 'Harbor'], 2).text).toBe('Restored “Rivers” and “Harbor”. Your changes are saved.');
    expect(restoredBoardsLine(['Rivers', 'Harbor', 'Sea'], 3).text).toBe('Restored “Rivers”, “Harbor” and “Sea”. Your changes are saved.');
    expect(restoredBoardsLine(['a', 'b', 'c', 'd'], 4)).toEqual({ text: 'Restored 4 moodboards. Your changes are saved.', title: '“a”, “b”, “c” and “d”' });
  });

  it('a plain Restore, or one with nothing left to send, is the first sentence alone', () => {
    expect(restoredBoardsLine(['Rivers'], 0)).toEqual({ text: 'Restored “Rivers”.', title: '“Rivers”' });
    expect(restoredBoardsLine(['Rivers', 'Harbor'], 0).text).toBe('Restored “Rivers” and “Harbor”.');
    // One of two saved: the second sentence counts the saves.
    expect(restoredBoardsLine(['Rivers', 'Harbor'], 1).text).toBe('Restored “Rivers” and “Harbor”. Your change is saved.');
  });

  it('clips past 40 characters with the full names in the title; a blank name is Untitled', () => {
    const long = 'An exceptionally long board name that keeps going well past forty';
    expect(restoredBoardsLine([long], 1)).toEqual({ text: `Restored “${long.slice(0, 39)}…”. Your change is saved.`, title: `“${long}”` });
    expect(restoredBoardsLine([' '], 0).text).toBe('Restored “Untitled”.');
  });
});

describe('kept edits whose boards\' project was deleted (GM r21 Q8; round 6p, GM r90.2)', () => {
  it('one line per project, naming the project and its boards: one, up to three, then a count; the title lists every name', () => {
    expect(projectDeletedLine('Coast', ['Rivers'])).toEqual({ title: '“Rivers” in “Coast”',
      text: 'Nebula couldn’t save your change to “Rivers” because its project “Coast” was deleted. Restore the project to keep the change.' });
    expect(projectDeletedLine('Coast', ['Rivers', 'Tide'])).toEqual({ title: '“Rivers” and “Tide” in “Coast”',
      text: 'Nebula couldn’t save your changes to “Rivers” and “Tide” because their project “Coast” was deleted. Restore the project to keep the changes.' });
    expect(projectDeletedLine('Coast', ['Rivers', 'Tide', 'Harbor']).text).toBe(
      'Nebula couldn’t save your changes to “Rivers”, “Tide” and “Harbor” because their project “Coast” was deleted. Restore the project to keep the changes.');
    expect(projectDeletedLine('Coast', ['Rivers', 'Tide', 'Harbor', 'Quiet'])).toEqual({ title: '“Rivers”, “Tide”, “Harbor” and “Quiet” in “Coast”',
      text: 'Nebula couldn’t save your changes to 4 moodboards because their project “Coast” was deleted. Restore the project to keep the changes.' });
    expect(projectDeletedLine('Coast', ['a', 'b', 'c', 'd', 'e']).text).toContain('your changes to 5 moodboards because their project “Coast”');
    const long = 'An exceptionally long board name that keeps going well past forty';
    expect(projectDeletedLine('Coast', [long]).text).toContain(`“${long.slice(0, 39)}…”`);
    expect(projectDeletedLine('Coast', [long]).title).toBe(`“${long}” in “Coast”`);
    expect(projectDeletedLine(long, ['Rivers']).text).toContain(`its project “${long.slice(0, 39)}…” was deleted`);
  });

  it('deleted for good somewhere else (GM r90.1): red, "couldn’t keep", one, up to three, then a count', () => {
    expect(projectGoneLine('Coast', ['Rivers'])).toEqual({ title: '“Rivers” in “Coast”',
      text: 'Nebula couldn’t keep your change to “Rivers” because its project “Coast” was deleted for good.' });
    expect(projectGoneLine('Coast', ['Rivers', 'Tide'])).toEqual({ title: '“Rivers” and “Tide” in “Coast”',
      text: 'Nebula couldn’t keep your changes to “Rivers” and “Tide” because their project “Coast” was deleted for good.' });
    expect(projectGoneLine('Coast', ['Rivers', 'Tide', 'Harbor']).text).toBe(
      'Nebula couldn’t keep your changes to “Rivers”, “Tide” and “Harbor” because their project “Coast” was deleted for good.');
    expect(projectGoneLine('Coast', ['Rivers', 'Tide', 'Harbor', 'Quiet'])).toEqual({ title: '“Rivers”, “Tide”, “Harbor” and “Quiet” in “Coast”',
      text: 'Nebula couldn’t keep your changes to 4 moodboards because their project “Coast” was deleted for good.' });
  });
});

// Round 6q (GM r95.5): every line that counts boards says "moodboards".
describe('a count of boards says "moodboards" in every line (GM r95.5)', () => {
  const four = ['a', 'b', 'c', 'd'];
  it.each([
    ['the Restore project confirmation', projectRestoredLine('Coast', four).text, 'Restored “Coast”. Your changes to 4 moodboards are saved.'],
    ['the purged-on-Restore line', projectRestoreFailedLine('Coast', 'purged', four).text,
      'Nebula couldn’t restore “Coast” because it was deleted for good. Your changes to 4 moodboards can’t be kept.'],
    ['the project line', projectDeletedLine('Coast', four).text,
      'Nebula couldn’t save your changes to 4 moodboards because their project “Coast” was deleted. Restore the project to keep the changes.'],
    ['the project gone-for-good line', projectGoneLine('Coast', four).text,
      'Nebula couldn’t keep your changes to 4 moodboards because their project “Coast” was deleted for good.'],
    ['the deleted-boards line', deletedBoardsLine(four, 'trashed').text,
      'Nebula couldn’t save your changes to 4 moodboards because they were deleted. Restore them to keep the changes.'],
    ['the deleted-elsewhere line', deletedBoardsLine(four, 'purged').text,
      'Nebula couldn’t save your changes to 4 moodboards because they were deleted somewhere else.'],
    ['the boards Restore confirmation', restoredBoardsLine(four, 4).text, 'Restored 4 moodboards. Your changes are saved.'],
    ['the lost-too sentence', lostTooLine(four)!.text, 'Your unsaved changes to 4 moodboards will be lost too.'],
  ])('%s', (_name, text, expected) => {
    expect(text).toBe(expected);
    expect(text).not.toMatch(/\d boards/);
  });
});

describe('a kept remove the board changed after (GM r90.5)', () => {
  it('names the numbers by the names rule, then counts them; by the agent\'s own label', () => {
    expect(changedAfterRemoveLine([], 'Claude')).toBe('');
    expect(changedAfterRemoveLine([3], 'Claude')).toBe('Claude changed #3 after you removed it, so it’s still on the board.');
    expect(changedAfterRemoveLine([3, 5], 'Claude')).toBe('Claude changed #3 and #5 after you removed them, so they’re still on the board.');
    expect(changedAfterRemoveLine([3, 5, 7], 'Claude')).toBe('Claude changed #3, #5 and #7 after you removed them, so they’re still on the board.');
    expect(changedAfterRemoveLine([1, 3, 5, 7], 'Claude')).toBe('Claude changed 4 images after you removed them, so they’re still on the board.');
    // The agent's label, never a fixed "Claude".
    expect(changedAfterRemoveLine([3], 'Codex')).toBe('Codex changed #3 after you removed it, so it’s still on the board.');
    // Across boards, counted (a number names an image on one board only), and on their boards (round 6q, GM r95.2).
    expect(changedAfterRemoveLine([3, 3], 'Claude', true)).toBe('Claude changed 2 images after you removed them, so they’re still on their boards.');
    expect(changedAfterRemoveLine([1, 2, 3, 4, 5], 'Claude Code', true))
      .toBe('Claude Code changed 5 images after you removed them, so they’re still on their boards.');
    expect(changedAfterRemoveLine([3, 3], null, true)).toBe('2 images changed after you removed them, so they’re still on their boards.');
    expect(changedAfterRemoveLine([3, 5], 'Claude Code', false)).toBe('Claude Code changed #3 and #5 after you removed them, so they’re still on the board.');
    // No one known agent: the image is the subject.
    expect(changedAfterRemoveLine([3], null)).toBe('#3 changed after you removed it, so it’s still on the board.');
    expect(changedAfterRemoveLine([3, 5], ' ')).toBe('#3 and #5 changed after you removed them, so they’re still on the board.');
    expect(changedAfterRemoveLine([1, 2, 3, 4], null)).toBe('4 images changed after you removed them, so they’re still on the board.');
  });

  it('follows the confirmation it joins', () => {
    const stayed = changedAfterRemoveLine([3], 'Claude');
    expect(projectRestoredLine('Coast', ['Rivers'], stayed).text)
      .toBe('Restored “Coast”. Your change to “Rivers” is saved. Claude changed #3 after you removed it, so it’s still on the board.');
    expect(projectRestoredLine('Coast', [], stayed).text).toBe('Restored “Coast”. Claude changed #3 after you removed it, so it’s still on the board.');
    expect(restoredBoardsLine(['Rivers'], 1, stayed).text)
      .toBe('Restored “Rivers”. Your change is saved. Claude changed #3 after you removed it, so it’s still on the board.');
  });
});

// Round 6m (GM r53 Q1): Restore project's failure lines, verbatim, in the because form.
describe('a Restore project that failed (GM r53 Q1)', () => {
  it('the server isn\'t answering, or didn\'t accept it: neutral, ending in Try again', () => {
    expect(projectRestoreFailedLine('Shore', 'noAnswer')).toEqual({ title: '“Shore”',
      text: 'Nebula couldn’t restore “Shore” because the server isn’t answering. Try again.' });
    expect(projectRestoreFailedLine('Shore', 'refused')).toEqual({ title: '“Shore”',
      text: 'Nebula couldn’t restore “Shore” because the server didn’t accept the request. Try again.' });
    // Round 6p (GM r90.3): the connection dropped while it was out.
    expect(projectRestoreFailedLine('Coast', 'lost')).toEqual({ title: '“Coast”',
      text: 'Nebula couldn’t restore “Coast” because it lost the connection. Try again.' });
  });

  it('deleted for good: names the boards whose change can\'t be kept, one, up to three, then a count', () => {
    expect(projectRestoreFailedLine('Shore', 'purged', ['Rivers'])).toEqual({ title: '“Rivers” in “Shore”',
      text: 'Nebula couldn’t restore “Shore” because it was deleted for good. Your change to “Rivers” can’t be kept.' });
    expect(projectRestoreFailedLine('Shore', 'purged', ['Rivers', 'Harbor'])).toEqual({ title: '“Rivers” and “Harbor” in “Shore”',
      text: 'Nebula couldn’t restore “Shore” because it was deleted for good. Your changes to “Rivers” and “Harbor” can’t be kept.' });
    expect(projectRestoreFailedLine('Shore', 'purged', ['Rivers', 'Harbor', 'Tide'])).toEqual({ title: '“Rivers”, “Harbor” and “Tide” in “Shore”',
      text: 'Nebula couldn’t restore “Shore” because it was deleted for good. Your changes to “Rivers”, “Harbor” and “Tide” can’t be kept.' });
    // From 4 boards the line counts; the title still lists every name, with no serial comma (GM r74).
    expect(projectRestoreFailedLine('Shore', 'purged', ['Rivers', 'Tide', 'Harbor', 'Quiet'])).toEqual({
      title: '“Rivers”, “Tide”, “Harbor” and “Quiet” in “Shore”',
      text: 'Nebula couldn’t restore “Shore” because it was deleted for good. Your changes to 4 moodboards can’t be kept.' });
    expect(projectRestoreFailedLine('Shore', 'purged', ['a', 'b', 'c', 'd', 'e'])).toEqual({ title: '“a”, “b”, “c”, “d” and “e” in “Shore”',
      text: 'Nebula couldn’t restore “Shore” because it was deleted for good. Your changes to 5 moodboards can’t be kept.' });
    const long = 'An exceptionally long project name that keeps going past forty';
    expect(projectRestoreFailedLine(long, 'noAnswer').text).toContain(`“${long.slice(0, 39)}…”`);
    expect(projectRestoreFailedLine(long, 'noAnswer').title).toBe(`“${long}”`);
  });

  // Round 6n (GM r71): the success line names the boards as well as the project, by the same names rule.
  // Round 6o (GM r74): its title lists every board, then the project, with no colon.
  it('restored: names the project and the boards whose change is saved, one, up to three, then a count', () => {
    expect(projectRestoredLine('Coast', ['Rivers'])).toEqual({ title: '“Rivers” in “Coast”',
      text: 'Restored “Coast”. Your change to “Rivers” is saved.' });
    expect(projectRestoredLine('Coast', ['Rivers', 'Tide'])).toEqual({ title: '“Rivers” and “Tide” in “Coast”',
      text: 'Restored “Coast”. Your changes to “Rivers” and “Tide” are saved.' });
    expect(projectRestoredLine('Coast', ['Rivers', 'Tide', 'Harbor'])).toEqual({ title: '“Rivers”, “Tide” and “Harbor” in “Coast”',
      text: 'Restored “Coast”. Your changes to “Rivers”, “Tide” and “Harbor” are saved.' });
    // From 4 boards the line counts; the title still lists every name, with no serial comma (GM r74).
    expect(projectRestoredLine('Coast', ['Rivers', 'Tide', 'Harbor', 'Quiet'])).toEqual({ title: '“Rivers”, “Tide”, “Harbor” and “Quiet” in “Coast”',
      text: 'Restored “Coast”. Your changes to 4 moodboards are saved.' });
    expect(projectRestoredLine('Coast', ['a', 'b', 'c', 'd', 'e'])).toEqual({ title: '“a”, “b”, “c”, “d” and “e” in “Coast”',
      text: 'Restored “Coast”. Your changes to 5 moodboards are saved.' });
    // Nothing saved (the boards kept every change): the project alone.
    expect(projectRestoredLine('Coast', [])).toEqual({ title: '“Coast”', text: 'Restored “Coast”.' });
    // Each name clipped as the other lines clip it (the title keeps it whole); a blank one is "Untitled".
    const long = 'An exceptionally long board name that keeps going well past forty';
    expect(projectRestoredLine('Coast', [long])).toEqual({ title: `“${long}” in “Coast”`,
      text: `Restored “Coast”. Your change to “${long.slice(0, 39)}…” is saved.` });
    expect(projectRestoredLine(' ', [' '])).toEqual({ title: '“Untitled” in “Untitled”', text: 'Restored “Untitled”. Your change to “Untitled” is saved.' });
  });

  it('which failure, from the kind and status, never the words', () => {
    expect(projectRestoreFailure(offline())).toBe('noAnswer');
    expect(projectRestoreFailure(failed(502, { detail: '' }))).toBe('noAnswer');
    expect(projectRestoreFailure(failed(503))).toBe('noAnswer');
    for (const status of [400, 403, 422, 500]) expect(projectRestoreFailure(failed(status, { detail: 'isn’t answering' }))).toBe('refused');
    expect(projectRestoreFailure(new Error('Failed to fetch'))).toBe('refused');
  });
});

describe('a Delete forever or Empty that takes kept edits (GM r21 Q2)', () => {
  it('adds one sentence: one, up to three, then a count', () => {
    expect(lostTooLine([])).toBeNull();
    expect(lostTooLine(['Rivers'])).toEqual({ text: 'Your unsaved change to “Rivers” will be lost too.', title: '“Rivers”' });
    expect(lostTooLine(['Rivers', 'Harbor'])?.text).toBe('Your unsaved changes to “Rivers” and “Harbor” will be lost too.');
    expect(lostTooLine(['Rivers', 'Harbor', 'Sea'])?.text).toBe('Your unsaved changes to “Rivers”, “Harbor” and “Sea” will be lost too.');
    expect(lostTooLine(['a', 'b', 'c', 'd'])).toEqual({ text: 'Your unsaved changes to 4 moodboards will be lost too.', title: '“a”, “b”, “c” and “d”' });
  });
});

describe('a dropped Undo (GM r21 Q1)', () => {
  it('has its own neutral line', () => {
    expect(UNDO_DROPPED_LINE).toBe('Nebula couldn’t apply your Undo because the board changed after it.');
  });
});

describe('the "Kept …" line (round 6g, GM r16)', () => {
  it('names up to three fields joined with "and", then counts them', () => {
    expect(keptFromBoardLine([])).toBeNull();
    expect(keptFromBoardLine(['name'], { name: 'Rivers' })).toEqual({ text: 'Kept the name “Rivers” from the board.', title: 'Rivers' });
    expect(keptFromBoardLine(['notes'], { name: 'Rivers' })).toBe('Kept the notes from the board.');
    expect(keptFromBoardLine(['name', 'notes'])).toBe('Kept the name and notes from the board.');
    expect(keptFromBoardLine(['name', 'notes', 'mode'])).toBe('Kept the name, notes and mode from the board.');
    expect(keptFromBoardLine(['name', 'notes', 'mode', 'strength'])).toBe('Kept 4 changes from the board.');
  });

  it('shows only the name\'s value, trimmed, clipped past 40 characters with the full name in the title (GM r17 addendum)', () => {
    const long = 'An exceptionally long board name that keeps going well past forty';
    const line = keptFromBoardLine(['name'], { name: `  ${long} ` }) as { text: string; title: string };
    expect(line.title).toBe(long);
    expect(line.text).toBe(`Kept the name “${long.slice(0, 39)}…” from the board.`);
    const forty = 'x'.repeat(40);
    expect(keptFromBoardLine(['name'], { name: forty })).toEqual({ text: `Kept the name “${forty}” from the board.`, title: forty });
    // No name to show: the field alone. Free text never shows its value.
    expect(keptFromBoardLine(['name'], { name: '  ' })).toBe('Kept the name from the board.');
    for (const field of ['notes', 'briefOverride', 'direction', 'avoid']) {
      expect(typeof keptFromBoardLine([field], { name: 'Rivers', notes: 'secret words' } as { name: string })).toBe('string');
    }
    expect(keptFromBoardLine(['name', 'notes'], { name: 'Rivers' })).toBe('Kept the name and notes from the board.');
  });

  it('names every board field as a noun after its one "the"', () => {
    expect(keptFromBoardLine(['direction', 'avoid', 'pinnedColors'])).toBe('Kept the direction, avoid list and pinned colors from the board.');
    expect(keptFromBoardLine(['briefOverride', 'clashMode', 'colorChoices'])).toBe('Kept the brief, clash setting and color choices from the board.');
    expect(keptFromBoardLine(['sendNotes', 'strength'])).toBe('Kept the notes setting and strength from the board.');
  });

  // Round 6l (GM r21 Q1): kept image changes, one item per image. Round 6m (GM r53): by the label the person sees.
  it('names each image by its visible label, "Reference #N", and joins them with the board fields', () => {
    expect(keptFromBoardLine([], {}, [{ n: 3 }])).toBe('Kept the changes to Reference #3 from the board.');
    expect(keptFromBoardLine(['name'], { name: 'Tide' }, [{ n: 3 }])).toEqual({
      text: 'Kept the name “Tide” and the changes to Reference #3 from the board.', title: 'Tide' });
    expect(keptFromBoardLine(['name', 'notes'], { name: 'Rivers' }, [{ n: 2 }]))
      .toBe('Kept the name, the notes and the changes to Reference #2 from the board.');
    expect(keptFromBoardLine([], {}, [{ n: 1 }, { n: 2 }, { n: 3 }]))
      .toBe('Kept the changes to Reference #1, the changes to Reference #2 and the changes to Reference #3 from the board.');
    expect(keptFromBoardLine(['name'], { name: 'Rivers' }, [{ n: 1 }, { n: 2 }, { n: 3 }])).toBe('Kept 4 changes from the board.');
    expect(keptFromBoardLine([], {}, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }])).toBe('Kept 4 changes from the board.');
  });

  it('the cover is a board item, "the cover"; an image\'s label is never clipped and has no title', () => {
    expect(keptFromBoardLine(['cover'])).toBe('Kept the cover from the board.');
    expect(keptFromBoardLine(['name', 'cover'])).toBe('Kept the name and cover from the board.');
    expect(keptFromBoardLine(['cover'], {}, [{ n: 1 }])).toBe('Kept the cover and the changes to Reference #1 from the board.');
    expect(keptFromBoardLine([], {}, [{ n: 1234 }])).toBe('Kept the changes to Reference #1234 from the board.');
    // A long name keeps its clip and its title (GM r17), beside an image.
    const long = 'A board name for this reference set that keeps going well past forty';
    expect(keptFromBoardLine(['name'], { name: long }, [{ n: 2 }])).toEqual({
      text: `Kept the name “${long.slice(0, 39)}…” and the changes to Reference #2 from the board.`, title: long });
  });

  // GM r53: a private note is the person's own text, and a status line can end up in a screen share.
  it('ratchet: a Kept line never carries anything of an image but its number', () => {
    const shapes = [[], ['name'], ['cover'], ['name', 'notes']] as const;
    for (const fields of shapes) {
      for (const count of [1, 2, 3]) {
        const images = Array.from({ length: count }, (_, index) => ({ n: index + 1, privateNote: 'SENTINEL-NOTE', label: 'SENTINEL-LABEL' }));
        const line = keptFromBoardLine(fields, { name: 'Rivers' }, images);
        expect(JSON.stringify(line)).not.toMatch(/SENTINEL/);
        if (fields.length + count <= 3) expect(typeof line === 'string' ? line : line?.text).toMatch(/Reference #\d/);
      }
    }
  });
});

// #210 round 6t (GM r113 2, verbatim): a replayed kept edit's save that failed on a board the person isn't on, under
// the Restore's confirmation, names the board, from the save line it failed with.
describe('a replayed save that failed elsewhere (GM r113 2)', () => {
  it('names the board in the because form, with the same cause and step: GM\'s string', () => {
    expect(changeNotSavedLine(boardSaveFailure(failed(408)), 'Rivers')).toEqual({
      text: 'Nebula couldn’t save your change to “Rivers” because the server didn’t respond. Try again.', title: '“Rivers”', retry: true });
  });

  it('every save line has its named form, and Try again only where trying again can work', () => {
    const cases: Array<[unknown, string, boolean]> = [
      [offline(), 'the server isn’t answering. Try again.', true],
      [failed(429), 'the server is busy. Try again.', true],
      [failed(500), 'the server hit an error. Try again.', true],
      [failed(507, { storageFull: true }), 'the disk is full. Free up some space, then try again.', true],
      [failed(413), 'it’s too large. Remove some images, then try again.', true],
      [failed(401), 'you’re signed out. Open the link Nebula printed when it started.', false],
      [failed(409, { code: 'version_conflict' }), 'it changed somewhere else. Reload to get the latest version.', false],
      [failed(400), 'the server didn’t accept this save. Try again.', true],
    ];
    for (const [error, tail, retry] of cases) {
      const line = changeNotSavedLine(boardSaveFailure(error, 'Rivers'), 'Rivers');
      expect(line, tail).toEqual({ text: `Nebula couldn’t save your change to “Rivers” because ${tail}`, title: '“Rivers”', retry });
    }
  });

  it('a long name is clipped with the full name in the title; a deleted board or any other line has no named form', () => {
    const long = 'A very long moodboard name that goes on and on past forty';
    expect(changeNotSavedLine(boardSaveFailure(failed(408)), long)?.title).toBe(`“${long}”`);
    expect(changeNotSavedLine(boardSaveFailure(failed(408)), long)?.text).toContain('…”');
    expect(changeNotSavedLine(boardSaveFailure(failed(404, { code: 'in_trash' }), 'Rivers'), 'Rivers')).toBeNull();
    expect(changeNotSavedLine({ heading: "Couldn't save the board.", reason: 'x' }, 'Rivers')).toBeNull();
    expect(changeNotSavedLine('Nebula couldn’t save the board because the server didn’t respond. Try again.', 'Rivers')).toBeNull();
    expect(changeNotSavedLine(null, 'Rivers')).toBeNull();
  });
});
