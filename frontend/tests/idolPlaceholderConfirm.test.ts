/**
 * GM, PR #203 r15 item 2 (verbatim): "Running over the placeholder: yes.
 * With no token, Idol is free and adds no paid confirm on its own. With a
 * token, it's "may cost" and still asks. Idol's cost class should come from
 * one function" (directRoute keyBilling; backend node_route.key_billing,
 * main._paid_placeholders).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { describeRunScope, summarizeRunScope } from '../src/lib/runScope';
import { PRICE_MAY_COST, placeholderRunConfirm, withRefusalFlags } from '../src/lib/placeholderRunConfirm';

const PRICING = JSON.parse(readFileSync(resolve(__dirname, '../../backend/data/model_pricing.json'), 'utf8'));
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };
const TOKEN = { HF_TOKEN: 'hf_fixture' };

function canvas(withPaid = false) {
  const nodes = [
    { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'image-input', label: 'Ref', params: { value: 'a.png' }, state: 'idle', outputs: {} } },
    { id: 'n2', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'speridlabs-idol', label: 'Idol', params: {}, state: 'idle', outputs: {}, pending: codex } },
    ...(withPaid ? [{ id: 'n3', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'nano-banana', label: 'Still', params: {}, state: 'idle', outputs: {}, pending: codex } }] : []),
  ] as unknown as Node<NodeData>[];
  const edges = [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'image', targetHandle: 'image' },
    ...(withPaid ? [{ id: 'e2', source: 'n1', target: 'n3', sourceHandle: 'image', targetHandle: 'image' }] : [])] as Edge[];
  return { nodes, edges };
}

function confirm(apiKeys: Record<string, string>, target = 'n2', withPaid = false) {
  const { nodes, edges } = canvas(withPaid);
  const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: target }, { pricing: PRICING, apiKeys, sizes: {} });
  return placeholderRunConfirm(nodes, edges, target, summary, { apiKeys });
}

describe('the person\'s run over an Idol placeholder', () => {
  it('without a token Idol is free: no dialog of its own', () => {
    expect(confirm({})).toBeNull();
  });

  it('with a token it may cost: the dialog asks, its row "may cost", no dollar amount on Run', () => {
    const model = confirm(TOKEN)!;
    expect(model).not.toBeNull();
    expect(model.confirmIds).toEqual(['n2']);
    const row = model.rows.find((candidate) => candidate.nodeId === 'n2')!;
    expect(row.price).toBe(PRICE_MAY_COST);
    expect(model.runLabel).not.toMatch(/\$/);
    expect(model.notes.join(' ')).not.toMatch(/no listed price|price not listed/);
  });

  it('keys unread: counted as paid, as before', () => {
    const { nodes, edges } = canvas();
    const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 'n2' }, { pricing: PRICING, apiKeys: {}, sizes: {} });
    expect(placeholderRunConfirm(nodes, edges, 'n2', summary)).not.toBeNull();
  });

  it('a refusal that no longer lists a free Idol keeps its flag (it is still a placeholder)', () => {
    const { nodes } = canvas();
    const kept = withRefusalFlags(nodes, { placeholders: [], agents: {} } as never, {});
    expect((kept[1].data as { pending?: unknown }).pending).toBeTruthy();
  });
});

describe('the Run description puts Idol\'s sentence after the estimate (review 7, NIT-4)', () => {
  it('paid nodes, the estimate, then Idol', () => {
    const placed = canvas(true);
    // Not placeholders here: a graph run skips those.
    const nodes = placed.nodes.map((node) => ({ ...node, data: { ...node.data, pending: undefined } })) as Node<NodeData>[];
    const { edges } = placed;
    const text = describeRunScope(summarizeRunScope(nodes, edges, { kind: 'graph' }, { pricing: PRICING, apiKeys: { ...TOKEN, GEMINI_API_KEY: 'k' }, sizes: {} }));
    const estimate = text.indexOf('Estimated');
    const idol = text.indexOf('Idol can use your Hugging Face credits');
    expect(estimate).toBeGreaterThan(-1);
    expect(idol).toBeGreaterThan(estimate);
  });
});
