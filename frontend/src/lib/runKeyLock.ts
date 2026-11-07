import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition, NodeData } from '../types';
import { keyPhrase, routeMissingKeyLine, selectRoute, type ApiKeys } from './directRoute';
import { nodesThatRun, type RunScope } from './runScope';
import { FOLLOWING_MARK } from './canvasLock';
import { OFFLINE_MARK, OFFLINE_NEUTRAL } from './useBackendOffline';

/**
 * A route that can't run without its key says so in its own words
 * (RouteSpec.missingKeyLine: a keyed route without its key, GM PR #203
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

/** Whether a node of this kind can ever be locked for a missing key: one of
 * its routes has its own missing-key line (routeMissingKeyLine). A cheap
 * test before reading a whole run's plan. */
export function canKeyLock(definitionId: string | undefined): boolean {
  return Boolean(definitionId && NODE_DEFINITIONS[definitionId]?.routes?.some((route) => Boolean(route.missingKeyLine)));
}

interface LockableNode {
  id: string;
  data?: { definitionId: string; params?: Record<string, unknown> };
}

export interface LockSettings {
  loaded: boolean;
  apiKeys: ApiKeys;
}

function firstLock(nodes: readonly LockableNode[], ids: readonly string[] | null, settings: LockSettings): RouteKeyLock | null {
  if (!settings.loaded) return null;
  const candidates = ids === null ? nodes : ids.map((id) => nodes.find((node) => node.id === id));
  for (const node of candidates) {
    if (!node) continue;
    const definitionId = node.data?.definitionId;
    if (!definitionId) continue;
    const lock = routeKeyLock(NODE_DEFINITIONS[definitionId], node.data?.params, settings.apiKeys);
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

/**
 * The one lock line for a run of `scope`, over exactly the nodes that run
 * would run (nodesThatRun: a graph run skips agents' placeholders and what
 * needs them, as the backend's _skip_placeholders does; a node's own run
 * takes what feeds it). The whole graph says the canvas's line, a node or a
 * selection the node's own. Every Run surface and every store run path use
 * this, so the toolbar can't lock a canvas Cmd+Enter would run (review r4
 * MEDIUM-1). Null when that run can go.
 */
export function runKeyLockLine(
  nodes: readonly Node<NodeData>[],
  edges: readonly Edge[],
  scope: RunScope,
  settings: LockSettings,
): string | null {
  if (!settings.loaded) return null;
  const running = nodesThatRun([...nodes], [...edges], scope);
  return scope.kind === 'graph' ? canvasKeyLockReason(running, settings)
    : nodesKeyLockReason(running, running.map((node) => node.id), settings);
}

/** runKeyLockLine's rule with the node's own line for every scope ("You can
 * run X after you add your Hugging Face token in Settings."): a Run
 * History replay and the deferred "Run now" say which node needs the key
 * (GM, PR #203 r8 item 3). */
export function runKeyLockNodeLine(
  nodes: readonly Node<NodeData>[],
  edges: readonly Edge[],
  scope: RunScope,
  settings: LockSettings,
): string | null {
  if (!settings.loaded) return null;
  const running = nodesThatRun([...nodes], [...edges], scope);
  return nodesKeyLockReason(running, running.map((node) => node.id), settings);
}

/** GM, PR #203 r6 item 1: Accept's line when one of the nodes its run would
 * run can't start without its key ("You can accept this after you add your
 * Hugging Face token in Settings."); lib/proposalAcceptLock reads which nodes
 * those are. Null when they can all run. */
export function acceptKeyLockPhraseLine(nodes: readonly LockableNode[], settings: LockSettings): string | null {
  const lock = firstLock(nodes, null, settings);
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

/** The marks the canvas lock puts on a control it holds (lib/canvasLock):
 * a press on one pulses the project bar or the offline banner. A key-locked
 * control drops them, so the press and the tooltip name the same reason
 * (PR #198 M2). */
const CANVAS_LOCK_MARKS = [FOLLOWING_MARK, OFFLINE_MARK, OFFLINE_NEUTRAL] as const;

/**
 * One order for a control that the canvas lock and the key lock can both
 * hold. The rule (GM, PR #203 r11 item 3): a reason only the person can fix
 * comes before reasons that clear by themselves, or the person waits out the
 * run only to be refused. So the missing key comes first, then the run in
 * progress, then following, then offline (lib/canvasLock `act`, in its own
 * order), then the control's own disabled state and title.
 *
 * A control with a missing key is key-locked whatever else holds it:
 * `aria-disabled`, never natively disabled, so it keeps its focus and
 * tooltip; the key line is its title and description, and the canvas lock's
 * marks are dropped. Its click handler refuses while key-locked. Without a
 * missing key the control comes back as the canvas lock gave it. Every Run
 * surface spreads its props through this (the ratchet,
 * agentPresenceFollowups.ratchet.test.ts, checks it).
 */
export function withKeyLock<T extends { disabled: boolean; title?: string | undefined }>(
  props: T, reason: string | null | undefined, reasonId: string,
): T & KeyLockedProps {
  if (!reason) return props;
  const rest: Record<string, unknown> = { ...props };
  for (const mark of CANVAS_LOCK_MARKS) delete rest[mark];
  return { ...(rest as T), disabled: false, title: reason, ...keyLockedProps(reason, reasonId) };
}
