import { describe, expect, it } from 'vitest';
import tables from '../../../backend/tests/fixtures/route_tables.json';
import cases from '../../../backend/tests/fixtures/route_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { allParamDefinitions, hasRoutes, KEY_PROVIDERS, PROVIDER_LABELS, routeParamDefinitions, routesOf } from '../../src/lib/directRoute';
import type { ModelNodeDefinition, RouteSpec } from '../../src/types';

/** backend/tests/fixtures/route_tables.json is node_route.routes_of over every
 * node (scripts/generate-route-tables.py). routesOf must compute the same
 * specs, so pricing, readiness and discovery read the same routes on both sides. */
type Snapshot = {
  keyProviders: Record<string, string>;
  providerLabels: Record<string, string>;
  nodes: Record<string, { routes: Record<string, unknown>[]; allParamKeys: string[]; routeParams?: Record<string, Record<string, unknown>[]> }>;
};
const snapshot = tables as unknown as Snapshot;
const inline = (cases as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions;

function shown(route: RouteSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'provider', 'maker', 'keys', 'plan', 'handler', 'pricing'] as const) {
    if (route[key] !== undefined) out[key] = route[key];
  }
  out.paramKeys = (route.params ?? []).map((param) => param.key);
  if (route.rules && Object.keys(route.rules).length) out.rules = route.rules;
  return out;
}

describe('routesOf (snapshot of backend node_route.routes_of)', () => {
  const definitions: Record<string, ModelNodeDefinition> = { ...NODE_DEFINITIONS, ...inline };

  it('covers the same nodes', () => {
    expect(Object.keys(definitions).sort()).toEqual(Object.keys(snapshot.nodes).sort());
  });

  it('computes the same routes and param list for every node', () => {
    for (const [nodeId, expected] of Object.entries(snapshot.nodes)) {
      const definition = definitions[nodeId];
      expect({ nodeId, routes: routesOf(definition).map(shown) }).toEqual({ nodeId, routes: expected.routes });
      expect({ nodeId, keys: allParamDefinitions(definition).map((param) => param.key) })
        .toEqual({ nodeId, keys: expected.allParamKeys });
      if (hasRoutes(definition) || routesOf(definition).length > 1) {
        // Each route's options, as the Inspector shows them: a route-table
        // node's per route, a dual-route node's per group
        // (node_route.route_param_definitions).
        const offered = Object.fromEntries(routesOf(definition).map((route) => [route.id,
          routeParamDefinitions(definition, route.id).map((param) => ({
            key: param.key,
            ...(Array.isArray(param.options) ? { options: param.options.map((option) => option.value) } : {}),
            ...(param.min !== undefined ? { min: param.min } : {}),
            ...(param.max !== undefined ? { max: param.max } : {}),
          }))]));
        expect({ nodeId, offered }).toEqual({ nodeId, offered: expected.routeParams });
      } else {
        expect(expected.routeParams).toBeUndefined();
      }
    }
  });

  it('keeps the key and label tables the same on both sides', () => {
    expect(KEY_PROVIDERS).toEqual(snapshot.keyProviders);
    expect(PROVIDER_LABELS).toEqual(snapshot.providerLabels);
    expect(KEY_PROVIDERS.BFL_API_KEY).toBe('bfl');
  });
});
