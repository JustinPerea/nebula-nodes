import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition, NodeData } from '../types';
import { keyPhrase, routeMissingKeyLine, selectRoute, type ApiKeys } from './directRoute';
import { nodesThatRun, type RunScope } from './runScope';

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
 * run Idol after you add your Hugging Face token in Settings."): a Run
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

/**
 * One order for a control that the canvas lock and the key lock can both
 * hold (PR #203 round 6, on PR #198's run lock): the canvas lock's reasons
 * first, in its own order (this tab's run, then following, then offline:
 * lib/canvasLock `act`), then the control's own disabled reason, then the
 * missing key, as the control's own title comes last there. A control one
 * of those holds is natively disabled with that line alone; only a control
 * nothing else holds is key-locked (aria-disabled, focusable, the key line
 * as its title and description).
 */
export function withKeyLock<T extends { disabled: boolean; title?: string | undefined }>(
  props: T, reason: string | null | undefined, reasonId: string,
): T & KeyLockedProps {
  if (props.disabled || !reason) return props;
  return { ...props, title: reason, ...keyLockedProps(reason, reasonId) };
}
