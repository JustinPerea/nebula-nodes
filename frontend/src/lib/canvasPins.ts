import type { InternalNode, Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { apiRequest } from './apiRequest';
import { PERSON_REQUIRED_CODE, RequestFailedError, personRequiredCopy } from './errorCopy';
import type { Pin } from './wsClient';
import type { ProjectContext } from './projectContext';

export type { Pin } from './wsClient';

/** Matches the backend cap (services/canvas_pins.MAX_PIN_TEXT). */
export const MAX_PIN_TEXT = 280;

export type PinTarget = { nodeId: string } | { position: { x: number; y: number } };

export interface PinListing {
  projectId: string | null;
  pins: Pin[];
}

export async function fetchPins(): Promise<PinListing> {
  const response = await apiRequest("Couldn't load the notes.", '/api/canvas/pins');
  return (await response.json()) as PinListing;
}

/** `project`: the project and canvas the note was composed on (round 23 of
 * PR #195, review 22 M-1). Its target names a node or spot of that canvas
 * only, so it is sent for that canvas (its revision headers) and Nebula
 * refuses it once that canvas has gone. */
export async function createPin(text: string, target: PinTarget, project?: ProjectContext | null): Promise<Pin> {
  const response = await apiRequest("Couldn't save the note.", '/api/canvas/pins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...target }),
  }, project === undefined ? {} : { project });
  return ((await response.json()) as { pin: Pin }).pin;
}

/**
 * Round 23 (review 22, M-1): a note the person was writing when its canvas
 * went (an agent opened another project, or the canvas was replaced) is
 * never pinned elsewhere: the dialog closes and this keeps the text, with a
 * way to copy it. GM - Design, r24 item 1 (2026-10-27), verbatim: no colon,
 * the reason given:
 *   "Your note wasn’t sent because the canvas changed first."
 *   A follow started: "Your note wasn’t sent because Codex started opening
 *    “Second canvas”." ("an agent" when the agent isn't known).
 * The note itself on its own line, in quotes, clamped to 2 lines with "…";
 * "Copy note" copies the full text; "Copy note" and × stay.
 */
export const NOTE_KEPT_LINE = 'Your note wasn’t sent because the canvas changed first.';
export const NOTE_KEPT_COPY = 'Copy note';

/** The kept note's line: why it wasn't sent. `following`: the follow that
 * closed the dialog (or was on when Nebula refused the note). */
export function noteKeptLine(following: { agent: string | null; projectName: string } | null, forProject?: string | null): string {
  const note = forProject ? `Your note for “${forProject}”` : 'Your note';
  if (!following || !following.projectName) return `${note} wasn’t sent because the canvas changed first.`;
  return `${note} wasn’t sent because ${following.agent || 'an agent'} started opening “${following.projectName}”.`;
}

/** A note kept because its canvas went before it was sent (one per
 * project, fix round 3 of PR #200, review 3 M-2). */
export interface KeptNote {
  text: string;
  /** GM's line on the note's own project. */
  line: string;
  /** The project it was written in ('' for no project). */
  project: string;
  /** That project's name when the note was kept ('' when none). */
  projectName: string;
  /** Why: the follow that cut it off, or null (the canvas changed). */
  following: { agent: string | null; projectName: string } | null;
}

/** The kept note's line as the person sees it on `here` (GM, PR #200 round 3
 * M-2, verbatim): on its own project the line stays as it is; on another it
 * names its project, "Your note for “Alpha” wasn’t sent because Codex started
 * opening “Second canvas”." A note of no project (or one whose name isn't
 * known) keeps the plain line everywhere. */
export function keptNoteLine(note: KeptNote, here: string, currentName?: string | null): string {
  // Its project's name now, when it is still known (fix round 4 of PR #200,
  // review 4 N-5: a rename after the note was kept); else the name it had.
  const name = currentName || note.projectName;
  if (note.project === here || !name) return note.line;
  return noteKeptLine(note.following, name);
}

// Terminal escape sequences, each dropped whole: CSI (7- and 8-bit), then
// OSC, DCS, APC, PM and SOS up to ST or BEL, or to the end of their line
// (backend services/canvas_pins.py _ANSI, the same rule).
// eslint-disable-next-line no-control-regex -- these are the bytes it removes
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|(?:\x1b[\]P_^X]|[\x90\x98\x9d\x9e\x9f])[^\r\n]*?(?:\x1b\\|\x9c|\x07|(?=[\r\n])|$)/g;
// Every line break Python's str.splitlines knows, as the backend reads them.
// eslint-disable-next-line no-control-regex -- line-break controls
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
// Review 11 MEDIUM-1 and GM r19 answer 1: what draws nothing is hidden
// text; only real emoji and real variants keep their invisible parts. GM r21
// (fix round 13): at most one variation selector stays, and only when Unicode
// lists it for the character before it (E0100-E01EF for a pair the
// Ideographic Variation Database registers, GM r23; 180B-180D/180F after a Mongolian letter, FE00-FE0F after a base
// StandardizedVariants or emoji-variation-sequences lists for it); a
// zero-width joiner stays inside an emoji ZWJ sequence; tag characters stay
// only as the England, Scotland or Wales flag (review 12 M-1). The data is
// generated from Unicode's files (scripts/generate-pin-text-unicode.py), the
// same bytes the backend reads (services/canvas_pins.py _plain, the same rule).
const within = (spans: number[][]) => (code: number) => {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (code < spans[mid][0]) high = mid - 1;
    else if (code > spans[mid][1]) low = mid + 1;
    else return true;
  }
  return false;
};
// Review 13 L-2 (fix round 14): the data is its own chunk, fetched as this
// module loads, not part of the entry. Until it lands every rule here errs on
// the side of hiding and counting more (no selector fits, no tag run is a
// flag, no ZWJ chain is RGI), and nothing that needs it runs before it: the
// store awaits it before it sanitizes a pin (hydrate, a pushed listing, a
// sent note), and the note dialog before it counts.
type PinTextData = { ivd: string; mongolianLetters: number[][]; variationBases: Record<string, number[][]>;
  rgiZwj: string[]; rgiZwjLongest: number; tagFlags: string[] };
// GM r23 (review 13 M-1): base code point to the selector offsets from
// E0100 the Ideographic Variation Database registers for it.
let ivd = new Map<number, Set<number>>();
/** The generator's IVD text ("<base delta>:<offset runs>" in base 36, joined
 * by ","): the backend's canvas_pins._ivd_pairs, the same decode. */
const ivdPairs = (text: string) => {
  const pairs = new Map<number, Set<number>>();
  let base = 0;
  for (const entry of text.split(',')) {
    if (!entry) continue;
    const [delta, runs] = entry.split(':');
    base += parseInt(delta, 36);
    const offsets = new Set<number>();
    for (const run of runs.split('.')) {
      const [low, high = low] = run.split('-');
      for (let at = parseInt(low, 36); at <= parseInt(high, 36); at += 1) offsets.add(at);
    }
    pairs.set(base, offsets);
  }
  return pairs;
};
let mongolianLetter: (code: number) => boolean = () => false;
let variationBases = new Map<number, (code: number) => boolean>();
let RGI_ZWJ = new Set<string>();
let RGI_ZWJ_LONGEST = 1;
let TAG_FLAGS = new Set<string>();
let pinTextLoaded = false;
/** Resolves once the generated Unicode data is in (it never rejects: a failed
 * fetch leaves the strict fallbacks above). */
export const pinTextReady: Promise<void> = import('./pinTextUnicode.json').then(({ default: data }) => {
  const unicode = data as PinTextData;
  ivd = ivdPairs(unicode.ivd);
  mongolianLetter = within(unicode.mongolianLetters);
  variationBases = new Map(Object.entries(unicode.variationBases).map(([selector, spans]) => [parseInt(selector, 16), within(spans)]));
  RGI_ZWJ = new Set(unicode.rgiZwj);
  RGI_ZWJ_LONGEST = unicode.rgiZwjLongest;
  TAG_FLAGS = new Set(unicode.tagFlags);
  pinTextLoaded = true;
}, () => undefined);
/** Whether the Unicode data is in (see pinTextReady). */
export const pinTextIsLoaded = () => pinTextLoaded;
const PICTOGRAPHIC: Array<[number, number]> = [
  [0x00a9, 0x00a9], [0x00ae, 0x00ae], [0x203c, 0x203c], [0x2049, 0x2049], [0x2122, 0x2122],
  [0x2139, 0x2139], [0x2194, 0x21aa], [0x231a, 0x23ff], [0x24c2, 0x24c2], [0x25aa, 0x25fe],
  [0x2600, 0x27bf], [0x2934, 0x2935], [0x2b05, 0x2b55], [0x3030, 0x3030], [0x303d, 0x303d],
  [0x3297, 0x3297], [0x3299, 0x3299], [0x1f000, 0x1f1e5], [0x1f200, 0x1f3fa], [0x1f400, 0x1faff],
  [0x1fc00, 0x1fffd],
];
const ZWJ = '\u200d';
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const pictographic = (char: string | undefined) => {
  if (!char) return false;
  const code = char.codePointAt(0) ?? 0;
  return PICTOGRAPHIC.some(([low, high]) => code >= low && code <= high);
};
const skinTone = (char: string) => { const code = char.codePointAt(0) ?? 0; return code >= 0x1f3fb && code <= 0x1f3ff; };
const variationSelector = (code: number) => (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef)
  || (code >= 0x180b && code <= 0x180d) || code === 0x180f;
// GM r21: this selector is listed for this base.
const selectorFits = (base: string | undefined, code: number) => {
  if (base === undefined) return false;
  const point = base.codePointAt(0) ?? 0;
  if (code >= 0xfe00 && code <= 0xfe0f) return variationBases.get(code)?.(point) ?? false;
  if (code >= 0xe0100 && code <= 0xe01ef) return ivd.get(point)?.has(code - 0xe0100) ?? false;
  return mongolianLetter(point);
};
// The combining grapheme joiner and Khmer's inherent vowels draw nothing.
const neverShownMark = (code: number) => code === 0x034f || code === 0x17b4 || code === 0x17b5;
const endsInEmoji = (out: string[]) => {
  let index = out.length - 1;
  if (index >= 0 && skinTone(out[index])) index -= 1;
  if (index >= 0 && out[index] === '\ufe0f') index -= 1;
  return index >= 0 && pictographic(out[index]);
};
const tagSpec = (code: number) => code >= 0xe0020 && code <= 0xe007e;
const plain = (line: string) => {
  const chars = Array.from(line);
  const out: string[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    const code = char.codePointAt(0) ?? 0;
    if (char === '\t' || char === '\n' || char === '\r') { out.push(' '); index += 1; continue; }
    if (code === BLACK_FLAG) {
      let end = index + 1;
      while (end < chars.length && tagSpec(chars[end].codePointAt(0) ?? 0)) end += 1;
      // Only England, Scotland and Wales (review 12 M-1).
      const spec = chars.slice(index + 1, end).map((tag) => String.fromCodePoint((tag.codePointAt(0) ?? 0) - 0xe0000)).join('');
      if (TAG_FLAGS.has(spec) && end < chars.length && chars[end].codePointAt(0) === CANCEL_TAG) {
        out.push(...chars.slice(index, end + 1));
        index = end + 1;
        continue;
      }
    }
    if (char === ZWJ) {
      if (endsInEmoji(out) && pictographic(chars[index + 1])) out.push(char);
      index += 1;
      continue;
    }
    if (/[\p{Cc}\p{Cf}]/u.test(char)) { index += 1; continue; }
    if (variationSelector(code)) {
      // One, valid for its base (GM r21); a second finds a selector before it.
      if (selectorFits(out[out.length - 1], code)) out.push(char);
      index += 1;
      continue;
    }
    if (neverShownMark(code)) { index += 1; continue; }
    out.push(char);
    index += 1;
  }
  return out.join('');
};

/**
 * Note text as the canvas shows it (PR #200 fix round 10, GM r16 answer 3:
 * "Store raw, show stripped. The canvas display is an output path too"). The
 * backend keeps a note and a reply as typed and strips every output; this is
 * the display's own strip, the same rule (services/canvas_pins.py
 * shown_text): no C0 but line breaks, no C1, no ESC, no format characters;
 * each line loses its trailing spaces and the note its blank lines at the
 * ends. A note also folds each run of blank lines to one break (review 4
 * N-3) unless `fold: false` (a tooltip of the whole note). `multiline:
 * false` (a reply) is one line, spaces collapsed.
 */
export function pinDisplayText(text: string | null | undefined, { multiline = true, fold = true }: { multiline?: boolean; fold?: boolean } = {}): string {
  const raw = (text ?? '').replace(ESCAPES, '');
  // GM r19 answer 1: whitespace at the ends goes; inside, spaces and blank
  // lines show as typed (the backend's _shown, the same rule).
  // One line: each line break reads as one space, never glued.
  if (!multiline) return plain(raw.split(LINE_BREAKS).join(' ')).trim();
  const joined = raw.split(LINE_BREAKS).map(plain).join('\n').trim();
  // The display folds a run of blank (or space-only) lines to one break.
  return fold ? joined.replace(/\n(?:[^\S\n]*\n)+/g, '\n') : joined;
}

// GM r12 answer 3 (PR #200 fix round 11): only what shows counts against
// the 280, in characters as a person sees them, of the shown text. The same
// rule as the backend's services/canvas_pins.text_length, code point for
// code point, so the dialog's limit and the backend's refusal never disagree:
// a base and its marks (\p{M}: Mn, Mc, Me, the variation selectors too), an
// emoji skin tone or a flag's tags are one character, up to 32 marks; two
// regional indicators (a flag) are one.
const MAX_MARKS_PER_CHARACTER = 32;
const joinsBefore = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return /\p{M}/u.test(char) || (code >= 0x1f3fb && code <= 0x1f3ff) || (code >= 0xe0020 && code <= 0xe007f);
};
const regional = (char: string | undefined) => { const code = char?.codePointAt(0) ?? 0; return code >= 0x1f1e6 && code <= 0x1f1ff; };

/** The backend's code for a note with too much hidden text (GM r12 answer 3). */
export const HIDDEN_TEXT_CODE = 'note_hidden_too_long';
/** GM r18 Q1: the whole line, no "Couldn't save the note." before it, in a
 * neutral toast; the note stays in the open dialog to fix. */
export const HIDDEN_TEXT_COPY = 'This note has too much hidden text to save. Paste it as plain text, then try again.';
/** The backend's code for a note past 280 shown characters (GM r20 Q1). */
export const TOO_LONG_CODE = 'note_too_long';

/**
 * GM r20 Q1 (PR #200 fix round 13): every pin refusal is one neutral line,
 * what happened, then what to do, with no "Couldn't …" heading; read by the
 * answer's code and status, never its words. The note stays in the dialog.
 */
export const PIN_REFUSAL_COPY = {
  tooLong: 'Notes can be up to 280 characters. Shorten this one, then try again.',
  hidden: HIDDEN_TEXT_COPY,
  addRefused: 'Nebula can’t add this pin. Try again in a moment.',
  saveRefused: 'Nebula can’t save this note. Try again in a moment.',
  addNoAnswer: 'Nebula didn’t answer, so the pin wasn’t added. Try again in a moment.',
  saveNoAnswer: 'Nebula didn’t answer, so the note wasn’t saved. Try again in a moment.',
  deleteFailed: 'Nebula couldn’t delete this note. Try again in a moment.',
  // GM r22 Q1 (fix round 14): the person gate's refusal keeps its own line,
  // with no "try again": waiting won't fix it.
  canvasOnly: 'Notes can only be added from the Nebula canvas.',
  // GM r23 item 2.
  openNotesFull: 'This canvas has 100 open notes. Resolve or delete some, then add this one.',
  nodeGone: 'That node was removed, so the note wasn’t added.',
  // GM r24: a person-gate refusal while the banner shows: the banner carries the fix.
  notAdded: 'Your note wasn’t added.',
  // GM r24: Send note's lock reason while the banner shows.
  sendWhenConnected: 'You can send notes when this tab is connected as you.',
} as const;
/** The backend's codes for the 100-open-notes 409 and the removed-node 404 (GM r23). */
export const OPEN_NOTES_FULL_CODE = 'open_notes_full';
export const NODE_GONE_CODE = 'pin_node_gone';

/** The line for a refused add (a new pin and its note) or save (a note's text). */
export function pinRefusalLine(error: unknown, action: 'add' | 'save'): string {
  const code = error instanceof RequestFailedError ? error.code : null;
  const status = error instanceof RequestFailedError ? error.status : 0;
  if (code === HIDDEN_TEXT_CODE) return PIN_REFUSAL_COPY.hidden;
  if (code === TOO_LONG_CODE) return PIN_REFUSAL_COPY.tooLong;
  if (code === OPEN_NOTES_FULL_CODE) return PIN_REFUSAL_COPY.openNotesFull;
  if (code === NODE_GONE_CODE) return PIN_REFUSAL_COPY.nodeGone;
  // A tab that isn't connected as the person (403 person_required): the
  // person-only line every such refusal reads, the banner's own (GM Q116 a;
  // review 13 L-1), which says how to fix it.
  if (code === PERSON_REQUIRED_CODE && status >= 400 && status < 500) return personRequiredCopy();
  // Any other person-gate 403 (agent_refused: a request that isn't the
  // canvas's own) keeps GM r22 Q1's line. Adding is the only person-only pin write.
  if (status === 403 && action === 'add') return PIN_REFUSAL_COPY.canvasOnly;
  if (status >= 400 && status < 500) return action === 'add' ? PIN_REFUSAL_COPY.addRefused : PIN_REFUSAL_COPY.saveRefused;
  // A 5xx, or no answer at all.
  return action === 'add' ? PIN_REFUSAL_COPY.addNoAnswer : PIN_REFUSAL_COPY.saveNoAnswer;
}

// A Hangul jamo or syllable's part in a syllable (UAX #29): L, V, T, LV, LVT, or ''.
const hangul = (char: string | undefined): string => {
  const code = char?.codePointAt(0) ?? 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0xa960 && code <= 0xa97c)) return 'L';
  if ((code >= 0x1160 && code <= 0x11a7) || (code >= 0xd7b0 && code <= 0xd7c6)) return 'V';
  if ((code >= 0x11a8 && code <= 0x11ff) || (code >= 0xd7cb && code <= 0xd7fb)) return 'T';
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? 'LV' : 'LVT';
  return '';
};
// Hangul parts that join the one before (UAX #29 GB6-GB8).
const HANGUL_JOINS: Record<string, string[]> = { L: ['L', 'V', 'LV', 'LVT'], V: ['V', 'T'], LV: ['V', 'T'], T: ['T'], LVT: ['T'] };

// Past the marks that join the character before `end`, up to 32.
const marksEnd = (chars: string[], end: number) => {
  let marks = 0;
  while (end < chars.length && marks < MAX_MARKS_PER_CHARACTER && joinsBefore(chars[end])) { end += 1; marks += 1; }
  return end;
};
// An emoji in a ZWJ chain as the RGI list keys it: no FE0E/FE0F, no skin tone.
const zwjKey = (part: string[]) => part.filter((char) => char !== '\ufe0e' && char !== '\ufe0f' && !skinTone(char))
  .map((char) => (char.codePointAt(0) ?? 0).toString(16).toUpperCase()).join(' ');
// Review 12 L-2, GM r21: each RGI ZWJ sequence in a chain is one character,
// longest first from the left; every other emoji counts on its own.
const zwjCharacters = (parts: string[][]) => {
  const keys = parts.map(zwjKey);
  let characters = 0;
  let at = 0;
  while (at < keys.length) {
    let step = 1;
    for (let size = Math.min(RGI_ZWJ_LONGEST, keys.length - at); size > 1; size -= 1) {
      if (RGI_ZWJ.has(keys.slice(at, at + size).join('|'))) { step = size; break; }
    }
    characters += 1;
    at += step;
  }
  return characters;
};

/** Characters as a person sees them in already-shown text: a base and its
 * marks are one (a mark after a line break is its own), a flag is one,
 * Hangul jamo that make one syllable are one (review 11 NIT-3), and a chain
 * of emoji joined by ZWJ counts each RGI ZWJ sequence in it as one and every
 * other emoji on its own (review 12 L-2). */
export function textLength(shown: string): number {
  const chars = Array.from(shown);
  let count = 0;
  let at = 0;
  while (at < chars.length) {
    const char = chars[at];
    let end = at + 1;
    if (char !== '\n') {
      if (regional(char) && regional(chars[end])) end += 1;
      else {
        let part = hangul(char);
        while (part && end < chars.length && (HANGUL_JOINS[part] ?? []).includes(hangul(chars[end]))) { part = hangul(chars[end]); end += 1; }
      }
      end = marksEnd(chars, end);
    }
    if (pictographic(char)) {
      const parts = [chars.slice(at, end)];
      while (end + 1 < chars.length && chars[end] === ZWJ && pictographic(chars[end + 1])) {
        const start = end + 1;
        end = marksEnd(chars, start + 1);
        parts.push(chars.slice(start, end));
      }
      count += zwjCharacters(parts);
    } else count += 1;
    at = end;
  }
  return count;
}

/** What a typed note counts against the cap: its shown form's characters. */
export function noteLength(text: string): number {
  return textLength(pinDisplayText(text, { fold: false }));
}

/** The longest start of `text` (whole code points) that fits the cap: the
 * note dialog's limit, the way maxLength trims a paste, counted as above. */
export function fitNote(text: string, limit: number = MAX_PIN_TEXT): string {
  if (noteLength(text) <= limit) return text;
  const points = Array.from(text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (noteLength(points.slice(0, mid).join('')) <= limit) low = mid; else high = mid - 1;
  }
  // Review 11 NIT-1: a count drops as an escape code completes ("\x1b[3"
  // shows "[3", "\x1b[31m" nothing), so a longer start can fit where the
  // search stopped: try a few more and keep the longest that fits.
  for (let k = low + 1; k <= Math.min(points.length, low + 64); k += 1) {
    if (noteLength(points.slice(0, k).join('')) <= limit) low = k;
  }
  return points.slice(0, dropCutEscape(points.slice(0, low))).join('');
}

// Review 12 L-1: a cut that ends inside an escape code ("\x1b[0" of
// "\x1b[0m") drops that partial code whole, so nothing after it can ever
// complete it (the dialog no longer cuts a paste, GM r20; this bounds a
// pin's text as it arrives).
// eslint-disable-next-line no-control-regex -- the escape bytes it looks for
const CUT_ESCAPE = /(?:\x1b(?:\[[0-?]*[ -/]*)?|\x9b[0-?]*[ -/]*)$/;
function dropCutEscape(points: string[]): number {
  const cut = CUT_ESCAPE.exec(points.join(''));
  return cut ? Array.from(points.join('').slice(0, cut.index)).length : points.length;
}

/** A kept note as its notice shows it (GM, PR #200 round 5 answer 5): its
 * own line breaks, clamped to 2 lines by CSS, with each run of blank lines
 * (and a line of only spaces) collapsed to one break, so the two lines show
 * text (review 4 N-3), and stripped like every display of a note
 * (pinDisplayText). Copy note copies `note.text`, whole, as typed. */
export function keptNoteDisplay(text: string): string {
  return pinDisplayText(text);
}

/** How many kept notes show before "Show N more" (fix round 4 of PR #200,
 * review 4 LOW-1; GM round 5: "newest two plus a control labelled “Show 7
 * more”"). */
export const KEPT_SHOWN = 2;
export const keptMoreLabel = (hidden: number) => `Show ${hidden} more`;
export const KEPT_FEWER = 'Show fewer';

export async function deletePin(id: string): Promise<void> {
  await apiRequest("Couldn't delete the note.", `/api/canvas/pins/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Backend graph ids look like n12; only those can carry pins (and be seen by agents). */
export function isBackendNodeId(id: string | null | undefined): id is string {
  return typeof id === 'string' && /^n\d+$/.test(id);
}

/**
 * Badges sit on the card's top-right corner; extra pins on one node step left.
 * The node box starts at the small category label; the card's top edge is
 * about 38 px below it (measured live), so the badge centres on that corner.
 */
const BADGE_INSET_X = 10;
const BADGE_INSET_Y = 38;
const BADGE_STEP_X = 22;

/** "12m ago" for an ISO timestamp. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export type PinLookup = Map<string, InternalNode<Node<NodeData>>>;

/** Where a pin's badge goes in flow coordinates, or null while its node isn't drawn. */
export function pinPoint(pin: Pin, slot: number, lookup: PinLookup): { x: number; y: number } | null {
  if (!('nodeId' in pin.anchor)) return { x: pin.anchor.x, y: pin.anchor.y };
  const node = lookup.get(pin.anchor.nodeId);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured?.width ?? 0;
  return { x: x + width - BADGE_INSET_X - slot * BADGE_STEP_X, y: y + BADGE_INSET_Y };
}

