import type { Moodboard, MoodboardImage, MoodboardPlacement } from '../types';
import { cardWeight } from '../components/moodboard-studio/steering';
import { sizeFor } from './moodboardLayout';

/**
 * Checked board edits, the Studio's side (backend services/moodboard_edits.py,
 * `POST /api/moodboards/{id}/edits`; plan section 5.3).
 *
 * Every image change in Moodboard Studio is an op: it applies to the draft at
 * once and waits in the draft's queue (`pendingOps`) until the autosave sends
 * it, 600 ms after the last change or when a field loses focus. Ops are
 * absolute sets ("image i1 weighs 0.5"), so when someone else saves the board
 * meanwhile (an agent, the CLI, another window), the Studio takes the board
 * as it is now and replays its queue on top (`rebaseDraft`). A PUT carries
 * only the board fields that differ from the board last read (`fieldChanges`),
 * with `baseVersion`, so it can't undo anyone's edit either.
 */

/** The ops the Studio sends. The backend takes more (resize, frames...);
 *  later parts of the board canvas add them. `restore` is never queued: it
 *  is a batch's `undo`, sent back as it came (lib/boardUndo). */
export type MoodboardOp =
  | { op: 'add'; images: Array<Partial<MoodboardImage> & { url: string }>; index?: number; unique?: boolean;
    /** The card's top-left on the board (an image dropped at the pointer); one image per op. */
    at?: { x: number; y: number } }
  | { op: 'remove'; images: string[] }
  | { op: 'weight'; image: string; value: number }
  | { op: 'setAside'; image: string; value: boolean }
  | { op: 'note'; image: string; notes?: string; privateNote?: string }
  /** A card moved on the Board view (whole flow pixels). */
  | { op: 'place'; placement: string; x: number; y: number }
  /** The image the board opens on (lib/moodboardCover), or null for #1. It
   *  moves no image: `applyOps` leaves the images as they are. */
  | { op: 'cover'; image: string | null }
  | { op: 'restore'; slices: Array<Record<string, unknown>> };

/** What a board edit answers. `undo` is a `restore` that puts the board back. */
export interface MoodboardEditResult {
  board: Moodboard;
  version: number;
  applied: Array<{ index: number; op: string; status: 'applied' | 'unchanged'; [key: string]: unknown }>;
  undo: { ops: Array<Record<string, unknown>> };
}

/** A write sent with `baseVersion` after someone else saved the board (409).
 *  `board` is the board as it is now, to rebase on. */
export class MoodboardVersionConflict extends Error {
  readonly board: Moodboard;

  constructor(board: Moodboard) {
    super(`The board changed since it was read (it is at version ${board.version}).`);
    this.name = 'MoodboardVersionConflict';
    this.board = board;
  }
}

/** Whether an op changes what the analysis reads (backend `steering`):
 *  a private note doesn't. */
export function opSteers(op: MoodboardOp): boolean {
  // A card's place and the cover are presentation only: they keep the analysis.
  if (op.op === 'place' || op.op === 'cover') return false;
  return op.op !== 'note' || 'notes' in op;
}

/** An image as the Studio makes it before the backend has seen it. */
export function newBoardImage(fields: Partial<MoodboardImage> & { url: string; id: string }): MoodboardImage {
  return { weight: 1, notes: '', privateNote: '', excluded: false, ...fields };
}

/** What applyOps may know beyond the ops: each dropped file's aspect
 *  (width / height, read in the browser before the upload), so its card
 *  shows at the size the server will give it. */
export interface ApplyOptions {
  aspects?: Readonly<Record<string, number>>;
}

/** `ops` applied to `images`, as the backend applies them (the cards a new
 *  image gets, and a weight's rescaled cards, come back with the board; an
 *  image added `at` a point shows a card there at once). An op naming an
 *  image or card that isn't there changes nothing. */
export function applyOps(images: MoodboardImage[], ops: MoodboardOp[], options: ApplyOptions = {}): MoodboardImage[] {
  let next = images;
  const change = (id: string, update: (image: MoodboardImage) => MoodboardImage) => {
    next = next.map((image) => (image.id === id ? update(image) : image));
  };
  for (const op of ops) {
    if (op.op === 'add') {
      const ids = new Set(next.map((image) => image.id));
      const urls = new Set(next.map((image) => image.url));
      const fresh = op.images.filter((image) => !(image.id && ids.has(image.id)) && !(op.unique && urls.has(image.url)))
        .map((image) => newBoardImage({ ...image, id: image.id ?? image.url }));
      if (op.at && fresh.length > 0 && !fresh[0].placements?.length) {
        const [w, h] = sizeFor(fresh[0].weight > 0 ? fresh[0].weight : 1, options.aspects?.[fresh[0].url] ?? Number.NaN);
        fresh[0] = { ...fresh[0], placements: [{ id: `new-${fresh[0].id}`, frameId: null, x: Math.round(op.at.x),
          y: Math.round(op.at.y), w, h, weight: fresh[0].weight > 0 ? Math.min(1, fresh[0].weight) : 1,
          placedBy: 'person', placedAt: '' }] };
      }
      const at = Math.max(0, Math.min(op.index ?? next.length, next.length));
      next = [...next.slice(0, at), ...fresh, ...next.slice(at)];
    } else if (op.op === 'remove') {
      const gone = new Set(op.images);
      next = next.filter((image) => !gone.has(image.id));
    } else if (op.op === 'weight') {
      change(op.image, (image) => ({ ...image, weight: op.value }));
    } else if (op.op === 'place') {
      next = next.map((image) => (image.placements?.some((card) => card.id === op.placement)
        ? { ...image, placements: image.placements.map((card): MoodboardPlacement => (card.id === op.placement
          ? { ...card, x: op.x, y: op.y } : card)) }
        : image));
    } else if (op.op === 'cover') {
      // A pick, not a reorder: the draft's `coverImageId` holds it (rebaseDraft).
    } else if (op.op === 'restore') {
      // Never queued: an undo goes to the server, and the board comes back with its answer.
    } else if (op.op === 'setAside') {
      // Used again from weight 0, an image weighs what its card shows.
      change(op.image, (image) => ({ ...image, excluded: op.value,
        ...(!op.value && !(image.weight > 0) ? { weight: cardWeight(image) } : {}) }));
    } else {
      change(op.image, (image) => ({ ...image, ...('notes' in op ? { notes: op.notes } : {}),
        ...('privateNote' in op ? { privateNote: op.privateNote } : {}) }));
    }
  }
  return next;
}

export const opKey = (op: MoodboardOp): string | null => {
  if (op.op === 'cover') return 'cover';
  if (op.op === 'weight' || op.op === 'setAside') return `${op.op}:${op.image}`;
  if (op.op === 'place') return `place:${op.placement}`;
  if (op.op === 'note') return `note:${op.image}:${'notes' in op ? 'notes' : ''}:${'privateNote' in op ? 'privateNote' : ''}`;
  return null;
};

/** The queue after `ops` join it: a later setting of the same thing replaces
 *  the earlier one (typing a note queues one op, not one per key), moved to
 *  the end so the latest order holds. Adds and removes always stay. */
export function queueOps(queue: MoodboardOp[] | undefined, ops: MoodboardOp[]): MoodboardOp[] {
  let next = [...(queue ?? [])];
  for (const op of ops) {
    const key = opKey(op);
    if (key) next = next.filter((queued) => opKey(queued) !== key);
    next.push(op);
  }
  return next;
}

/** The ops a Studio image change becomes. */
export function imagePatchOps(id: string, patch: Partial<MoodboardImage>): MoodboardOp[] {
  const ops: MoodboardOp[] = [];
  if ('excluded' in patch) ops.push({ op: 'setAside', image: id, value: Boolean(patch.excluded) });
  // Using an image again from weight 0 sets its weight on the server, from its card.
  if ('weight' in patch && !('excluded' in patch && patch.excluded === false)) {
    ops.push({ op: 'weight', image: id, value: Number(patch.weight) });
  }
  if ('notes' in patch) ops.push({ op: 'note', image: id, notes: patch.notes ?? '' });
  if ('privateNote' in patch) ops.push({ op: 'note', image: id, privateNote: patch.privateNote ?? '' });
  return ops;
}

/** The board fields a Studio PUT may carry (plan section 4.9), plus the
 *  analysis, which it only ever clears. */
export const BOARD_FIELD_KEYS = ['name', 'notes', 'mode', 'strength', 'direction', 'avoid', 'pinnedColors',
  'briefOverride', 'clashMode', 'colorChoices', 'sendNotes', 'analysis'] as const;
export type BoardFieldKey = typeof BOARD_FIELD_KEYS[number];

export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The board fields of `draft` that differ from `base` (both as the Studio
 *  holds a board). The analysis is sent only as null: the Studio clears it
 *  when the person changes what it reads, and never writes one. */
export function fieldChanges<D extends Partial<Record<BoardFieldKey, unknown>>>(base: D, draft: D): Partial<D> {
  const out: Partial<D> = {};
  for (const key of BOARD_FIELD_KEYS) {
    if (!(key in draft) || sameValue(draft[key], base[key])) continue;
    if (key === 'analysis') {
      if (draft.analysis == null) (out as Record<string, unknown>).analysis = null;
      continue;
    }
    (out as Record<string, unknown>)[key] = draft[key];
  }
  return out;
}

/** Three-way: each board field the person changed since `oldBase` keeps their
 *  value; every other field takes `newBase`'s. */
export function mergeFields<D extends Partial<Record<BoardFieldKey, unknown>>>(draft: D, oldBase: D, newBase: D): D {
  const out = { ...draft };
  for (const key of BOARD_FIELD_KEYS) {
    if (sameValue(draft[key], oldBase[key])) (out as Record<string, unknown>)[key] = newBase[key];
  }
  return out;
}

/** What the Studio keeps beside a saved board's draft: the board fields as
 *  last read (`base`), that board's `version`, and the ops not yet confirmed. */
export interface QueuedDraft {
  images: MoodboardImage[];
  /** The board's cover as last read, with a queued pick on top. */
  coverImageId?: string | null;
  analysis?: unknown;
  base?: Partial<Record<BoardFieldKey, unknown>>;
  version?: number;
  pendingOps?: MoodboardOp[];
}

/** `draft` moved onto `board` (read again, or what a write answered; `fields`
 *  is its board fields as the draft holds them): the ops it confirmed
 *  (`sent`) leave the queue, the rest replay on its images, and each board
 *  field takes the board's value unless the person changed it since the last
 *  read. A queued op on an image that is no longer there (someone removed
 *  it) is dropped: the server would refuse the whole batch for it. The
 *  analysis stays cleared while a queued op would clear it. */
export function rebaseDraft<D extends QueuedDraft>(draft: D,
  board: { images: MoodboardImage[]; version?: number; coverImageId?: string | null },
  fields: Partial<Record<BoardFieldKey, unknown>>, sent: ReadonlySet<MoodboardOp> = new Set()): D {
  const pendingOps: MoodboardOp[] = [];
  let images = [...board.images];
  // The cover is the board's, with the person's queued pick on top. Back to
  // #1 (`image: null`) names no image, so it is never dropped.
  let coverImageId = board.coverImageId ?? null;
  for (const op of draft.pendingOps ?? []) {
    if (sent.has(op)) continue;
    if ('image' in op && op.image !== null && !images.some((image) => image.id === op.image)) continue;
    if (op.op === 'place' && !images.some((image) => image.placements?.some((card) => card.id === op.placement))) continue;
    pendingOps.push(op);
    images = applyOps(images, [op]);
    if (op.op === 'cover') coverImageId = op.image;
  }
  // A queued remove that takes the cover image opens the board on #1, as the server does.
  if (coverImageId !== null && !images.some((image) => image.id === coverImageId)) coverImageId = null;
  const merged = draft.base ? mergeFields(draft as Partial<Record<BoardFieldKey, unknown>>, draft.base, fields) as D : draft;
  return { ...merged, images, coverImageId, base: fields, version: board.version, pendingOps,
    ...(pendingOps.some(opSteers) ? { analysis: null } : {}) };
}
