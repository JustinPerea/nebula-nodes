import { RequestFailedError } from './errorCopy';
import type { Character } from '../types';

/** A PUT sent with `baseVersion` after someone else saved the Character
 *  (409). `character` is the Character as it is now, to rebase on. */
export class CharacterVersionConflict extends RequestFailedError {
  readonly character: Character;

  /** After three in a row the Studio's notice says this, as the board's does
   * (GM, error-copy round 2); the version stays in `detail`. */
  constructor(character: Character) {
    super("Couldn't save the character.", 409, { reason: 'This character changed in another window. Reload to get the latest version.',
      detail: { code: 'version_conflict', version: character.version } });
    this.name = 'CharacterVersionConflict';
    this.character = character;
  }
}

/** The Character fields the Studio edits and a PUT may carry. */
export const CHARACTER_FIELD_KEYS = ['name', 'subjectType', 'referenceViews', 'frozenTraitString', 'seed',
  'consistencyStrength'] as const;
export type CharacterFieldKey = typeof CHARACTER_FIELD_KEYS[number];
export type CharacterFields = Partial<Record<CharacterFieldKey, unknown>>;

const FIELD_WORDS: Record<CharacterFieldKey, string> = {
  name: 'the name',
  subjectType: 'the subject type',
  referenceViews: 'the reference views',
  frozenTraitString: 'the frozen trait string',
  seed: 'the seed',
  consistencyStrength: 'the consistency strength',
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What a draft keeps beside a saved Character: its fields as last read
 *  (`base`) and that Character's `version`. Never sent as they are. */
export interface CheckedCharacterDraft extends CharacterFields {
  base?: CharacterFields;
  version?: number;
}

export function characterFields(source: CharacterFields): CharacterFields {
  return Object.fromEntries(CHARACTER_FIELD_KEYS.filter((key) => key in source).map((key) => [key, source[key]]));
}

/** The fields of `next` that differ from `previous`: what one edit in the
 *  Studio changed, to apply onto the draft as it is now. */
export function editedFields<D extends CharacterFields>(previous: D, next: D): Partial<D> {
  return Object.fromEntries(CHARACTER_FIELD_KEYS.filter((key) => key in next && !same(previous[key], next[key]))
    .map((key) => [key, next[key]])) as Partial<D>;
}

const trimmed = (fields: CharacterFields): CharacterFields =>
  (typeof fields.name === 'string' ? { ...fields, name: fields.name.trim() } : fields);

/** The fields the person changed since the last read: what a PUT sends.
 *  The name compares (and goes) trimmed, as it is saved. */
export function changedFields(draft: CheckedCharacterDraft): CharacterFields {
  if (!draft.base) return trimmed(characterFields(draft));
  const base = trimmed(draft.base);
  const mine = trimmed(characterFields(draft));
  return Object.fromEntries(CHARACTER_FIELD_KEYS.filter((key) => key in mine && !same(mine[key], base[key]))
    .map((key) => [key, mine[key]]));
}

/** One field both the person (not yet saved, or being saved) and someone
 *  else changed, to different values: the person's stays. */
export interface CharacterConflict {
  field: CharacterFieldKey;
  mine: unknown;
  theirs: unknown;
}

/** `draft` moved onto `character` (read again, or what a PUT answered):
 *  each field takes the Character's value unless the person changed it
 *  since the last read, and the draft's base and version become the
 *  Character's. `asSent`: the fields a PUT just saved, as the draft held
 *  them when it sent them; they stand in for the Character's in the base,
 *  so a name the server keeps trimmed doesn't read as the person's change
 *  for good. `dirty`: a draft kept from before there was a base holds the
 *  person's edits in every field.
 *
 *  `projectId` is left alone: where the Character lives is followed by the
 *  kept-draft move (lib/keptDraftMoves), which also moves the draft's key. */
export function rebaseCharacterDraft<D extends CheckedCharacterDraft>(draft: D, character: Character,
  { asSent, dirty = false }: { asSent?: CharacterFields; dirty?: boolean } = {},
): { draft: D; conflicts: CharacterConflict[] } {
  const theirs = characterFields(character as unknown as CharacterFields);
  const base = { ...theirs, ...asSent };
  const out = { ...draft } as D & CharacterFields;
  const conflicts: CharacterConflict[] = [];
  for (const key of CHARACTER_FIELD_KEYS) {
    // A field the PUT just sent changed since only if the draft moved off
    // what was sent (an edit made while the save was out, even one back to
    // the value last read); any other field, if it moved off the base.
    const mineChanged = asSent && key in asSent ? !same(draft[key], asSent[key])
      : draft.base ? !same(draft[key], draft.base[key]) : dirty;
    if (!mineChanged) {
      out[key] = base[key] as never;
      continue;
    }
    const theyChanged = draft.base ? !same(theirs[key], draft.base[key]) : false;
    if (theyChanged && !same(theirs[key], draft[key]) && !(asSent && key in asSent)) {
      conflicts.push({ field: key, mine: draft[key], theirs: theirs[key] });
    }
  }
  return { draft: { ...out, base, version: character.version }, conflicts };
}

/** Who wrote an outside edit, as the note names them. */
export function editorLabel(actor: { kind?: string; name?: string } | null | undefined): string {
  if (actor?.kind === 'person') return 'Another tab';
  return actor?.name?.trim() || 'Someone else';
}

function listed(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The note for fields both sides changed: "Claude also changed the name
 *  while you were editing it. Yours is kept." */
export function conflictNote(conflicts: CharacterConflict[], who: string): string {
  const fields = listed(conflicts.map((conflict) => FIELD_WORDS[conflict.field]));
  const one = conflicts.length === 1;
  return `${who} also changed ${fields} while you were editing ${one ? 'it' : 'them'}. ${one ? 'Yours is' : 'Yours are'} kept.`;
}
