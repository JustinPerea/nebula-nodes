import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { placeholderRunConfirm, PRICE_ON_KREA_PLAN } from '../../src/lib/placeholderRunConfirm';
import type { RunCost, RunScopeSummary } from '../../src/lib/runScope';

// Review 9 (L-3, nits c and d) and GM - Design's round-10 rulings, verbatim.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const claude = { id: 'ext:claude', name: 'Claude Code', color: '#8AB4F8', verified: true };

function node(id: string, label: string, agent?: typeof codex, definitionId = 'nano-banana', params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label, params, state: 'idle', outputs: {}, ...(agent ? { pending: { agent, at: 1 } } : {}) } } as Node<NodeData>;
}
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, sourceHandle: 'image', targetHandle: 'images' });
const line = (nodeId: string, name: string, low: number, high: number) => ({ nodeId, name, low, high, runs: [1, 1] as [number, number] });
const summaryOf = (cost: Partial<RunCost>): RunScopeSummary => ({ total: 3, paid: [], cost: {
  low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [], ...cost } });
const unpriced = summaryOf({});
const SAVED = 'after the run was saved. The replay uses the saved settings.';

describe('GM round 10, item 1: the replay sentence names the changed nodes', () => {
  const priced = summaryOf({ low: 0.3, high: 0.3, lines: [line('g', 'Grade', 0.1, 0.1), line('w', 'Wide', 0.1, 0.1),
    line('x', 'Sky', 0.05, 0.05), line('o', 'Final', 0.05, 0.05)] });
  const four = [node('g', 'Grade'), node('w', 'Wide'), node('x', 'Sky'), node('o', 'Final')];
  const wires = [wire('g', 'o'), wire('w', 'o'), wire('x', 'o')];

  it('one: “Grade”', () => {
    const model = placeholderRunConfirm(four, wires, 'o', priced, { shown: new Map([['g', codex]]), changed: new Set(['g']) })!;
    expect(model.heading).toBe('Replay the saved version?');
    expect(model.intro).toBe(`Codex changed “Grade” ${SAVED}`);
  });

  it('two: “Grade” and “Wide”', () => {
    const model = placeholderRunConfirm(four, wires, 'o', priced,
      { shown: new Map([['g', codex], ['w', codex]]), changed: new Set(['g', 'w']) })!;
    expect(model.intro).toBe(`Codex changed “Grade” and “Wide” ${SAVED}`);
  });

  it('three or more: a count', () => {
    const model = placeholderRunConfirm(four, wires, 'o', priced,
      { shown: new Map([['g', codex], ['w', codex], ['x', codex]]), changed: new Set(['g', 'w', 'x']) })!;
    expect(model.intro).toBe(`Codex changed 3 nodes ${SAVED}`);
  });

  it('several agents: "The agents changed …", the same three forms', () => {
    const one = placeholderRunConfirm(four, wires, 'o', priced,
      { shown: new Map([['g', codex], ['w', claude]]), changed: new Set(['g']) })!;
    // “Wide” is Claude Code's, finished unchanged; only “Grade” changed, but two agents' nodes are in it.
    expect(one.intro).toBe(`Codex changed “Grade” ${SAVED}`);
    const two = placeholderRunConfirm(four, wires, 'o', priced,
      { shown: new Map([['g', codex], ['w', claude]]), changed: new Set(['g', 'w']) })!;
    expect(two.intro).toBe(`The agents changed “Grade” and “Wide” ${SAVED}`);
    const three = placeholderRunConfirm(four, wires, 'o', priced,
      { shown: new Map([['g', codex], ['w', claude], ['x', codex]]), changed: new Set(['g', 'w', 'x']) })!;
    expect(three.intro).toBe(`The agents changed 3 nodes ${SAVED}`);
  });

  it('a Cinema name is the one the rows use', () => {
    const model = placeholderRunConfirm(four, wires, 'o', priced,
      { shown: new Map([['g', codex]]), changed: new Set(['g']), names: { g: 'Shot 1' } })!;
    expect(model.intro).toBe(`Codex changed “Shot 1” ${SAVED}`);
  });

  it('the still-setting-up case names them too (savedLine)', () => {
    const nodes = [node('q', 'Sky', codex), node('g', 'Grade', codex), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('q', 'o'), wire('g', 'o')], 'o', priced, { changed: new Set(['g']) })!;
    expect(model.heading).toBe('Run 2 nodes Codex is still setting up?');
    expect(model.savedLine).toBe(`Codex changed “Grade” ${SAVED}`);
  });

  it('unchanged finished placeholders keep their dot rows', () => {
    const model = placeholderRunConfirm(four, wires, 'o', priced,
      { shown: new Map([['g', codex], ['w', codex]]), changed: new Set(['g']) })!;
    expect(model.rows.find((row) => row.nodeId === 'w')?.agent).toEqual(codex);
    expect(model.rows.find((row) => row.nodeId === 'g')?.agent).toBeNull();
  });
});

describe("GM round 10, item 2: a Krea node's sub-model setting is named in its row", () => {
  const plan = (id: string) => summaryOf({ ids: { unpriced: [], plan: [id], awaitingInput: [] } });

  it('Krea 2: “Hero” · Krea 2 · Variant: Large · on your Krea plan', () => {
    const model = placeholderRunConfirm([node('k', 'Hero', codex, 'krea-2-generate', { variant: 'large' })], [], 'k', plan('k'))!;
    expect(model.rows[0]).toMatchObject({ name: '“Hero”', model: 'Krea 2', setting: 'Variant: Large', price: PRICE_ON_KREA_PLAN });
  });

  it('named even when it is the default (Variant: Medium)', () => {
    const model = placeholderRunConfirm([node('k', 'Hero', codex, 'krea-2-generate', {})], [], 'k', plan('k'))!;
    expect(model.rows[0].setting).toBe('Variant: Medium');
  });

  it('Magnific: Engine', () => {
    const model = placeholderRunConfirm([node('m', 'Up', codex, 'krea-enhance-magnific-creative-enhance', {})], [], 'm', plan('m'))!;
    expect(model.rows[0].model).toBe('Magnific Creative (Krea)');
    expect(model.rows[0].setting).toMatch(/^Engine: \S/);
  });

  it('Topaz: Model (the node type is the model, the chosen one its setting)', () => {
    const model = placeholderRunConfirm([node('t', 'Up', codex, 'krea-enhance-topaz-generative-enhance', {})], [], 't', plan('t'))!;
    expect(model.rows[0].model).toBe('Topaz Image Upscale (Krea)');
    expect(model.rows[0].setting).toMatch(/^Model: \S/);
  });

  it('a Krea node app: Version', () => {
    const model = placeholderRunConfirm([node('a', 'App', codex, 'krea-node-app', { node_app_version_id: 'v_123' })], [], 'a', plan('a'))!;
    expect(model.rows[0].setting).toBe('Version: v_123');
  });

  it('two Variants read differently, so a switch is a changed row', () => {
    const a = placeholderRunConfirm([node('k', 'Hero', codex, 'krea-2-generate', { variant: 'medium' })], [], 'k', plan('k'))!;
    const b = placeholderRunConfirm([node('k', 'Hero', codex, 'krea-2-generate', { variant: 'large' })], [], 'k', plan('k'))!;
    expect(JSON.stringify(a.rows)).not.toBe(JSON.stringify(b.rows));
  });

  it('a node with no sub-model setting has none', () => {
    const model = placeholderRunConfirm([node('n', 'Still', codex)], [], 'n', unpriced)!;
    expect(model.rows[0].setting).toBeNull();
  });
});

describe('review 9, L-3: the raw model name is kept for the seen key', () => {
  it('a node labelled with its model id still carries the model (modelKey), though the row hides the repeat', () => {
    const model = placeholderRunConfirm([node('u', 'openai/gpt-4o-mini', codex, 'openrouter-universal', { model: 'openai/gpt-4o-mini' })],
      [], 'u', unpriced)!;
    expect(model.rows[0].model).toBeNull();
    expect(model.rows[0].modelKey).toBe('openai/gpt-4o-mini');
  });
});

describe("review 9, nit c: Krea Style Search's free-text model is a search filter", () => {
  it('its row never presents the filter as the model', () => {
    const model = placeholderRunConfirm([node('s', 'Find', codex, 'krea-style-search', { model: 'flux' })], [], 's', unpriced)!;
    expect(model.rows[0].model).toBe('Krea Style Search');
    expect(model.rows[0].setting).toBeNull();
  });
});

describe('review 9, nit d: the 80-character cut counts code points, as Python does', () => {
  it('81 astral characters cut to 80 whole ones, never half a pair', () => {
    const long = '𝔸'.repeat(81);
    const model = placeholderRunConfirm([node('u', 'Writer', codex, 'openrouter-universal', { model: long })], [], 'u', unpriced)!;
    expect(Array.from(model.rows[0].model!)).toHaveLength(80);
    expect(model.rows[0].model).toBe('𝔸'.repeat(80));
  });
});
