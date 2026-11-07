import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { nameOnRoute } from '../src/lib/directRoute';
import { describeRunScope, runCostConfirmMessage, summarizeRunScope } from '../src/lib/runScope';
import { placeholderRunConfirm, rowSegments } from '../src/lib/placeholderRunConfirm';

/**
 * Review 14, L-I, and GM - Design, round 15, item 3 (verbatim): "a confirm
 * row names the route that actually runs, and that route's price. On the
 * person's xAI key: "Grok Imagine 2.0 (xAI) · $X", using the label the card
 * uses for that route. If that route's price isn't known: "price not listed"
 * and the usual footnote. Never show the Krea price for a run that doesn't
 * go through Krea." The label the card uses for a route is the provider the
 * running card names ("xAI · 6s": providerLabel). GM - Design, round 16 (b):
 * when the dialog builds the label, no parens: "Grok Imagine 2.0 via xAI".
 */

const PRICING = JSON.parse(readFileSync(resolve(__dirname, '../../backend/data/model_pricing.json'), 'utf8'));
const GROK = 'krea-image-xai-grok-imagine-2';
const FLARE = 'krea-image-openai-gpt-image-2-5-flare';
const KREA2 = 'krea-image-krea-krea-2-medium';
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };

function canvas(definitionId: string, label: string | null, params: Record<string, unknown> = {}, wired: string[] = [], pending = true) {
  const target = { id: 'n2', type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label: label ?? NODE_DEFINITIONS[definitionId].displayName, params, state: 'idle', outputs: {}, ...(pending ? { pending: codex } : {}) } };
  const nodes = [
    { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', label: 'Prompt', params: { value: 'a fox' }, state: 'idle', outputs: {} } },
    { id: 'n3', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'image-input', label: 'Ref', params: { value: 'a.png' }, state: 'idle', outputs: {} } },
    target,
  ] as unknown as Node<NodeData>[];
  const edges = [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' },
    ...wired.map((port, index) => ({ id: `w${index}`, source: 'n3', target: 'n2', sourceHandle: 'image', targetHandle: port }))] as Edge[];
  return { nodes, edges };
}

function dialogRow(definitionId: string, label: string | null, apiKeys: Record<string, string>, params: Record<string, unknown> = {}, wired: string[] = []) {
  const { nodes, edges } = canvas(definitionId, label, params, wired);
  const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 'n2' }, { pricing: PRICING, apiKeys, sizes: {} });
  const model = placeholderRunConfirm(nodes, edges, 'n2', summary)!;
  return { row: model.rows.find((row) => row.nodeId === 'n2')!, model };
}

describe('nameOnRoute: the gateway a display name names becomes the route that runs', () => {
  it('a Krea copy on its maker names the maker as the card does', () => {
    expect(nameOnRoute(NODE_DEFINITIONS[GROK], 'xai')).toBe('Grok Imagine 2.0 via xAI');
    expect(nameOnRoute(NODE_DEFINITIONS[FLARE], 'openai')).toBe('GPT Image 2.5 Flare via OpenAI');
    expect(nameOnRoute(NODE_DEFINITIONS['nano-banana-fal'], 'google')).toBe('Nano Banana via Google');
  });
  it('on the gateway itself it names the gateway (round 19, L-A); a name that names no provider stays', () => {
    expect(nameOnRoute(NODE_DEFINITIONS[GROK], 'krea')).toBe('Grok Imagine 2.0 via Krea');
    expect(nameOnRoute(NODE_DEFINITIONS[GROK], null)).toBe('Grok Imagine 2.0 via Krea');
    expect(nameOnRoute(NODE_DEFINITIONS['gpt-image-1-5'], 'openai')).toBe('GPT Image 1.5');
  });
});

describe("GM round 15, item 3: the placeholder dialog's row names the route that runs, at its price", () => {
  it('a named node on the xAI key: “Alt still” · Grok Imagine 2.0 via xAI · $0.06', () => {
    const { row } = dialogRow(GROK, 'Alt still', { XAI_API_KEY: 'x' });
    expect(rowSegments(row)).toEqual(['“Alt still”', 'Grok Imagine 2.0 via xAI', '$0.06']);
  });
  it('xAI key and a Krea token, nothing wired: still xAI', () => {
    expect(dialogRow(GROK, 'Alt still', { XAI_API_KEY: 'x', KREA_API_TOKEN: 'k' }).row.model).toBe('Grok Imagine 2.0 via xAI');
  });
  it('an unnamed node names the route in its name, with no second model', () => {
    const { row } = dialogRow(GROK, null, { XAI_API_KEY: 'x' });
    // Round 18 (GM item 1): the name is the canvas title and the model segment only the route.
    expect(row.name).toBe('“Grok Imagine 2.0”');
    expect(row.model).toBe('via xAI');
    expect(row.price).toBe('$0.06');
  });
  it('Style images wired keeps the run on Krea: the Krea name, never the xAI price', () => {
    const { row } = dialogRow(GROK, 'Alt still', { XAI_API_KEY: 'x', KREA_API_TOKEN: 'k' },
      { aspect_ratio: '1:1', resolution: '1K' }, ['style_images']);
    // Round 19 (review 18, L-A): the gateway is named as a route too.
    expect(row.model).toBe('Grok Imagine 2.0 via Krea');
    expect(row.price).not.toBe('$0.06');
  });
  it('GPT Image 2.5 Flare on an OpenAI key alone: the OpenAI name and "price not listed" (no total, so no footnote)', () => {
    const { row, model } = dialogRow(FLARE, 'Hero still', { OPENAI_API_KEY: 'o' });
    expect(row.model).toBe('GPT Image 2.5 Flare via OpenAI');
    expect(row.price).toBe('price not listed');
    expect(model.totalLine).toBeNull();
    expect(model.runLabel).toBe('Run');
  });
  it('beside a priced row: the total and the usual footnote, naming the unnamed Flare as its row does', () => {
    const { nodes, edges } = canvas(FLARE, null);
    const grok = { id: 'n4', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: GROK, label: 'Base', params: {}, state: 'idle', outputs: {}, pending: codex } } as unknown as Node<NodeData>;
    const all = [...nodes, grok];
    const wires = [...edges, { id: 'e4', source: 'n4', target: 'n2', sourceHandle: 'image', targetHandle: 'image_urls' }] as Edge[];
    const keys = { OPENAI_API_KEY: 'o', XAI_API_KEY: 'x' };
    const summary = summarizeRunScope(all, wires, { kind: 'node', nodeId: 'n2' }, { pricing: PRICING, apiKeys: keys, sizes: {} });
    const model = placeholderRunConfirm(all, wires, 'n2', summary)!;
    const flare = model.rows.find((row) => row.nodeId === 'n2')!;
    const base = model.rows.find((row) => row.nodeId === 'n4')!;
    // Round 18 (GM item 1): an unnamed node is named by its canvas title, the route its own segment.
    expect(rowSegments(flare)).toEqual(['“GPT Image 2.5 Flare”', 'via OpenAI', 'price not listed']);
    expect(flare.price).toBe('price not listed');
    expect(rowSegments(base)).toEqual(['“Base”', 'Grok Imagine 2.0 via xAI', '$0.06']);
    expect(model.totalLine).toBe('The listed prices total $0.06.');
    // Round 18 (GM item 1): the footnote names it as its row does.
    expect(model.notes).toContain('“GPT Image 2.5 Flare” has no list price, so the run may cost more.');
  });
  it('the Krea plan stays Krea', () => {
    const { row } = dialogRow(KREA2, 'Hero', {}, { _kreaAuth: 'mcp', aspect_ratio: '1:1', resolution: '1K' });
    expect(row.model).toBe(NODE_DEFINITIONS[KREA2].displayName);
    expect(row.price).toBe('on your Krea plan');
  });
});

describe('GM round 15, item 3: the costly-run confirm and the run summary', () => {
  it('the costly-run confirm names an unnamed node on the route that runs', () => {
    const { nodes, edges } = canvas(GROK, null, {}, [], false);
    const summary = summarizeRunScope(nodes, edges, { kind: 'graph' }, { pricing: PRICING, apiKeys: { XAI_API_KEY: 'x' }, sizes: {} });
    expect(runCostConfirmMessage(summary)).toContain('• Grok Imagine 2.0 via xAI: $0.06');
    expect(runCostConfirmMessage(summary)).not.toContain('(Krea)');
  });
  it('the run summary (the Run button) names it the same way', () => {
    const { nodes, edges } = canvas(GROK, null, {}, [], false);
    const summary = summarizeRunScope(nodes, edges, { kind: 'graph' }, { pricing: PRICING, apiKeys: { XAI_API_KEY: 'x' }, sizes: {} });
    expect(describeRunScope(summary)).toContain('“Grok Imagine 2.0 via xAI” calls a paid provider.');
    expect(describeRunScope(summary)).toContain('Estimated cost $0.06.');
  });
  it('a named node keeps its name', () => {
    const { nodes, edges } = canvas(GROK, 'Alt still', {}, [], false);
    const summary = summarizeRunScope(nodes, edges, { kind: 'graph' }, { pricing: PRICING, apiKeys: { XAI_API_KEY: 'x' }, sizes: {} });
    expect(runCostConfirmMessage(summary)).toContain('• Alt still: $0.06');
  });
});
