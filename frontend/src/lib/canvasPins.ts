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
 *   "Your note wasn't sent because the canvas changed first."
 *   A follow started: "Your note wasn't sent because Codex started opening
 *    “Second canvas”." ("an agent" when the agent isn't known).
 * The note itself on its own line, in quotes, clamped to 2 lines with "…";
 * "Copy note" copies the full text; "Copy note" and × stay.
 */
export const NOTE_KEPT_LINE = "Your note wasn't sent because the canvas changed first.";
export const NOTE_KEPT_COPY = 'Copy note';

/** The kept note's line: why it wasn't sent. `following`: the follow that
 * closed the dialog (or was on when Nebula refused the note). */
export function noteKeptLine(following: { agent: string | null; projectName: string } | null): string {
  if (!following || !following.projectName) return NOTE_KEPT_LINE;
  return `Your note wasn't sent because ${following.agent || 'an agent'} started opening “${following.projectName}”.`;
}

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

