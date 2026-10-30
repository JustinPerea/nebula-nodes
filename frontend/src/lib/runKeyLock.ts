import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition } from '../types';
import { routeMissingKeyLine, selectRoute, type ApiKeys } from './directRoute';

/**
 * A route that can't run without its key says so in its own words
 * (RouteSpec.missingKeyLine; Idol without a Hugging Face token, GM PR #203
 * r4): Run is disabled with that line as its reason, so a sure-to-fail run is
 * never sent. The backend refuses agent and CLI runs with the same line
 * (node_route.route_unavailable_line). Until Settings load, nothing locks.
 */
export function routeKeyLockReason(
  definition: ModelNodeDefinition | undefined,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
): string | null {
  if (!definition?.routes?.length) return null;
  const route = selectRoute(definition, params ?? {}, apiKeys);
  return route.kind === 'unset' ? routeMissingKeyLine(definition, route) : null;
}

interface LockableNode {
  id: string;
  data: { definitionId: string; params?: Record<string, unknown> };
}

/** The first of these nodes' lock reasons, or null when all can run. */
export function nodesKeyLockReason(
  nodes: readonly LockableNode[],
  ids: readonly string[],
  settings: { loaded: boolean; apiKeys: ApiKeys },
): string | null {
  if (!settings.loaded) return null;
  for (const id of ids) {
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node) continue;
    const reason = routeKeyLockReason(NODE_DEFINITIONS[node.data.definitionId], node.data.params, settings.apiKeys);
    if (reason) return reason;
  }
  return null;
}
