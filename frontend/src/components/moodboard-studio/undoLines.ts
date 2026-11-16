/**
 * The undo and redo toasts' words (design r160 answer 3, r161). No colon:
 * "Undid “Made image 3 the cover”". An undo that put nothing back says so
 * instead of "Undid" and offers no Redo, for the three cases the server keeps
 * a step for (keyed on the skipped slice's `reason`, `part` and `number`,
 * never on its sentence): an image that changed after the step, an image
 * removed after it, and a field changed again after it. Any other kept reason
 * (a switch only the person turns on, a colour choice made since, a card that
 * can't go back there) still reads "Undid" with the server's line under it,
 * and so does an undo that put some parts back.
 */

import { FIELD_STEP_LABELS } from './fieldSteps';

/** How a kept field reads in "the ‹field› changed again after that": the field step's own label, lower-cased,
 * except where that would not read as a noun after "the" ("Your brief", "Send notes to generators"). The cover has no
 * field step of its own (it is an image step), so it is named here. */
const FIELD_IN_SENTENCE: Record<string, string> = {
  ...Object.fromEntries(Object.entries(FIELD_STEP_LABELS).map(([key, label]) => [key, label.toLowerCase()])),
  briefOverride: 'brief', sendNotes: 'send notes setting', coverImageId: 'cover',
};

/** "Undid “Made image 3 the cover”" or "Redid “…”". */
export function undoneLine(direction: 'undo' | 'redo', label: string): string {
  return `${direction === 'undo' ? 'Undid' : 'Redid'} “${label}”`;
}

interface SkippedSlice { part?: unknown; field?: unknown; reason?: unknown; number?: unknown }

/** "image 5", "images 5 and 6", "images 3, 5 and 6". */
function imageNumbers(numbers: readonly number[]): string {
  if (numbers.length === 1) return `image ${numbers[0]}`;
  return `images ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

const were = (numbers: readonly number[]) => (numbers.length === 1 ? 'was' : 'were');

/**
 * The kept undo's sentence, for an undo that put nothing back:
 * "Nebula couldn’t undo “Added image 5” because image 5 changed after that.",
 * "... because image 5 was removed after that." or, for a field step,
 * "Nebula couldn’t undo “Direction” because the direction changed again after that."
 * (the field's name, from its key). Null for anything else.
 */
export function keptUndoLine(label: string, skipped: readonly SkippedSlice[]): string | null {
  if (skipped.length === 0) return null;
  if (skipped.every((slice) => slice.part === 'fields' && slice.reason === 'changed since')) {
    const fields: string[] = [];
    for (const slice of skipped) {
      const name = typeof slice.field === 'string' ? FIELD_IN_SENTENCE[slice.field] : undefined;
      if (!name) return null;
      if (!fields.includes(name)) fields.push(name);
    }
    return `Nebula couldn’t undo “${label}” because ${fields.map((name) => `the ${name}`).join(' and ')} changed again after that.`;
  }
  const changed: number[] = [];
  const removed: number[] = [];
  for (const slice of skipped) {
    if (typeof slice.number !== 'number') return null;
    const into = slice.reason === 'changed since' ? changed : slice.reason === 'removed since' ? removed : null;
    if (!into) return null;
    if (!into.includes(slice.number)) into.push(slice.number);
  }
  changed.sort((a, b) => a - b);
  removed.sort((a, b) => a - b);
  const parts = [
    ...(changed.length ? [`${imageNumbers(changed)} changed`] : []),
    ...(removed.length ? [`${imageNumbers(removed)} ${were(removed)} removed`] : []),
  ];
  return `Nebula couldn’t undo “${label}” because ${parts.join(' and ')} after that.`;
}
