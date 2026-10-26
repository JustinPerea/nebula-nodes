import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { modelNotChosenText, placeholderRunConfirm, rowSegments } from '../../src/lib/placeholderRunConfirm';
import { pendingIncludedLine, pendingSkipLine } from '../../src/lib/pendingNodes';
import type { RunCost, RunScopeSummary } from '../../src/lib/runScope';

// GM - Design's round-12 rulings (2026-10-26) and addendum (b), verbatim.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };

function node(id: string, label: string, agent?: typeof codex, definitionId = 'nano-banana', params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label, params, state: 'idle', outputs: {}, ...(agent ? { pending: { agent, at: 1 } } : {}) } } as Node<NodeData>;
}
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, sourceHandle: 'image', targetHandle: 'images' });
const summaryOf = (cost: Partial<RunCost>): RunScopeSummary => ({ total: 5, paid: [], cost: {
  low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [], ...cost } });
const unpriced = summaryOf({});
const row = (definitionId: string, params: Record<string, unknown>, label = 'Up') =>
  placeholderRunConfirm([node('k', label, codex, definitionId, params)], [], 'k', unpriced)!.rows[0];

describe('addendum (b): a required model setting with nothing chosen', () => {
  it('Topaz Standard reads "Model: not chosen" and keeps the rest of the row', () => {
    const topaz = row('krea-enhance-topaz-standard-enhance', {}, 'Clean plate');
    expect(topaz.setting).toBe('Model: not chosen');
    expect(row('krea-enhance-topaz-standard-enhance', { model: '' }).setting).toBe('Model: not chosen');
    expect(rowSegments(topaz)).toEqual(['“Clean plate”', 'Topaz Standard (Krea)', 'Model: not chosen', topaz.price]);
  });

  it('a chosen model still reads as chosen, so a switch is a changed row', () => {
    expect(row('krea-enhance-topaz-standard-enhance', { model: 'CGI' }).setting).toBe('Model: CGI');
  });

  it("a node app's required Version reads the same way", () => {
    expect(row('krea-node-app', {}).setting).toBe('Version: not chosen');
    expect(row('krea-node-app', { node_app_version_id: 'v_9' }).setting).toBe('Version: v_9');
  });

  it('the refusal names the node and the field', () => {
    // Round 13 (GM: only the first missing field, in the card's order): its
    // Width and Height come first, so they are set here.
    expect(modelNotChosenText([node('t', 'Clean plate', codex, 'krea-enhance-topaz-standard-enhance', { width: 2048, height: 2048 })]))
      .toBe('Nothing ran. Choose a model for “Clean plate” first.');
    expect(modelNotChosenText([node('a', 'Lab app', undefined, 'krea-node-app')]))
      .toBe('Nothing ran. Choose a version for “Lab app” first.');
    expect(modelNotChosenText([node('t', 'Clean plate', codex, 'krea-enhance-topaz-standard-enhance', { width: 2048, height: 2048, model: 'CGI' })])).toBeNull();
    expect(modelNotChosenText([node('n', 'Hero', codex)])).toBeNull();
  });
});

describe('GM round 12, item 2: Meshy\'s mesh type is named by its setting', () => {
  it('"Mesh type: Smart Topology (Meshy T2)"', () => {
    expect(row('meshy-text-to-3d', { model_type: 'smart-topology' }).setting).toBe('Mesh type: Smart Topology (Meshy T2)');
    expect(row('meshy-image-to-3d', { model_type: 'smart-topology' }).setting).toBe('Mesh type: Smart Topology (Meshy T2)');
  });

  it('named at its default too, so a switch re-asks like the other settings', () => {
    expect(row('meshy-text-to-3d', {}).setting).toBe('Mesh type: Standard');
    expect(row('meshy-text-to-3d', {}).setting).not.toBe(row('meshy-text-to-3d', { model_type: 'lowpoly' }).setting);
  });
});

describe('GM round 12, item 3: a changed free node stays named, after the names that have rows', () => {
  it('“Hero still” (a row) before “Prompt” (free, no row)', () => {
    const model = placeholderRunConfirm([node('p', 'Prompt', codex, 'text-input'), node('h', 'Hero still', codex)],
      [wire('p', 'h')], 'h', unpriced, { changed: new Set(['p', 'h']) })!;
    expect(model.rows.map((candidate) => candidate.name)).toEqual(['“Hero still”']);
    expect(model.savedLine).toBe('Codex changed “Hero still” and “Prompt” after the run was saved. The replay uses the saved settings.');
  });
});

describe('GM round 12, item 1: "the agents" in the skip and included lines', () => {
  it('Skipped 3 nodes the agents are still setting up.', () => {
    expect(pendingSkipLine({ count: 3, placeholders: 2, agents: ['Codex', 'Claude Code'] }))
      .toBe('Skipped 3 nodes the agents are still setting up.');
  });

  it('Includes 3 nodes the agents are still setting up.', () => {
    expect(pendingIncludedLine({ count: 3, placeholders: 2, agents: ['Codex', 'Claude Code'] }))
      .toBe('Includes 3 nodes the agents are still setting up.');
  });

  it('one agent keeps its name', () => {
    expect(pendingSkipLine({ count: 1, placeholders: 1, agents: ['Codex'] })).toBe('Skipped 1 node Codex is still setting up.');
  });
});

describe('the bug in r11-topaz-rows: a row is made of whole segments', () => {
  it('each setting is its own segment', () => {
    expect(rowSegments({ nodeId: 'k', name: '“Up”', model: 'Topaz Bloom 2 (Krea)', modelKey: 'Topaz Bloom 2 (Krea)',
      setting: 'Variant: Large · Grain model: gaussian', price: 'on your Krea plan', agent: null }))
      .toEqual(['“Up”', 'Topaz Bloom 2 (Krea)', 'Variant: Large', 'Grain model: gaussian', 'on your Krea plan']);
  });

  it('no model and no setting: the name and the price', () => {
    expect(rowSegments({ nodeId: 'k', name: '“Hero still”', model: null, modelKey: 'x', setting: null, price: '$0.06', agent: null }))
      .toEqual(['“Hero still”', '$0.06']);
  });
});
