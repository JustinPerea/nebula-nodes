/**
 * The undo and redo toasts' words (design r160 answer 3, r161). No colon:
 * "Undid “Made image 3 the cover”". An undo that put nothing back says so
 * instead of "Undid" and offers no Redo, for the three cases the server keeps
 * a step for (keyed on the skipped slice's `reason`, `part` and `number`,
 * never on its sentence): an image that changed after the step, an image
 * removed after it, and a field changed again after it. Any other kept reason
 * (a switch only the person turns on, a colour choice made since, a card that
 * can't go back there) still reads "Undid" with the server's line under it.
 * An undo that put some parts back and kept images that changed after the step
 * says so in one line (partialUndoLine); any other partial mix keeps the server's
 * line under "Undid".
 */

import { FIELD_NOUNS } from './fieldSteps';

/** How a kept field reads in "because ‹the field› changed again after that" (design): the field's noun, as the step's
 * own label says it. The cover has no field step of its own (it is an image step), so it is named here. */
const FIELD_IN_SENTENCE: Record<string, string> = { ...FIELD_NOUNS, coverImageId: 'the cover' };

/** A step's label inside a line's own quotes: its inner double quotes turn single ("Turned on ‘Moodboard notes to
 * generators’"), so the line never nests the same mark. */
function inQuotes(label: string): string {
  return `“${label.replace(/“/g, '‘').replace(/”/g, '’')}”`;
}

/** "Undid “Made image 3 the cover”" or "Redid “…”". */
export function undoneLine(direction: 'undo' | 'redo', label: string): string {
  return `${direction === 'undo' ? 'Undid' : 'Redid'} ${inQuotes(label)}`;
}

interface SkippedSlice { part?: unknown; field?: unknown; reason?: unknown; number?: unknown; settings?: unknown }

/** "image 5", "images 5 and 6", "images 3, 5 and 6". */
function imageNumbers(numbers: readonly number[]): string {
  if (numbers.length === 1) return `image ${numbers[0]}`;
  return `images ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

const were = (numbers: readonly number[]) => (numbers.length === 1 ? 'was' : 'were');

/** The setting words of an image slice ("note", "private note"), from the server's keys. */
const SETTING_WORDS: Record<string, string> = { weight: 'weight', excluded: 'set-aside switch', notes: 'note', privateNote: 'private note' };

const joined = (words: readonly string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * The kept undo's sentence, for an undo that put nothing back, in the because form (design):
 * "Nebula couldn’t undo “Added image 5” because image 5 changed after that.",
 * "... because image 5 was removed after that.", "... “Changed the direction” because the direction changed again
 * after that." and the reasons a step can't go back (only the person can change a field, a pinned color that the step
 * used was removed, a color was chosen after the step, the card's place was taken, a file isn't Nebula's own).
 * Keyed on each slice's `reason`, `part`, `field` and `number`, never on the server's sentence. Null when any slice has
 * a reason this doesn't say, so the toast keeps the server's line under "Undid".
 */
export function keptUndoLine(label: string, skipped: readonly SkippedSlice[]): string | null {
  if (skipped.length === 0) return null;
  const fieldsChanged: string[] = [];
  const onlyYou: string[] = [];
  const clauses = new Set<string>();
  const changed: number[] = [];
  const removed: number[] = [];
  const settingsChanged: string[] = [];
  const notNebulas: number[] = [];
  const push = <T,>(into: T[], value: T) => { if (!into.includes(value)) into.push(value); };
  for (const slice of skipped) {
    if (slice.part === 'fields') {
      const name = typeof slice.field === 'string' ? FIELD_IN_SENTENCE[slice.field] : undefined;
      if (!name) return null;
      if (slice.reason === 'changed since') push(fieldsChanged, name);
      else if (slice.reason === 'is the person’s to change') push(onlyYou, `change ${name}`);
      else if (slice.reason === 'is the person’s to turn on') push(onlyYou, 'turn it on');
      else if (slice.reason === 'can’t go back') clauses.add(slice.field === 'coverImageId' ? 'that image was removed after that' : 'a pinned color that step used was removed after that');
      else if (slice.reason === 'would undo a colour choice made since') clauses.add('a color was chosen after that');
      else return null;
      continue;
    }
    if (typeof slice.number !== 'number') return null;
    const number = slice.number;
    if (slice.reason === 'changed since') {
      const words = Array.isArray(slice.settings) ? slice.settings.map((key) => SETTING_WORDS[String(key)]) : [];
      if (words.length && words.every(Boolean)) push(settingsChanged, `image ${number}’s ${joined(words)} changed after that`);
      else push(changed, number);
    } else if (slice.reason === 'removed since') push(removed, number);
    else if (slice.reason === 'can’t go back there') clauses.add('its place on the moodboard was taken or removed after that');
    else if (slice.reason === 'isn’t one of Nebula’s own files') push(notNebulas, number);
    else return null;
  }
  changed.sort((a, b) => a - b);
  removed.sort((a, b) => a - b);
  notNebulas.sort((a, b) => a - b);
  const parts = [
    ...(fieldsChanged.length ? [`${joined(fieldsChanged)} changed again after that`] : []),
    ...(onlyYou.length ? [`only you can ${joined(onlyYou)}`] : []),
    ...(changed.length || removed.length ? [`${[
      ...(changed.length ? [`${imageNumbers(changed)} changed`] : []),
      ...(removed.length ? [`${imageNumbers(removed)} ${were(removed)} removed`] : []),
    ].join(' and ')} after that`] : []),
    ...settingsChanged,
    ...clauses,
    ...(notNebulas.length ? [`${imageNumbers(notNebulas)} ${notNebulas.length === 1 ? 'isn’t' : 'aren’t'} one of Nebula’s own files`] : []),
  ];
  return `Nebula couldn’t undo ${inQuotes(label)} because ${joined(parts)}.`;
}

/**
 * The toast for an undo (or redo) that put some parts back and kept others, in one line (design): "Undid “Moved
 * image 5” except image 5, which changed after that.", "... except images 3 and 5, which changed after that."
 * (three: "images 2, 3 and 5"), and from four on a count: "... except 4 images that changed after that.". Only for
 * kept slices that are an image or a card with a number and the reason "changed since"; any other mix (a field, a
 * look, an image without a number, one of its settings, another reason) is null, and the toast keeps "Undid" with
 * the server's line under it. Keyed on `part`, `reason` and `number`, never on the server's sentence.
 */
export function partialUndoLine(direction: 'undo' | 'redo', label: string, skipped: readonly SkippedSlice[]): string | null {
  if (skipped.length === 0) return null;
  const numbers: number[] = [];
  for (const slice of skipped) {
    if (slice.reason !== 'changed since' || (slice.part !== 'image' && slice.part !== 'card')) return null;
    if (typeof slice.number !== 'number' || slice.settings !== undefined) return null;
    if (!numbers.includes(slice.number)) numbers.push(slice.number);
  }
  numbers.sort((a, b) => a - b);
  const done = undoneLine(direction, label);
  if (numbers.length >= 4) return `${done} except ${numbers.length} images that changed after that.`;
  return `${done} except ${imageNumbers(numbers)}, which changed after that.`;
}
