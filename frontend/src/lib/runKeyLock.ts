import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition } from '../types';
import { keyPhrase, routeMissingKeyLine, selectRoute, type ApiKeys } from './directRoute';

/**
 * A route that can't run without its key says so in its own words
 * (RouteSpec.missingKeyLine; Idol without a Hugging Face token, GM PR #203
 * r4): Run is locked with that line as its reason, so a sure-to-fail run is
 * never sent. The backend refuses agent and CLI runs with the same line
 * (node_route.route_unavailable_line). Until Settings load, nothing locks.
 */
export function routeKeyLockReason(
  definition: ModelNodeDefinition | undefined,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
): string | null {
  return routeKeyLock(definition, params, apiKeys)?.line ?? null;
}

interface RouteKeyLock {
  /** The route's own line (the node card's). */
  line: string;
  /** The keys it is missing. */
  keys: string[];
}

function routeKeyLock(
  definition: ModelNodeDefinition | undefined,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
): RouteKeyLock | null {
  if (!definition?.routes?.length) return null;
  const route = selectRoute(definition, params ?? {}, apiKeys);
  if (route.kind !== 'unset') return null;
  const line = routeMissingKeyLine(definition, route);
  return line ? { line, keys: route.missing ?? [] } : null;
}

interface LockableNode {
  id: string;
  data: { definitionId: string; params?: Record<string, unknown> };
}

interface LockSettings {
  loaded: boolean;
  apiKeys: ApiKeys;
}

function firstLock(nodes: readonly LockableNode[], ids: readonly string[] | null, settings: LockSettings): RouteKeyLock | null {
  if (!settings.loaded) return null;
  const candidates = ids === null ? nodes : ids.map((id) => nodes.find((node) => node.id === id));
  for (const node of candidates) {
    if (!node) continue;
    const lock = routeKeyLock(NODE_DEFINITIONS[node.data.definitionId], node.data.params, settings.apiKeys);
    if (lock) return lock;
  }
  return null;
}

/** The first of these nodes' lock reasons (the node's own line), or null
 * when all can run. */
export function nodesKeyLockReason(
  nodes: readonly LockableNode[],
  ids: readonly string[],
  settings: LockSettings,
): string | null {
  return firstLock(nodes, ids, settings)?.line ?? null;
}

/**
 * GM, PR #203 r6 item 1: nothing on the canvas runs until the key is added.
 * The toolbar's Run, Cmd+Enter and the palette's "Run graph" say it for the
 * canvas ("You can run this canvas after you add your Hugging Face token in
 * Settings."); the node card keeps its own line, so the person sees which
 * node needs it. Null when every node can run.
 */
export function canvasKeyLockReason(nodes: readonly LockableNode[], settings: LockSettings): string | null {
  const lock = firstLock(nodes, null, settings);
  if (!lock) return null;
  const phrase = keyPhrase(lock.keys);
  return phrase ? `You can run this canvas after you add your ${phrase} in Settings.` : lock.line;
}

/** GM, PR #203 r6 item 1: a proposal whose run needs the key can't be
 * accepted yet ("You can accept this after you add your Hugging Face token in
 * Settings."), for one of its run nodes at the values Accept would run. The
 * backend still refuses the run if it is sent. Null when it can run. */
export function acceptKeyLockLine(
  definition: ModelNodeDefinition | undefined,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
): string | null {
  const lock = routeKeyLock(definition, params, apiKeys);
  if (!lock) return null;
  const phrase = keyPhrase(lock.keys);
  return phrase ? `You can accept this after you add your ${phrase} in Settings.` : lock.line;
}

/** The mark a Run locked by a missing key carries: the shared not-allowed
 * cursor (styles/disabled-buttons.css), on every surface the same. */
export const KEY_LOCK_MARK = 'data-key-locked';

export interface KeyLockedProps {
  'aria-disabled'?: true;
  'aria-describedby'?: string;
  'data-key-locked'?: '';
}

/**
 * A Run locked by a missing key, as the toolbar's Run is while the tab
 * follows an agent's switch (Toolbar.tsx, round 20 GM follow-up 3):
 * `aria-disabled`, never natively disabled, so it keeps its focus and its
 * tooltip, and its accessible description is the lock line (`reasonId`, an
 * element holding it). The caller's click handler refuses while locked.
 * Empty when not locked: the control's own description stays.
 */
export function keyLockedProps(reason: string | null, reasonId: string): KeyLockedProps {
  if (!reason) return {};
  return { 'aria-disabled': true, 'aria-describedby': reasonId, [KEY_LOCK_MARK]: '' };
}
