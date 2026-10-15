import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { allParamDefinitions } from '../../src/lib/directRoute';
import type { ModelNodeDefinition, ParamDefinition } from '../../src/types';

/** allParamDefinitions replaced hand-written group lists; for every catalog
 * node it must give each of them the same answer (backend
 * test_node_route.py pins node_route.all_param_definitions the same way). */
const definitions = Object.values(NODE_DEFINITIONS) as ModelNodeDefinition[];

function firstWins(groups: (ParamDefinition[] | undefined)[]): Map<string, ParamDefinition> {
  const found = new Map<string, ParamDefinition>();
  for (const group of groups) for (const param of group ?? []) if (!found.has(param.key)) found.set(param.key, param);
  return found;
}

describe('allParamDefinitions', () => {
  it('matches pricing.ts and nodeKeys.ts (params, shared, direct, fal; first wins)', () => {
    for (const def of definitions) {
      const old = firstWins([def.params, def.sharedParams, def.directParams, def.falParams]);
      expect({ id: def.id, params: allParamDefinitions(def) }).toEqual({ id: def.id, params: [...old.values()] });
    }
  });

  it('matches graphStore and the readiness badge defaults (shared, fal, direct, last wins; else params)', () => {
    for (const def of definitions) {
      const sources = def.sharedParams ? [...def.sharedParams, ...(def.falParams ?? []), ...(def.directParams ?? [])] : def.params;
      const old = Object.fromEntries(sources.filter((param) => param.default !== undefined).map((param) => [param.key, param.default]));
      const now = Object.fromEntries(allParamDefinitions(def).filter((param) => param.default !== undefined)
        .map((param) => [param.key, param.default]));
      expect({ id: def.id, defaults: now }).toEqual({ id: def.id, defaults: old });
      expect({ id: def.id, keys: new Set(allParamDefinitions(def).map((param) => param.key)) })
        .toEqual({ id: def.id, keys: new Set(sources.map((param) => param.key)) });
    }
  });

  it('matches modelDiscovery search (every `model` option)', () => {
    for (const def of definitions) {
      const options = (params: ParamDefinition[]) => new Set(params.filter((param) => param.key === 'model')
        .flatMap((param) => (param.options ?? []).map((option) => String(option.value))));
      const old = [...def.params, ...(def.sharedParams ?? []), ...(def.falParams ?? []), ...(def.directParams ?? [])];
      expect({ id: def.id, options: options(allParamDefinitions(def)) }).toEqual({ id: def.id, options: options(old) });
    }
  });
});
