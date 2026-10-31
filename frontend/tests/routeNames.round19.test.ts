import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { nameOnRoute, routeDependsOnKeys } from '../src/lib/directRoute';
import { describeRunScope, runCostConfirmMessage, runNodeName, summarizeRunScope } from '../src/lib/runScope';
import { placeholderRunConfirm, rowSegments, type PlaceholderRunOptions } from '../src/lib/placeholderRunConfirm';

/**
 * Review 18, L-A, and GM - Design, round 19 (verbatim): a named Krea row
 * must read "“Alt still” · Grok Imagine 2.0 via Krea · price not listed";
 * xAI already reads "“Alt still” · Grok Imagine 2.0 via xAI · $0.06". The
 * cost notes, the costly-run confirm's "No list price for …" and the run
 * summary name an unnamed node on Krea "Grok Imagine 2.0 via Krea", never
 * "Grok Imagine 2.0 (Krea)". Only for nodes whose route depends on keys.
 *
 * Review 18, L-D (GM, verbatim): when the keys can't be read (the re-ask's
 * key read timed out or failed, so the route is unknown), the dialog row
 * drops only the route, never naming a possibly old one. Unnamed: "“Grok
 * Imagine 2.0” · $0.06". Named: "“Alt still” · Grok Imagine 2.0 · $0.06".
 * Spend numbers stay Nebula's.
 */

const PRICING = JSON.parse(readFileSync(resolve(__dirname, '../../backend/data/model_pricing.json'), 'utf8'));
const GROK = 'krea-image-xai-grok-imagine-2';
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };
const KREA = { KREA_API_TOKEN: 'k' };
const XAI = { XAI_API_KEY: 'x' };

function canvas(label: string, pending = true) {
  const nodes = [
    { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', label: 'Prompt', params: { value: 'a fox' }, state: 'idle', outputs: {} } },
    { id: 'n2', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: GROK, label, params: {}, state: 'idle', outputs: {}, ...(pending ? { pending: codex } : {}) } },
  ] as unknown as Node<NodeData>[];
  const edges = [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' }] as Edge[];
  return { nodes, edges };
}

function row(label: string, apiKeys: Record<string, string>, options: PlaceholderRunOptions = {}) {
  const { nodes, edges } = canvas(label);
  const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 'n2' }, { pricing: PRICING, apiKeys, sizes: {} });
  return rowSegments(placeholderRunConfirm(nodes, edges, 'n2', summary, options)!.rows.find((r) => r.nodeId === 'n2')!);
}

describe('L-A: a node on the gateway is named "via" the gateway when its route depends on keys', () => {
  it('nameOnRoute on Krea, or with no route, reads "Grok Imagine 2.0 via Krea"', () => {
    expect(routeDependsOnKeys(NODE_DEFINITIONS[GROK])).toBe(true);
    expect(nameOnRoute(NODE_DEFINITIONS[GROK], 'krea')).toBe('Grok Imagine 2.0 via Krea');
    expect(nameOnRoute(NODE_DEFINITIONS[GROK], null)).toBe('Grok Imagine 2.0 via Krea');
    expect(nameOnRoute(NODE_DEFINITIONS[GROK], 'xai')).toBe('Grok Imagine 2.0 via xAI');
  });
  it('a definition whose route does not depend on keys keeps the round-15 behaviour', () => {
    const fixed = Object.values(NODE_DEFINITIONS).find((definition) => / \(Krea\)$/.test(definition.displayName)
      && !routeDependsOnKeys(definition))!;
    expect(fixed).toBeDefined();
    expect(nameOnRoute(fixed, 'krea')).toBe(fixed.displayName);
    expect(nameOnRoute(fixed, null)).toBe(fixed.displayName);
    expect(nameOnRoute(NODE_DEFINITIONS['gpt-image-1-5'], 'openai')).toBe('GPT Image 1.5');
  });
  it('a named Krea row: “Alt still” · Grok Imagine 2.0 via Krea · price not listed', () => {
    expect(row('Alt still', KREA)).toEqual(['“Alt still”', 'Grok Imagine 2.0 via Krea', 'price not listed']);
    expect(row('Alt still', {})).toEqual(['“Alt still”', 'Grok Imagine 2.0 via Krea', 'price not listed']);
    expect(row('Alt still', XAI)).toEqual(['“Alt still”', 'Grok Imagine 2.0 via xAI', '$0.06']);
  });
  it('runNodeName, the costly-run confirm and the run summary name an unnamed Krea node "via Krea"', () => {
    for (const label of ['Grok Imagine 2.0', 'Grok Imagine 2.0 (Krea)']) {
      const { nodes, edges } = canvas(label, false);
      const summary = summarizeRunScope(nodes, edges, { kind: 'graph' }, { pricing: PRICING, apiKeys: KREA, sizes: {} });
      expect(runNodeName(nodes[1], summary.routes?.n2)).toBe('Grok Imagine 2.0 via Krea');
      expect(summary.cost?.unpriced).toEqual(['Grok Imagine 2.0 via Krea']);
      expect(describeRunScope(summary)).toContain('“Grok Imagine 2.0 via Krea” calls a paid provider that has no listed price.');
      expect(describeRunScope(summary)).not.toContain('(Krea)');
      expect(summary.paid).toEqual(['Grok Imagine 2.0 via Krea']);
    }
  });
  it('the costly-run confirm\'s "No list price for …" note beside a priced node', () => {
    const { nodes, edges } = canvas('Grok Imagine 2.0', false);
    const priced = { id: 'n3', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: GROK, label: 'Base', params: {}, state: 'idle', outputs: {} } } as unknown as Node<NodeData>;
    const summary = summarizeRunScope([...nodes, priced], edges, { kind: 'graph' }, { pricing: PRICING, apiKeys: KREA, sizes: {} });
    const message = runCostConfirmMessage(summary);
    expect(message).not.toContain('(Krea)');
    expect(message).toContain('No list price for Grok Imagine 2.0 via Krea');
  });
});

describe('L-D: keys that cannot be read drop only the route from the row', () => {
  it('unnamed: “Grok Imagine 2.0” · $0.06 (the price stays Nebula\'s)', () => {
    expect(row('Grok Imagine 2.0', XAI, { routeUnknown: true })).toEqual(['“Grok Imagine 2.0”', '$0.06']);
    expect(row('Grok Imagine 2.0 (Krea)', XAI, { routeUnknown: true })).toEqual(['“Grok Imagine 2.0”', '$0.06']);
  });
  it('named: “Alt still” · Grok Imagine 2.0 · $0.06', () => {
    expect(row('Alt still', XAI, { routeUnknown: true })).toEqual(['“Alt still”', 'Grok Imagine 2.0', '$0.06']);
    expect(row('Alt still', KREA, { routeUnknown: true })).toEqual(['“Alt still”', 'Grok Imagine 2.0', 'price not listed']);
  });
  it('known keys still name the route', () => {
    expect(row('Grok Imagine 2.0', XAI)).toEqual(['“Grok Imagine 2.0”', 'via xAI', '$0.06']);
    expect(row('Alt still', XAI, { routeUnknown: false })).toEqual(['“Alt still”', 'Grok Imagine 2.0 via xAI', '$0.06']);
  });
});
