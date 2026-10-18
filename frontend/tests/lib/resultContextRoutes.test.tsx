import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import routeCases from '../../../backend/tests/fixtures/route_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { ResultDetails } from '../../src/components/create-studio/ResultDetails';
import { resultContextForNode } from '../../src/lib/resultContext';
import type { ModelNodeDefinition, NodeData } from '../../src/types';

/** A route-table node's params can live in a route's own `params`; the
 * result title and the recipe read them like any other param
 * (directRoute.allParamDefinitions). */
const base = (routeCases.definitions as unknown as Record<string, ModelNodeDefinition>)['routes-image'];
const definition = {
  ...base, id: 'routes-image-models', displayName: 'Fixture Models',
  routes: base.routes!.map((route) => route.id !== 'bfl' ? route : {
    ...route, params: [...(route.params ?? []), {
      key: 'model', label: 'Model', type: 'enum', required: false, default: 'pro',
      options: [{ label: 'Pro', value: 'pro' }, { label: 'Flex', value: 'flex' }],
    }],
  }),
} as ModelNodeDefinition;

function node(params: Record<string, unknown>): Node<NodeData> {
  return { id: 'model', type: 'model-node', position: { x: 0, y: 0 }, data: {
    label: 'Label', definitionId: definition.id, params, state: 'complete',
    outputs: { image: { type: 'Image', value: '/api/outputs/a.png' } },
  } } as Node<NodeData>;
}

describe('result context for a route-table node', () => {
  beforeAll(() => { NODE_DEFINITIONS[definition.id] = definition; });
  afterAll(() => { delete NODE_DEFINITIONS[definition.id]; });
  afterEach(cleanup);

  it('names the model a route param picks', () => {
    expect(resultContextForNode(node({ model: 'flex' }), []).modelName).toBe('Fixture Models · Flex');
  });

  it('labels a route param in the recipe', () => {
    render(<ResultDetails context={resultContextForNode(node({ grounding: true }), [])} />);
    expect(screen.getByText('Grounding')).toBeTruthy();
    expect(screen.queryByText('grounding')).toBeNull();
  });
});
