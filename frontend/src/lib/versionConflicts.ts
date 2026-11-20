import type { Character, Moodboard } from '../types';
import { RequestFailedError } from './errorCopy';

/**
 * The two 409 errors the API client throws (lib/api.ts). They sit apart from
 * the edit helpers (lib/moodboardEdits.ts, lib/characterEdits.ts, which
 * re-export them) so the startup set carries the classes, not the Studios'
 * rebase code.
 */

/** A write sent with `baseVersion` after someone else saved the board (409).
 *  `board` is the board as it is now, to rebase on. The Studio rebases and
 *  sends again; after three in a row its notice says this (GM, error-copy
 *  round 2: "Couldn’t save the board. This board changed in another window.
 *  Reload to get the latest version."), with no version number. The version
 *  stays on the error (`detail`) for debugging. */
export class MoodboardVersionConflict extends RequestFailedError {
  readonly board: Moodboard;

  constructor(board: Moodboard) {
    super("Couldn’t save the moodboard.", 409, { reason: 'This moodboard changed in another tab. Reload to get the latest version.',
      detail: { code: 'version_conflict', version: board.version } });
    this.name = 'MoodboardVersionConflict';
    this.board = board;
  }
}

/** A PUT sent with `baseVersion` after someone else saved the Character
 *  (409). `character` is the Character as it is now, to rebase on. */
export class CharacterVersionConflict extends RequestFailedError {
  readonly character: Character;

  /** After three in a row the Studio's notice says this, as the board's does
   * (GM, error-copy round 2); the version stays in `detail`. */
  constructor(character: Character) {
    super("Couldn’t save the character.", 409, { reason: 'This character changed in another tab. Reload to get the latest version.',
      detail: { code: 'version_conflict', version: character.version } });
    this.name = 'CharacterVersionConflict';
    this.character = character;
  }
}
