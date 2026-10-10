import type { InternalNode, Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { apiFetch } from './backend';
import type { Pin } from './wsClient';

export type { Pin } from './wsClient';

/** Matches the backend cap (services/canvas_pins.MAX_PIN_TEXT). */
export const MAX_PIN_TEXT = 280;

export type PinTarget = { nodeId: string } | { position: { x: number; y: number } };

export interface PinListing {
  projectId: string | null;
  pins: Pin[];
}

async function detailOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string' && body.detail) return body.detail;
  } catch {
    /* not JSON */
  }
  return fallback;
}

export async function fetchPins(): Promise<PinListing> {
  const response = await apiFetch('/api/canvas/pins');
  if (!response.ok) throw new Error(await detailOf(response, `Couldn't load notes (${response.status})`));
  return (await response.json()) as PinListing;
}

export async function createPin(text: string, target: PinTarget): Promise<Pin> {
  const response = await apiFetch('/api/canvas/pins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...target }),
  });
  if (!response.ok) throw new Error(await detailOf(response, `Couldn't save the note (${response.status})`));
  return ((await response.json()) as { pin: Pin }).pin;
}

export async function deletePin(id: string): Promise<void> {
  const response = await apiFetch(`/api/canvas/pins/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await detailOf(response, `Couldn't delete the note (${response.status})`));
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

