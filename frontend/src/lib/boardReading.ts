import { apiRequest } from './apiRequest';
import { storedImageView } from './storedImage';
import type { MoodboardImage } from '../types';

/**
 * Read the board (backend services/board_reading.py): Gemini 4 Argon's
 * whole-board style report, saved with the board. This file holds the shapes
 * the backend sends, its four routes, and the words around the report (GM's
 * surface design, 2026-10-31): the route and cost lines, the staleness line,
 * the locks and the failures. The report itself is Gemini's prose and is
 * shown unedited (lib/readingMarkdown.ts).
 */

export type ReadingRoute = 'antigravity' | 'gemini_key';

export interface BoardReading {
  id: string;
  /** Gemini's answer, as it wrote it: citations are the file names it was sent. */
  markdown: string;
  model: string;
  modelName: string;
  route: ReadingRoute;
  /** ISO time it landed. */
  at: string;
  by: { kind: 'person' | 'agent'; name?: string; acceptedFrom?: string };
  imageSet: { fingerprint: string; images: Array<{ id: string; hash: string | null; url: string }> };
  /** Every image sent: its tile id, its number when read, the name it went under. */
  citations: Array<{ imageId: string; number: number; file: string }>;
  /** The tile ids the markdown cites. */
  cited: string[];
  cost?: { low: number | null; high: number | null; unconfirmed?: boolean; unpriced?: boolean };
}

export type ReadingRunStatus = 'running' | 'done' | 'failed' | 'stopped';
export type ReadingCause = 'timeout' | 'signed_out' | 'plan_limit' | 'key_refused' | 'write_attempt'
  | 'not_installed' | 'no_key' | 'no_images' | 'other';

export interface BoardReadingRun {
  id: string;
  boardId: string;
  status: ReadingRunStatus;
  route: ReadingRoute;
  count: number;
  by: { kind: 'person' | 'agent'; name?: string; id?: string | null; acceptedFrom?: string };
  /** ms since the epoch. */
  startedAt: number;
  elapsedMs: number;
  cause: ReadingCause | null;
  readingId: string | null;
}

export interface BoardReadingRouteState {
  antigravity: { installed: boolean; signedIn: boolean };
  hasKey: boolean;
  /** Where a read would run now; null when neither route can. */
  route: ReadingRoute | null;
  /** How many images a read sends. */
  count: number;
  model: { id: string; name: string };
  /** The key route's list price for `count` images. */
  estimate: { low: number | null; high: number | null; unpriced: boolean; unconfirmed: boolean };
}

export interface BoardReadingStale {
  stale: boolean;
  added: string[];
  removed: string[];
  setAside: string[];
  replaced: string[];
}

export interface BoardReadingState {
  reading: BoardReading | null;
  markdown: string | null;
  tiles: Array<{ number: number; imageId: string; file: string; onBoard: boolean; cited: boolean }>;
  stale: BoardReadingStale | null;
  hasPrevious: boolean;
  run: BoardReadingRun | null;
  route: BoardReadingRouteState;
}

/** The socket's word that a read started, landed, failed or stopped (backend main._board_reading_broadcast). */
export interface BoardReadingRunEvent {
  type: 'boardReadingRun';
  boardId: string;
  run: BoardReadingRun;
}

const base = (boardId: string) => `/api/moodboards/${encodeURIComponent(boardId)}/reading`;

export async function fetchBoardReading(boardId: string): Promise<BoardReadingState> {
  const response = await apiRequest("Couldn't load the reading.", base(boardId));
  return response.json() as Promise<BoardReadingState>;
}

export async function startBoardReading(boardId: string, route: 'auto' | ReadingRoute = 'auto')
  : Promise<{ status: 'running'; run: BoardReadingRun }> {
  const response = await apiRequest(READING_FAILED_HEADING, base(boardId), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ route }) });
  return response.json() as Promise<{ status: 'running'; run: BoardReadingRun }>;
}

export async function stopBoardReading(boardId: string): Promise<void> {
  await apiRequest("Couldn't stop the read.", `${base(boardId)}/stop`, { method: 'POST' });
}

export async function undoBoardReading(boardId: string, readingId: string): Promise<void> {
  await apiRequest("Couldn't put the earlier reading back.", `${base(boardId)}/undo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readingId }) });
}

// -- GM's words -----------------------------------------------------------------------------------

export const READING_HEADING = 'Reading';
export const READING_INTRO = 'Gemini looks at every image on this board and writes what the style is, what makes it distinctive and why it works.';
export const READ_BUTTON = 'Read the board';
export const READ_AGAIN = 'Read again';
export const READING_FAILED_HEADING = 'Nebula couldn’t read the board';
export const REPLACED_TOAST = 'Replaced the reading';
export const LOCKED_NO_IMAGES = 'You can read the board after you add images.';
export const LOCKED_NO_ROUTE = 'You can read the board after you sign in to Antigravity on this Mac or add a Gemini API key in Settings.';
export const LOCKED_NO_ROUTE_NOT_INSTALLED = 'You can read the board after you install Antigravity and sign in, or add a Gemini API key in Settings.';
const FALLBACK = 'Try again, or reload if it keeps happening.';

export const FAILURE_COPY: Partial<Record<ReadingCause, string>> = {
  timeout: 'Gemini didn’t answer in time. Try again.',
  signed_out: 'Antigravity signed out during the read. Sign in again, then try again.',
  plan_limit: 'Your Antigravity plan has reached its limit for now. Try again later, or use your Gemini API key.',
  key_refused: 'Google refused your Gemini API key. Check it in Settings, then try again.',
};

export function failureBody(cause: ReadingCause | null | undefined): string {
  return (cause && FAILURE_COPY[cause]) || FALLBACK;
}

/** "About $0.14": the key route's list price (its high end), to the cent, never below a cent. */
export function aboutPrice(high: number | null | undefined): string | null {
  if (typeof high !== 'number' || !Number.isFinite(high)) return null;
  return `About $${Math.max(0.01, Math.round(high * 100) / 100).toFixed(2)}`;
}

/** "~$0.14", for the proposal's detail line. */
export function shortPrice(high: number | null | undefined): string | null {
  const about = aboutPrice(high);
  return about ? `~${about.slice('About '.length)}` : null;
}

const imagesWord = (count: number) => `${count} ${count === 1 ? 'image' : 'images'}`;

/** The small line under the button: where the read goes and what it costs (GM section 5),
 *  or the lock when it can't run (section 7). */
export function routeLine(route: BoardReadingRouteState): { text: string; locked: boolean } {
  if (route.count === 0) return { text: LOCKED_NO_IMAGES, locked: true };
  const price = aboutPrice(route.estimate.high);
  const cost = price ? ` ${price}.` : '';
  if (route.route === 'antigravity') {
    return { text: `Sends ${imagesWord(route.count)} to Google through your Antigravity sign-in. Free with your plan.`, locked: false };
  }
  if (route.route === 'gemini_key') {
    if (route.antigravity.installed && !route.antigravity.signedIn) {
      return { text: `Antigravity isn’t signed in, so this uses your Gemini API key.${cost}`, locked: false };
    }
    return { text: `Sends ${imagesWord(route.count)} to Google with your Gemini API key.${cost}`, locked: false };
  }
  return { text: route.antigravity.installed ? LOCKED_NO_ROUTE : LOCKED_NO_ROUTE_NOT_INSTALLED, locked: true };
}

/** "Gemini 4 Argon’s reading · Nov 1, 3:40 PM · 15 images" (in the viewer's own time). */
export function metaLine(reading: BoardReading, locale?: string): string {
  const when = new Date(reading.at);
  const date = Number.isNaN(when.getTime()) ? reading.at
    : `${when.toLocaleDateString(locale ?? 'en-US', { month: 'short', day: 'numeric' })}, ${when.toLocaleTimeString(
      locale ?? 'en-US', { hour: 'numeric', minute: '2-digit' })}`;
  return `${reading.modelName}’s reading · ${date} · ${imagesWord(reading.citations.length)}`;
}

/** "Reading 15 images · " (the elapsed time follows in mono). */
export function runningLine(count: number): string {
  return `Reading ${imagesWord(count)} · `;
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// -- staleness ------------------------------------------------------------------------------------

function sendable(image: MoodboardImage): boolean {
  const weight = Number(image.weight);
  return !image.excluded && Number.isFinite(weight) && weight > 0 && Boolean(storedImageView(image.url).src);
}

/** How the image set moved since the reading, from the board as the Studio
 *  holds it now (so a removal shows before it saves), plus the files the
 *  server saw replaced on disk. Notes and Direction never count. */
export function staleness(reading: BoardReading, images: MoodboardImage[], serverReplaced: string[] = [])
  : BoardReadingStale {
  const then = new Map(reading.imageSet.images.map((entry) => [entry.id, entry]));
  const onBoard = new Map(images.map((image) => [image.id, image]));
  const now = images.filter(sendable);
  const nowIds = new Set(now.map((image) => image.id));
  const added = now.filter((image) => !then.has(image.id)).map((image) => image.id);
  const removed = [...then.keys()].filter((id) => !nowIds.has(id) && !onBoard.has(id));
  const setAside = [...then.keys()].filter((id) => !nowIds.has(id) && onBoard.has(id));
  const replaced = now.filter((image) => then.has(image.id)
    && (then.get(image.id)!.url !== image.url || serverReplaced.includes(image.id))).map((image) => image.id);
  return { stale: added.length + removed.length + setAside.length + replaced.length > 0, added, removed, setAside, replaced };
}

/** "The board changed after this reading. 2 images were added and 1 was removed."
 *  Only the clauses that apply; the first names images, the rest only count them. */
export function staleLine(stale: BoardReadingStale): string {
  const clauses = ([['added', stale.added.length], ['removed', stale.removed.length],
    ['set aside', stale.setAside.length], ['replaced', stale.replaced.length]] as const).filter(([, count]) => count > 0);
  const parts = clauses.map(([verb, count], index) => {
    const be = count === 1 ? 'was' : 'were';
    return index === 0 ? `${imagesWord(count)} ${be} ${verb}` : `${count} ${be} ${verb}`;
  });
  const joined = parts.length <= 1 ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `The board changed after this reading. ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

// -- citations ------------------------------------------------------------------------------------

export interface Citation {
  imageId: string;
  /** The tile's number now, or its number when read for one no longer on the board. */
  number: number;
  onBoard: boolean;
  url: string | null;
}

/** File name (lower case) to the tile it names, numbered as the board is now. */
export function citationMap(reading: BoardReading, images: MoodboardImage[]): Map<string, Citation> {
  const index = new Map(images.map((image, i) => [image.id, { number: i + 1, url: image.url }]));
  return new Map(reading.citations.map((entry) => {
    const now = index.get(entry.imageId);
    return [entry.file.toLowerCase(), { imageId: entry.imageId, number: now?.number ?? entry.number,
      onBoard: Boolean(now), url: now?.url ?? null }];
  }));
}

export const CITATION_PATTERN = /(?:images\/)?(tile-[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif))/gi;

/** The markdown as Copy gives it: each citation as #N (a tile no longer on the board says so). */
export function copyText(reading: BoardReading, images: MoodboardImage[]): string {
  const map = citationMap(reading, images);
  return reading.markdown.replace(/`?(?:images\/)?(tile-[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif))`?/gi, (whole, name: string) => {
    const cite = map.get(name.toLowerCase());
    if (!cite) return whole;
    return cite.onBoard ? `#${cite.number}` : `#${cite.number} (removed from the board)`;
  });
}

// -- an agent's proposal (key route only) ---------------------------------------------------------

type ReadChange = { modelName?: string; images?: number; cost?: { high?: number | null } | null } | true | undefined;

/** "Read the board with Gemini 4 Argon" (GM section 6). */
export function readProposalLine(change: ReadChange): string {
  const name = typeof change === 'object' && change.modelName ? change.modelName : 'Gemini 4 Argon';
  return `Read the board with ${name}`;
}

/** "Sends 15 images to Google · ~$0.05" (the price only when the catalog has one). */
export function readProposalDetail(change: ReadChange): string {
  const count = typeof change === 'object' && typeof change.images === 'number' ? change.images : null;
  const price = typeof change === 'object' ? shortPrice(change.cost?.high) : null;
  const sends = count === null ? 'Sends the board’s images to Google' : `Sends ${imagesWord(count)} to Google`;
  return price ? `${sends} · ${price}` : sends;
}
