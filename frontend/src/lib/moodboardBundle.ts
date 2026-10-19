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
  overrideActive: boolean;
  overrideStale: boolean;
  warnings: string[];
}

/** Longest brief kept for display (the backend caps a hand-written one at
 *  20000 characters; anything longer came from somewhere odd). */
export const BRIEF_DISPLAY_LIMIT = 20_000;
const LIST_LIMIT = 200;

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

/**
 * What the run sent besides the brief, one short phrase each. Board notes
 * reach generators inside the generated brief (services/moodboard_brief.py
 * generated_brief), so a hand-written brief leaves them out.
 */
export function moodboardStatus(bundle: MoodboardBundleView): string[] {
  const status: string[] = [];
  if (bundle.notes) status.push(bundle.overrideActive ? 'Notes not sent' : 'Notes sent');
  else status.push('No notes');
  if (bundle.overrideActive) status.push(bundle.overrideStale ? 'Brief written by hand, out of date' : 'Brief written by hand');
  if (bundle.excludedColors.length > 0) status.push(`${plural(bundle.excludedColors.length, 'color')} left out`);
  if (bundle.avoid.length > 0) status.push(`Avoids ${plural(bundle.avoid.length, 'thing')}`);
  if (bundle.warnings.length > 0) status.push(bundle.warnings[0]);
  return status;
}
