import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { placeholderRunConfirm } from '../../src/lib/placeholderRunConfirm';
import type { RunCost, RunScopeSummary } from '../../src/lib/runScope';

// Review 8 (L-a, L-b) with GM - Design's ruling on L-b (2026-10-26), verbatim.

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

describe('review 8, L-a: a row names the model a free-text model param picks, as the card shows it', () => {
  it.each([
    ['openrouter-universal', { model: 'openai/gpt-4o-mini' }, 'openai/gpt-4o-mini'],
    ['nous-portal-universal', { model: 'Hermes-4-405B' }, 'Hermes-4-405B'],
    ['replicate-universal', { model_id: 'black-forest-labs/flux-schnell' }, 'black-forest-labs/flux-schnell'],
    ['fal-universal', { endpoint_id: 'fal-ai/flux/dev' }, 'fal-ai/flux/dev'],
    ['krea-agent', { model: 'krea-1' }, 'krea-1'],
  ])('%s', (definitionId, params, shown) => {
    const nodes = [node('u', 'Writer', codex, definitionId, params)];
    const model = placeholderRunConfirm(nodes, [], 'u', unpriced)!;
    expect(model.rows[0].model).toBe(shown);
  });

  it('two OpenRouter models read differently, so a switch is a changed row', () => {
    const a = placeholderRunConfirm([node('u', 'Writer', codex, 'openrouter-universal', { model: 'openai/gpt-4o-mini' })], [], 'u', unpriced)!;
    const b = placeholderRunConfirm([node('u', 'Writer', codex, 'openrouter-universal', { model: 'anthropic/claude-opus-4.1' })], [], 'u', unpriced)!;
    expect(a.rows[0].model).not.toBe(b.rows[0].model);
  });

  it('no model chosen yet: the node type, as before', () => {
    const model = placeholderRunConfirm([node('u', 'Writer', codex, 'openrouter-universal', { model: '' })], [], 'u', unpriced)!;
    expect(model.rows[0].model).toBe('OpenRouter');
  });

  it("a select param labelled Model (Meshy's ai_model) names its option", () => {
    const nodes = [node('m', 'Sheet', codex, 'meshy-text-to-image', { ai_model: 'gpt-image-2' })];
    const model = placeholderRunConfirm(nodes, [], 'm', unpriced)!;
    expect(model.rows[0].model).toBe('GPT Image 2');
  });
});

describe("GM - Design on review 8 L-b: a replay's placeholder its agent changed after the run was saved", () => {
  const priced = summaryOf({ low: 0.2, high: 0.2, lines: [line('h', 'Hero still', 0.1, 0.1), line('o', 'Final', 0.1, 0.1)] });

  it('finished and changed: "Replay the saved version?", the saved version as a muted row', () => {
    const nodes = [node('h', 'Hero still'), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o')], 'o', priced,
      { shown: new Map([['h', codex]]), changed: new Set(['h']) } as never)!;
    expect(model.heading).toBe('Replay the saved version?');
    // GM - Design, round 10, item 1: the sentence names the node.
    expect(model.intro).toBe('Codex changed “Hero still” after the run was saved. The replay uses the saved settings.');
    expect(model.savedLine).toBeNull();
    expect(model.leftLine).toBeNull();
    expect(model.rows.map((row) => [row.nodeId, row.agent])).toEqual([['h', null], ['o', null]]);
    expect(model.runLabel).toBe('Run for $0.20');
  });

  it('two changed: both named (GM round 10)', () => {
    const nodes = [node('h', 'Hero still'), node('p', 'Plate'), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o'), wire('p', 'o')], 'o', priced,
      { shown: new Map([['h', codex], ['p', codex]]), changed: new Set(['h', 'p']) } as never)!;
    expect(model.heading).toBe('Replay the saved version?');
    expect(model.intro).toBe('Codex changed “Hero still” and “Plate” after the run was saved. The replay uses the saved settings.');
  });

  it('several agents: "The agents changed …"', () => {
    const nodes = [node('h', 'Hero still'), node('p', 'Plate'), node('o', 'Final')];
    const two = placeholderRunConfirm(nodes, [wire('h', 'o'), wire('p', 'o')], 'o', priced,
      { shown: new Map([['h', codex], ['p', claude]]), changed: new Set(['h', 'p']) } as never)!;
    expect(two.intro).toBe('The agents changed “Hero still” and “Plate” after the run was saved. The replay uses the saved settings.');
  });

  it('still unfinished placeholders: the still-setting-up heading wins, the sentence under its body, before the left line', () => {
    // q is still Codex's placeholder; h was finished with new settings; g left the run.
    const nodes = [node('q', 'Sky', codex), node('h', 'Hero still'), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('q', 'o'), wire('h', 'o')], 'o', priced,
      { shown: new Map([['q', codex], ['h', codex], ['g', codex]]), changed: new Set(['h']) } as never)!;
    expect(model.heading).toBe('Run 1 node Codex is still setting up?');
    expect(model.intro).toBe("Codex hasn't finished this, so its settings may not be final.");
    expect(model.savedLine).toBe('Codex changed “Hero still” after the run was saved. The replay uses the saved settings.');
    expect(model.leftLine).toBe('1 node Codex was setting up is no longer in this run.');
    expect(model.rows.find((row) => row.nodeId === 'h')?.agent).toBeNull();
    expect(model.rows.find((row) => row.nodeId === 'q')?.agent).toEqual(codex);
  });

  it('a placeholder still being set up whose settings differ from the saved ones counts too', () => {
    const nodes = [node('h', 'Hero still', codex), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o')], 'o', priced, { changed: new Set(['h']) } as never)!;
    expect(model.heading).toBe('Run 1 node Codex is still setting up?');
    expect(model.savedLine).toBe('Codex changed “Hero still” after the run was saved. The replay uses the saved settings.');
  });

  it('finished with the saved settings: "Run with Codex\'s changes?" as before, no sentence', () => {
    const nodes = [node('h', 'Hero still'), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o')], 'o', priced,
      { shown: new Map([['h', codex]]), changed: new Set() } as never)!;
    expect(model.heading).toBe("Run with Codex's changes?");
    expect(model.intro).toBe('Codex finished setting up this node.');
    expect(model.savedLine).toBeNull();
  });

  it('a normal node the agents never set up is never "changed" in these words', () => {
    const nodes = [node('h', 'Hero still', codex), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o')], 'o', priced, { changed: new Set(['o']) } as never)!;
    expect(model.savedLine).toBeNull();
  });

  it('Cinema: the Generate forms of the button', () => {
    const nodes = [node('h', 'Hero still'), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o')], 'o', priced,
      { verb: 'Generate', shown: new Map([['h', codex]]), changed: new Set(['h']) } as never)!;
    expect(model.heading).toBe('Replay the saved version?');
    expect(model.runLabel).toBe('Generate for $0.20');
  });
});
