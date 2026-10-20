/**
 * The Moodboard bundle a run sends downstream (backend/handlers/moodboard.py),
 * read for display. Every field is optional and a field of the wrong shape is
 * dropped, so an old run, an agent-written value or a cut-short one still
 * shows what it has. Only the brief's own `palette` and `accents` are read
 * (kept-out colours already removed), never the raw analysis's.
 */

export interface MoodboardBundleImage {
  url: string;
  weight: number | null;
}

/** One colour the brief left out or flagged (services/moodboard_brief.py
 *  compose). `hex` is null only for a whole-palette finding, such as a cast. */
export interface MoodboardBundleClash {
  hex: string | null;
  /** null: a colour pinned to keep out, not a measured one. */
  role: 'palette' | 'accent' | 'pinned' | null;
  /** Every reason, the first one first ("Avoid: red flowers"). */
  reasons: string[];
}

export type MoodboardBundleClashMode = 'leave-out' | 'flag' | 'no-measured' | 'keep-all';

export interface MoodboardBundleView {
  name: string;
  mode: string | null;
  /** 0..1, or null when the bundle has none. */
  strength: number | null;
  images: MoodboardBundleImage[];
  /** URLs, representative ones first, then the rest of the board, no repeats. */
  thumbnails: string[];
  palette: string[];
  accents: string[];
  styleBrief: string;
  notes: string;
  avoid: string[];
  excludedColors: string[];
  /** The board's (or node's) notes opt-in; null on a bundle from before it. */
  notesSent: boolean | null;
  /** Whether the bundle carries the clash lists below (a run after #90). */
  clashChecked: boolean;
  leftOut: MoodboardBundleClash[];
  /** Still sent; in `flag` mode, every clash. */
  mayClash: MoodboardBundleClash[];
  kept: MoodboardBundleClash[];
  pinnedClashes: MoodboardBundleClash[];
  paletteClashes: MoodboardBundleClash[];
  clashMode: MoodboardBundleClashMode | null;
  overrideActive: boolean;
  overrideStale: boolean;
  warnings: string[];
}

/** Longest brief kept for display (the backend caps a hand-written one at
 *  20000 characters; anything longer came from somewhere odd). */
export const BRIEF_DISPLAY_LIMIT = 20_000;
const LIST_LIMIT = 200;
const REASON_LIMIT = 300;
const REASONS_LIMIT = 8;
const CLASH_MODES: readonly MoodboardBundleClashMode[] = ['leave-out', 'flag', 'no-measured', 'keep-all'];
const CLASH_ROLES = ['palette', 'accent', 'pinned'] as const;
export const KEEP_OUT_REASON = 'Pinned to keep out';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
    if (out.length >= LIST_LIMIT) break;
  }
  return out;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: unknown): boolean {
  return typeof value === 'string' && HEX.test(value.trim());
}

function hexList(value: unknown): string[] {
  return strList(value).filter(isHexColor);
}

function reasonText(value: unknown): string {
  const text = str(value).trim();
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}…` : text;
}

/** A clash list. Entries need a valid hex (or, with `wholePalette`, none at
 *  all); reasons fall back to the single `reason`, as the Studio's do. */
function clashList(value: unknown, wholePalette = false): MoodboardBundleClash[] {
  if (!Array.isArray(value)) return [];
  const out: MoodboardBundleClash[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const hex = isHexColor(item.hex) ? str(item.hex).trim().toLowerCase() : null;
    if (hex === null && !(wholePalette && item.hex == null)) continue;
    const listed = Array.isArray(item.reasons) ? item.reasons.map(reasonText).filter(Boolean) : [];
    const reasons = (listed.length ? listed : [reasonText(item.reason)].filter(Boolean)).slice(0, REASONS_LIMIT);
    const role = CLASH_ROLES.find((known) => known === item.role) ?? 'palette';
    out.push({ hex, role, reasons });
    if (out.length >= LIST_LIMIT) break;
  }
  return out;
}

/** Whether a port value is a Nebula Moodboard bundle (and not, say, Krea's
 *  `{kind: 'krea_moodboard'}` reference). */
export function isMoodboardBundle(type: string | undefined, value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'nebula_moodboard') return true;
  return type === 'Moodboard' && value.kind === undefined;
}

export function parseMoodboardBundle(value: unknown): MoodboardBundleView | null {
  if (!isRecord(value)) return null;
  const images: MoodboardBundleImage[] = [];
  if (Array.isArray(value.images)) {
    for (const item of value.images) {
      if (!isRecord(item) || item.excluded === true) continue;
      const url = str(item.url).trim();
      if (!url) continue;
      images.push({ url, weight: typeof item.weight === 'number' && Number.isFinite(item.weight) ? item.weight : null });
      if (images.length >= LIST_LIMIT) break;
    }
  }
  const representative = strList(value.representativeImages);
  const thumbnails = [...new Set([...representative, ...images.map((image) => image.url)])];
  const strengthRaw = value.strength;
  const strength = typeof strengthRaw === 'number' && Number.isFinite(strengthRaw)
    ? Math.min(1, Math.max(0, strengthRaw)) : null;
  const pinned = isRecord(value.pinnedColors) ? value.pinnedColors : {};
  const override = isRecord(value.briefOverride) ? value.briefOverride : {};
  const analysis = isRecord(value.analysis) ? value.analysis : {};
  const brief = str(value.styleBrief).trim();
  return {
    name: str(value.name).trim() || 'Untitled board',
    mode: str(value.mode).trim() || null,
    strength,
    images,
    thumbnails,
    palette: hexList(value.palette),
    accents: hexList(value.accents),
    styleBrief: brief.length > BRIEF_DISPLAY_LIMIT ? `${brief.slice(0, BRIEF_DISPLAY_LIMIT)}…` : brief,
    notes: str(value.notes).trim(),
    avoid: strList(value.avoid),
    excludedColors: hexList(pinned.exclude),
    notesSent: typeof value.notesSent === 'boolean' ? value.notesSent : null,
    clashChecked: Array.isArray(value.leftOut),
    leftOut: clashList(value.leftOut),
    mayClash: clashList(value.mayClash),
    kept: clashList(value.kept),
    pinnedClashes: clashList(value.pinnedClashes),
    paletteClashes: clashList(value.paletteClashes, true).filter((item) => item.hex === null),
    clashMode: CLASH_MODES.find((mode) => mode === value.clashMode) ?? null,
    overrideActive: override.active === true,
    overrideStale: override.stale === true,
    warnings: strList(analysis.warnings),
  };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The board's settings line: "look · 70% · 5 images". */
export function moodboardMeta(bundle: MoodboardBundleView): string {
  const parts: string[] = [];
  if (bundle.mode) parts.push(bundle.mode);
  if (bundle.strength !== null) parts.push(`${Math.round(bundle.strength * 100)}%`);
  parts.push(plural(bundle.images.length, 'image'));
  return parts.join(' · ');
}

/** Every colour generators didn't get: the brief's `leftOut` and the
 *  board's keep-out pins (removed before the check runs, so never in
 *  `leftOut`; counted once all the same). */
export function moodboardLeftOut(bundle: MoodboardBundleView): MoodboardBundleClash[] {
  const out = [...bundle.leftOut];
  const seen = new Set(out.map((item) => item.hex));
  for (const hex of bundle.excludedColors) {
    const key = hex.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hex: key, role: null, reasons: [KEEP_OUT_REASON] });
  }
  return out;
}

/** What a generator reads of the board's notes. Since #90 the bundle says
 *  (`notesSent`, the board's or node's opt-in) and carries `notes` only when
 *  they go, so with the switch off it can't tell kept-back notes from none:
 *  "Notes off" names the switch. They go with the board either way, but only a generated brief
 *  has them in its text: a hand-written one is what the prompt gets, as is.
 *  An older bundle always carried notes, and they reached generators only
 *  inside the generated brief (none without an analysis). */
function notesStatus(bundle: MoodboardBundleView): string {
  if (bundle.notesSent === false) return 'Notes off';
  if (!bundle.notes) return 'No notes';
  if (bundle.notesSent === true) return bundle.overrideActive ? 'Notes sent, not in the brief' : 'Notes sent';
  return bundle.overrideActive || !bundle.styleBrief ? 'Notes not sent' : 'Notes sent';
}

/** What the run sent besides the brief, one short phrase each, in the
 *  Studio's words (MoodboardBrief.tsx BriefClashes). */
export function moodboardStatus(bundle: MoodboardBundleView): string[] {
  const status: string[] = [notesStatus(bundle)];
  if (bundle.overrideActive) status.push(bundle.overrideStale ? 'Brief written by hand, out of date' : 'Brief written by hand');
  const leftOut = moodboardLeftOut(bundle).length;
  if (leftOut > 0) status.push(`${plural(leftOut, 'color')} left out`);
  if (bundle.mayClash.length > 0) {
    status.push(`${bundle.mayClash.length} ${bundle.clashMode === 'flag' ? 'flagged' : 'may clash'}`);
  }
  const pinned = bundle.pinnedClashes.length;
  if (pinned > 0) status.push(`${plural(pinned, 'pinned color')} ${pinned === 1 ? 'clashes' : 'clash'}`);
  if (bundle.clashChecked && bundle.clashMode === 'keep-all') status.push('Clash check is off');
  if (bundle.avoid.length > 0) status.push(`Avoids ${plural(bundle.avoid.length, 'thing')}`);
  if (bundle.warnings.length > 0) status.push(bundle.warnings[0]);
  return status;
}
