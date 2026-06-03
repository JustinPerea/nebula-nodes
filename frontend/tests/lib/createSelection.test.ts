import { describe, it, expect } from 'vitest';
import { composerStateFromSelection } from '../../src/lib/createSelection';
import type { Node, Edge } from '@xyflow/react';
import type { NodeData } from '../../src/types';

function makeNode(
  id: string,
  definitionId: string,
  selected: boolean,
  params: Record<string, unknown> = {},
): Node<NodeData> {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    selected,
    data: { label: id, definitionId, params, state: 'complete', outputs: {} },
  };
}

function makeTextInput(id: string, value: string, selected = false): Node<NodeData> {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    selected,
    data: {
      label: id,
      definitionId: 'text-input',
      params: { value },
      state: 'complete',
      outputs: {},
    },
  };
}

function makeEdge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

describe('composerStateFromSelection', () => {
  it('returns empty selectedIds and null prefill when nothing is selected', () => {
    const node = makeNode('n1', 'nano-banana', false);
    const result = composerStateFromSelection([node], []);
    expect(result.selectedIds).toEqual([]);
    expect(result.prefill).toBeNull();
  });

  it('single selected model node with an upstream text-input → prefill has right modelId/prompt, no _-prefixed params', () => {
    const modelNode = makeNode('n2', 'nano-banana', true, {
      seed: 42,
      _variant: 'abc',
      _internal: 'x',
    });
    const textInput = makeTextInput('ti1', 'a cool prompt');
    const edge = makeEdge('ti1', 'n2');
    const result = composerStateFromSelection([modelNode, textInput], [edge]);
    expect(result.selectedIds).toEqual(['n2']);
    expect(result.prefill).not.toBeNull();
    expect(result.prefill!.modelId).toBe('nano-banana');
    expect(result.prefill!.prompt).toBe('a cool prompt');
    // _-prefixed keys are stripped
    expect(result.prefill!.params).toEqual({ seed: 42 });
    expect(result.prefill!.params).not.toHaveProperty('_variant');
    expect(result.prefill!.params).not.toHaveProperty('_internal');
  });

  it('multiple selected nodes → prefill is null but selectedIds has all', () => {
    const n1 = makeNode('n1', 'nano-banana', true);
    const n2 = makeNode('n2', 'nano-banana', true);
    const result = composerStateFromSelection([n1, n2], []);
    expect(result.selectedIds).toEqual(['n1', 'n2']);
    expect(result.prefill).toBeNull();
  });

  it('only a selected text-input → prefill is null', () => {
    const ti = makeTextInput('ti1', 'hello', true);
    const result = composerStateFromSelection([ti], []);
    expect(result.selectedIds).toEqual(['ti1']);
    expect(result.prefill).toBeNull();
  });

  it('single selected model node with no upstream text-input → prompt is empty string', () => {
    const modelNode = makeNode('n1', 'nano-banana', true, { steps: 20 });
    const result = composerStateFromSelection([modelNode], []);
    expect(result.prefill).not.toBeNull();
    expect(result.prefill!.prompt).toBe('');
  });

  it('selected image-input node → prefill is null', () => {
    const imgInput = makeNode('n1', 'image-input', true);
    const result = composerStateFromSelection([imgInput], []);
    expect(result.selectedIds).toEqual(['n1']);
    expect(result.prefill).toBeNull();
  });

  it('selected reroute node → prefill is null', () => {
    const reroute = makeNode('n1', 'reroute', true);
    const result = composerStateFromSelection([reroute], []);
    expect(result.prefill).toBeNull();
  });

  it('model node + selected text-input upstream → prefill comes from model, selectedIds includes both', () => {
    const ti = makeTextInput('ti1', 'some prompt', true);
    const modelNode = makeNode('n2', 'nano-banana', true);
    const edge = makeEdge('ti1', 'n2');
    // Two selected nodes → multiple model nodes check — text-input doesn't count as model
    // But wait: there are 2 selected, one text-input and one model → modelNodes.length === 1
    const result = composerStateFromSelection([ti, modelNode], [edge]);
    expect(result.selectedIds).toContain('ti1');
    expect(result.selectedIds).toContain('n2');
    // Only one selected model node → prefill should be non-null
    expect(result.prefill).not.toBeNull();
    expect(result.prefill!.modelId).toBe('nano-banana');
    expect(result.prefill!.prompt).toBe('some prompt');
  });
});
