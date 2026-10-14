import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { edgeIsInactive, inactiveEdgeReason, isInactiveEdge, skippedLabel } from '../../src/lib/gating';
import { describeRunScope, nodesBehindGates, runCostConfirmMessage, summarizeRunScope } from '../../src/lib/runScope';
import type { PricingTable } from '../../src/lib/pricing';
import type { NodeData } from '../../src/types';

const node = (id: string, definitionId: string, data: Partial<NodeData> = {}): Node<NodeData> => ({
  id, position: { x: 0, y: 0 },
  data: { definitionId, label: '', params: {}, state: 'idle', outputs: {}, ...data } as NodeData,
});
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge =>
  ({ id: `${source}.${sourceHandle}-${target}`, source, sourceHandle, target, targetHandle });

describe('gate wires and labels', () => {
  it('says why a node was skipped', () => {
    expect(skippedLabel('Jev Decide failed (answered no, 0.12)')).toBe('Skipped: Jev Decide failed (answered no, 0.12)');
    expect(skippedLabel(undefined)).toBe('Skipped: a gate upstream withheld its input');
  });

  it('draws a wire inactive from a withheld port or a skipped node, and live otherwise', () => {
    const gate = { state: 'complete' as const, withheldPorts: { on_fail: 'Jev Decide passed (answered yes, 0.93)' } };
    expect(isInactiveEdge(gate, 'on_fail')).toBe(true);
    expect(isInactiveEdge(gate, 'on_pass')).toBe(false);
    expect(isInactiveEdge(gate, 'report')).toBe(false);
    expect(isInactiveEdge({ state: 'skipped' }, 'image')).toBe(true);
    expect(isInactiveEdge({ state: 'complete' }, 'image')).toBe(false);
    expect(isInactiveEdge(undefined, 'image')).toBe(false);
    expect(inactiveEdgeReason(gate, 'on_fail')).toBe('Withheld: Jev Decide passed (answered yes, 0.93)');
    expect(inactiveEdgeReason({ state: 'skipped', skipReason: 'x' }, 'image')).toBe('Skipped: x');
    expect(inactiveEdgeReason(gate, 'on_pass')).toBeNull();

    const nodes = [node('gate', 'jev-decide', gate)];
    expect(edgeIsInactive(nodes, 'gate', 'on_fail')).toBe(true);
    expect(edgeIsInactive(nodes, 'missing', 'on_fail')).toBe(false);
  });
});

describe('run estimates with a gate', () => {
  // image -> Jev Decide; On Pass -> upscale -> edit; On Fail -> regenerate; the report goes to a paid chat.
  const nodes = [
    node('prompt', 'text-input'),
    node('gen', 'gpt-image-1-generate', { label: 'Hero shot' }),
    node('gate', 'jev-decide'),
    node('up', 'esrgan-upscale', { label: 'Upscale' }),
    node('edit', 'gpt-image-1-edit', { label: 'Touch up' }),
    node('redo', 'gpt-image-1-generate', { label: 'Regenerate' }),
    node('chat', 'claude-chat', { label: 'Explain' }),
  ];
  const edges = [
    wire('prompt', 'text', 'gen', 'prompt'),
    wire('gen', 'image', 'gate', 'images'),
    wire('gen', 'image', 'gate', 'through'),
    wire('gate', 'on_pass', 'up', 'image'),
    wire('up', 'image', 'edit', 'image'),
    wire('gate', 'on_fail', 'redo', 'prompt'),
    wire('gate', 'report', 'chat', 'prompt'),
  ];

  it('finds the nodes behind a gate port, and only those', () => {
    expect([...nodesBehindGates(nodes, edges)].sort()).toEqual(['edit', 'redo', 'up']);
    expect(nodesBehindGates(nodes, edges.filter((edge) => edge.sourceHandle !== 'on_pass' && edge.sourceHandle !== 'on_fail')).size).toBe(0);
  });

  it('still counts gated nodes in the estimate, and says a skip costs nothing', () => {
    const pricing: PricingTable = { nodes: {
      'gpt-image-1-generate': { currency: 'usd', rows: [{ match: {}, price: 0.04 }] },
      'gpt-image-1-edit': { currency: 'usd', rows: [{ match: {}, price: 0.05 }] },
      'esrgan-upscale': { currency: 'usd', rows: [{ match: {}, price: 0.01 }] },
      'jev-decide': { currency: 'usd', rows: [{ match: {}, price: [0.00001, 0.0027] }] },
      'claude-chat': { currency: 'usd', rows: [{ match: {}, price: 0.01 }] },
    } } as unknown as PricingTable;
    const summary = summarizeRunScope(nodes, edges, { kind: 'graph' }, { pricing, apiKeys: {} });
    expect(summary.gated).toEqual(['Upscale', 'Touch up', 'Regenerate']);
    expect(summary.cost?.lines.map((line) => line.name)).toContain('Regenerate');
    expect(describeRunScope(summary)).toContain(
      'A gate may skip Upscale, Touch up, Regenerate. The estimate still counts them, and a skipped node costs nothing');
    expect(runCostConfirmMessage(summary)).toContain('a skipped node costs nothing.');
    const ungated = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 'gen' }, { pricing, apiKeys: {} });
    expect(ungated.gated).toBeUndefined();
  });
});
