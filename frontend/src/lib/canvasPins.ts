import type { InternalNode, Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { apiRequest } from './apiRequest';
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
const plain = (line: string) => line.replace(/[\t\n\r]/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '');

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
  if (!multiline) return plain(raw).split(/\s+/).filter(Boolean).join(' ');
  const lines = raw.split(LINE_BREAKS).map((line) => plain(line).replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const joined = lines.join('\n');
  return fold ? joined.replace(/\n(?:\n)+/g, '\n') : joined;
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

