import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { placeholderRunConfirm } from '../../src/lib/placeholderRunConfirm';
import type { RunCost, RunScopeSummary } from '../../src/lib/runScope';

// GM - Design's round-11 rulings (2026-10-26), verbatim, and review 10's row-naming inventory.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const claude = { id: 'ext:claude', name: 'Claude Code', color: '#8AB4F8', verified: true };

function node(id: string, label: string, agent?: typeof codex, definitionId = 'nano-banana', params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label, params, state: 'idle', outputs: {}, ...(agent ? { pending: { agent, at: 1 } } : {}) } } as Node<NodeData>;
}
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, sourceHandle: 'image', targetHandle: 'images' });
const line = (nodeId: string, name: string, low: number, high: number) => ({ nodeId, name, low, high, runs: [1, 1] as [number, number] });
const summaryOf = (cost: Partial<RunCost>): RunScopeSummary => ({ total: 5, paid: [], cost: {
  low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [], ...cost } });
const unpriced = summaryOf({});
const SAVED = 'after the run was saved. The replay uses the saved settings.';

describe('GM round 11: the replay sentence names up to 3 changed nodes, then counts from 4', () => {
  // r10-replay-three-saved: a dotted “Plate” over three muted rows; the sentence must say which three.
  const priced = summaryOf({ low: 0.4, high: 0.4, lines: [line('p', 'Plate', 0.1, 0.1), line('w', 'Wide', 0.1, 0.1),
    line('h', 'Hero still', 0.1, 0.1), line('g', 'Grade', 0.05, 0.05), line('o', 'Final', 0.05, 0.05)] });
  const five = [node('p', 'Plate'), node('w', 'Wide'), node('h', 'Hero still'), node('g', 'Grade'), node('o', 'Final')];
  const wires = [wire('p', 'o'), wire('w', 'o'), wire('h', 'o'), wire('g', 'o')];

  it('three: “Wide”, “Hero still” and “Grade”', () => {
    const model = placeholderRunConfirm(five, wires, 'o', priced, {
      shown: new Map([['p', codex], ['w', codex], ['h', codex], ['g', codex]]), changed: new Set(['w', 'h', 'g']) })!;
    expect(model.heading).toBe('Replay the saved version?');
    expect(model.intro).toBe(`Codex changed “Wide”, “Hero still” and “Grade” ${SAVED}`);
    // The rows under it: the dotted “Plate”, then the three saved versions, muted, in the same order.
    expect(model.rows.map((row) => [row.name, row.agent?.name ?? null])).toEqual([
      ['“Plate”', 'Codex'], ['“Wide”', null], ['“Hero still”', null], ['“Grade”', null], ['“Final”', null]]);
  });

  it('four: the count', () => {
    const model = placeholderRunConfirm(five, wires, 'o', priced, {
      shown: new Map([['p', codex], ['w', codex], ['h', codex], ['g', codex]]), changed: new Set(['p', 'w', 'h', 'g']) })!;
    expect(model.intro).toBe(`Codex changed 4 nodes ${SAVED}`);
  });

  it('the agents form: three names, then a count from four', () => {
    const three = placeholderRunConfirm(five, wires, 'o', priced, {
      shown: new Map([['p', codex], ['w', claude], ['h', codex], ['g', claude]]), changed: new Set(['w', 'h', 'g']) })!;
    expect(three.intro).toBe(`The agents changed “Wide”, “Hero still” and “Grade” ${SAVED}`);
    const four = placeholderRunConfirm(five, wires, 'o', priced, {
      shown: new Map([['p', codex], ['w', claude], ['h', codex], ['g', claude]]), changed: new Set(['p', 'w', 'h', 'g']) })!;
    expect(four.intro).toBe(`The agents changed 4 nodes ${SAVED}`);
  });

  it('under the still-setting-up heading too (savedLine)', () => {
    const nodes = [node('p', 'Plate', codex), node('w', 'Wide', codex), node('h', 'Hero still', codex), node('g', 'Grade', codex), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, wires, 'o', priced, { changed: new Set(['w', 'h', 'g']) })!;
    expect(model.heading).toBe('Run 4 nodes Codex is still setting up?');
    expect(model.savedLine).toBe(`Codex changed “Wide”, “Hero still” and “Grade” ${SAVED}`);
    const all = placeholderRunConfirm(nodes, wires, 'o', priced, { changed: new Set(['p', 'w', 'h', 'g']) })!;
    expect(all.savedLine).toBe(`Codex changed 4 nodes ${SAVED}`);
  });

  it('item 1: the names come in the order the rows read, dotted rows before muted ones', () => {
    // “Grade” is still being set up (a dotted row), “Wide” was finished with changes (a muted row after it),
    // although “Wide” comes first on the canvas.
    const nodes = [node('w', 'Wide'), node('g', 'Grade', codex), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('w', 'o'), wire('g', 'o')], 'o', priced,
      { shown: new Map([['w', codex], ['g', codex]]), changed: new Set(['w', 'g']) })!;
    expect(model.rows.map((row) => row.name).slice(0, 2)).toEqual(['“Grade”', '“Wide”']);
    expect(model.savedLine).toBe(`Codex changed “Grade” and “Wide” ${SAVED}`);
  });

  it('the price footnotes keep their count from 3 (they are about money)', () => {
    const nodes = [node('a', 'Plate', codex), node('b', 'Wide', codex), node('c', 'Grade', codex), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('a', 'o'), wire('b', 'o'), wire('c', 'o')], 'o',
      summaryOf({ low: 0.05, high: 0.05, lines: [line('o', 'Final', 0.05, 0.05)] }))!;
    expect(model.notes).toContain('3 nodes have no list price, so the run may cost more.');
  });
});

describe('GM round 11, item 6: "the agents" in the heading and the left line', () => {
  it('Run 3 nodes the agents are still setting up?', () => {
    const nodes = [node('a', 'A', codex), node('b', 'B', claude), node('c', 'C', codex), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('a', 'o'), wire('b', 'o'), wire('c', 'o')], 'o', unpriced)!;
    expect(model.heading).toBe('Run 3 nodes the agents are still setting up?');
    // The body stays as it was.
    expect(model.intro).toBe("Agents haven't finished these, so their settings may not be final.");
  });

  it('Run without the nodes the agents were setting up?', () => {
    const model = placeholderRunConfirm([node('o', 'Final')], [], 'o', unpriced,
      { shown: new Map([['a', codex], ['b', claude]]) })!;
    expect(model.heading).toBe('Run without the nodes the agents were setting up?');
  });

  it('2 nodes the agents were setting up are no longer in this run.', () => {
    const model = placeholderRunConfirm([node('q', 'Sky', codex), node('o', 'Final')], [wire('q', 'o')], 'o', unpriced,
      { shown: new Map([['q', codex], ['a', codex], ['b', claude]]) })!;
    expect(model.leftLine).toBe('2 nodes the agents were setting up are no longer in this run.');
  });

  it('one agent keeps its name', () => {
    const model = placeholderRunConfirm([node('q', 'Sky', codex), node('o', 'Final')], [wire('q', 'o')], 'o', unpriced,
      { shown: new Map([['q', codex], ['a', codex], ['b', codex]]) })!;
    expect(model.leftLine).toBe('2 nodes Codex was setting up are no longer in this run.');
  });
});

describe('GM round 11, items 4 and 5: rows name the settings that choose which model or engine runs', () => {
  const krea = (definitionId: string, params: Record<string, unknown>) =>
    placeholderRunConfirm([node('k', 'Up', codex, definitionId, params)], [], 'k', unpriced)!.rows[0];

  it('item 4: "Grain model" when grain is on (it picks a model that runs)', () => {
    expect(krea('krea-enhance-topaz-bloom-2-enhance', { grain: true, grain_model: 'gaussian' }).setting).toBe('Grain model: gaussian');
    expect(krea('krea-enhance-topaz-wonder-35-enhance', { grain: true }).setting).toBe('Grain model: silver');
  });

  it('item 4: no grain model runs with grain off, so none is named', () => {
    expect(krea('krea-enhance-topaz-bloom-2-enhance', { grain_model: 'gaussian' }).setting).toBeNull();
    expect(krea('krea-enhance-topaz-wonder-35-enhance', { grain: false, grain_model: 'grey' }).setting).toBeNull();
  });

  it('item 4: a grain model switch is a changed row', () => {
    const a = krea('krea-enhance-topaz-bloom-2-enhance', { grain: true, grain_model: 'silver' });
    const b = krea('krea-enhance-topaz-bloom-2-enhance', { grain: true, grain_model: 'grey' });
    expect(a.setting).not.toBe(b.setting);
  });

  it('item 4: Flavor is a style setting on the same engine, never named', () => {
    expect(krea('krea-enhance-magnific-precise-enhance', { flavor: 'photo' }).setting).toBeNull();
  });

  // Round 12 addendum (b) replaces "Model: default": Krea requires the model (review 11, L-1).
  it('item 5: Topaz Standard with no model chosen reads "Model: not chosen" (round 12)', () => {
    expect(krea('krea-enhance-topaz-standard-enhance', {}).setting).toBe('Model: not chosen');
    expect(krea('krea-enhance-topaz-standard-enhance', { model: '' }).setting).toBe('Model: not chosen');
  });

  it('item 5: a later switch from the default still shows up', () => {
    expect(krea('krea-enhance-topaz-standard-enhance', { model: 'CGI' }).setting).toBe('Model: CGI');
  });

  it("Krea Style Train's Training Model is named by its card label", () => {
    expect(krea('krea-style-train', {}).setting).toBe('Training Model: FLUX Dev');
  });

  it('items 2 and 3 unchanged: Topaz video card labels and the node app\'s "Version"', () => {
    expect(krea('krea-enhance-topaz-video-upscale', {}).setting)
      .toBe('Enhancement model: prob-4 · Frame interpolation model: apo-8');
    expect(krea('krea-node-app', { node_app_version_id: 'v_9' }).setting).toBe('Version: v_9');
  });
});
