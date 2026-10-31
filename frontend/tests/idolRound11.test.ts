/**
 * PR #203 round 11: one chip rule, a sourced $0 that reads as any free run,
 * merged reason lines, Krea's one verb and the article fix.
 *
 * - GM r20: "+" joins money, "·" joins classes (costChip), so the Run chip
 *   reads "$0.07 + unpriced · 1 on Krea plan" and the Accept chip "2 paid ·
 *   1 on Krea plan".
 * - GM r20 item 1: a sourced $0 shows no chip, as free runs don't, and its
 *   tooltip stays "This costs nothing to run.".
 * - GM r20 item 2: a reason line naming line 1's nodes merges into it.
 * - GM r21 items 5 and 6, and the one Krea verb, "Sign in to Krea in Settings".
 * - Review 10, NIT-3: the placeholder dialog's row for a sourced $0 is "free".
 * - Review 10, copy MEDIUM-2: "an Anthropic", never "a Anthropic".
 * - Review 10, copy LOW-1: the bar's actions wrap (the live check measures
 *   them at 700, 760 and 1024 px).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { acceptCountChip, proposalSummary } from '../src/lib/canvasProposals';
import { classCounts, costChip } from '../src/lib/costClass';
import type { PricingTable } from '../src/lib/pricing';
import { placeholderRunConfirm, PRICE_FREE } from '../src/lib/placeholderRunConfirm';
import { modelReadiness, withArticle } from '../src/lib/providerReadiness';
import { providerSwitchState } from '../src/lib/providerSwitch';
import { costTitle, runChipLabel, runChipTitle, summarizeRunScope, type RunCost, type RunScopeSummary } from '../src/lib/runScope';
import { keyChangedLine } from '../src/lib/settingsWrites';
import type { ProposalView } from '../src/lib/wsClient';
import type { ModelNodeDefinition, NodeData } from '../src/types';
import pricingCases from '../../backend/tests/fixtures/pricing_cases.json';
import shippedTable from '../../backend/data/model_pricing.json';

const fixture = pricingCases as unknown as { definitions: Record<string, ModelNodeDefinition>; pricing: PricingTable };
const pricing = { ...shippedTable, nodes: { ...shippedTable.nodes, ...fixture.pricing.nodes } } as unknown as PricingTable;
const at = (id: string, definitionId: string, label: string, x: number, params: Record<string, unknown> = {}): Node<NodeData> =>
  ({ id, position: { x, y: 0 }, data: { definitionId, label, params } as unknown as NodeData });

const added = Object.keys(fixture.definitions).filter((id) => !(id in NODE_DEFINITIONS));
beforeAll(() => { for (const id of added) NODE_DEFINITIONS[id] = fixture.definitions[id]; });
afterAll(() => { for (const id of added) delete NODE_DEFINITIONS[id]; });

describe('one chip rule: "+" joins money, "·" joins classes (GM r20)', () => {
  it('builds every chip', () => {
    expect(costChip('$0.07 + unpriced', classCounts({ plan: 1 }))).toBe('$0.07 + unpriced · 1 on Krea plan');
    expect(costChip(null, classCounts({ paid: 2, plan: 1 }))).toBe('2 paid · 1 on Krea plan');
    expect(costChip('~$0.13', classCounts({ mayCost: 1 }))).toBe('~$0.13 · 1 may cost');
    expect(costChip(null, classCounts({ paid: 2, plan: 1, mayCost: 1 }))).toBe('2 paid · 1 on Krea plan · 1 may cost');
    expect(costChip('~$0.04', [])).toBe('~$0.04');
    expect(costChip(null, classCounts({}))).toBeNull();
  });

  it('the Run chip: a priced part, an unpriced one and a run on the Krea plan', () => {
    const graph = [at('i', 'img', 'Poster', 0, { quality: 'low', size: '1024x1024' }), at('w', 'claude-chat', 'Writer', 100),
      at('k', 'table', 'Krea 2', 200, { _provider: 'krea', _kreaAuth: 'mcp' })];
    const summary = summarizeRunScope(graph, [], { kind: 'graph' },
      { pricing, apiKeys: { OPENAI_API_KEY: 'set', ANTHROPIC_API_KEY: 'set' } });
    expect(runChipLabel(summary)).toMatch(/^~?\$0\.01 \+ unpriced · 1 on Krea plan$/);
    expect(runChipLabel(summary)).not.toMatch(/ \+ 1 /);
  });

  it('the Accept chip', () => {
    const view = { run: ['+a'], cost: { paidRuns: 2, planRuns: 1, mayCostRuns: 0, freeRuns: 0, nodes: [], providers: [] } } as unknown as ProposalView;
    expect(acceptCountChip(view)).toBe('2 paid · 1 on Krea plan');
  });
});

describe('a sourced $0 reads as any free run (GM r20 item 1)', () => {
  it('no chip, alone or beside another free node, and the tooltip stays', () => {
    const alone = summarizeRunScope([at('z', 'zeroed', 'Free one', 0)], [], { kind: 'graph' }, { pricing, apiKeys: { FAL_KEY: 'set' } });
    expect(runChipLabel(alone)).toBeNull();
    expect(runChipTitle(alone)).toBe('This costs nothing to run.');
    const local = summarizeRunScope([at('t', 'text-input', 'Prompt', 0)], [], { kind: 'graph' }, { pricing, apiKeys: {} });
    expect(runChipLabel(local)).toBe(runChipLabel(alone));
  });
});

describe('a reason line naming line 1’s nodes merges into it (GM r20 item 2)', () => {
  it('the same nodes: one line; other nodes: their own', () => {
    expect(costTitle({ paid: ['Writer', 'Editor'], reasons: [{ name: 'Writer', reason: 'noPrice' }, { name: 'Editor', reason: 'noPrice' }] } as never))
      .toBe('“Writer” and “Editor” call paid providers that have no listed price.');
    expect(costTitle({ paid: ['Writer'], reasons: [{ name: 'Writer', reason: 'noPrice' }] } as never))
      .toBe('“Writer” calls a paid provider that has no listed price.');
    const apart = costTitle({ paid: ['Writer', 'Editor'], reasons: [{ name: 'Writer', reason: 'noPrice' }] } as never)!;
    expect(apart.split('\n')).toEqual(['“Writer” and “Editor” call paid providers.', '“Writer” has no listed price.']);
  });
});

describe('Krea’s one verb and the plan-only line (GM r21 items 5 and 6)', () => {
  it('the switcher says the node runs on the plan, with its name in quotes', () => {
    const state = providerSwitchState(NODE_DEFINITIONS['krea-3'], { _provider: 'krea', _kreaAuth: 'mcp' }, {
      apiKeys: {}, kreaSignedIn: false, pricing: shippedTable as unknown as PricingTable });
    expect(state.message).toBe(`“${NODE_DEFINITIONS['krea-3'].displayName}” runs on your Krea plan. `
      + 'Sign in to Krea in Settings, or choose another provider.');
  });

  it('a plan-only proposal starts with "Runs" when the run leads', () => {
    const cost = { paidRuns: 0, planRuns: 1, mayCostRuns: 0, freeRuns: 0, nodes: [], providers: [] };
    expect(proposalSummary({ nodes: [], edges: [], params: [], run: ['n1'], cost } as unknown as ProposalView))
      .toBe('Runs 1 node on your Krea plan');
    expect(proposalSummary({ nodes: [{ ref: '+k' }], edges: [], params: [], run: ['+k'], cost } as unknown as ProposalView))
      .toBe('Adds 1 node · runs 1 node on your Krea plan');
  });
});

describe('the placeholder dialog’s row for a sourced $0 (review 10, NIT-3)', () => {
  it('reads "free", and the total isn’t missing for it', () => {
    const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
    const nodes = [
      { id: 'z', type: 'model-node', position: { x: 0, y: 0 },
        data: { definitionId: 'zeroed', label: 'Free one', params: {}, state: 'idle', outputs: {}, pending: { agent: codex, at: 1 } } },
      { id: 'o', type: 'model-node', position: { x: 100, y: 0 },
        data: { definitionId: 'text-input', label: 'Out', params: {}, state: 'idle', outputs: {} } },
    ] as unknown as Node<NodeData>[];
    const edges: Edge[] = [{ id: 'z-o', source: 'z', target: 'o', sourceHandle: 'image', targetHandle: 'images' }];
    const cost: RunCost = { low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [],
      ids: { unpriced: [], plan: [], awaitingInput: [], free: ['z'] } };
    const summary: RunScopeSummary = { total: 2, paid: [], free: ['Free one'], cost };
    const model = placeholderRunConfirm(nodes, edges, 'o', summary, { apiKeys: { FAL_KEY: 'set' } });
    const row = model?.rows.find((entry) => entry.nodeId === 'z');
    expect(row?.price).toBe(PRICE_FREE);
    expect(PRICE_FREE).toBe('free');
  });
});

describe('articles and the key notices (review 10, copy MEDIUM-2; GM r21 item 4)', () => {
  it('"an" before a vowel and before xAI', () => {
    expect(withArticle('Anthropic')).toBe('an Anthropic');
    expect(withArticle('OpenAI')).toBe('an OpenAI');
    expect(withArticle('fal.ai')).toBe('a fal.ai');
    expect(withArticle('xAI')).toBe('an xAI');
    expect(withArticle('Replicate')).toBe('a Replicate');
  });

  it('a missing key reads "Add your …", never "Add a Anthropic"', () => {
    const def = Object.values(NODE_DEFINITIONS).find((entry) => entry.apiProvider === 'anthropic' && !('routes' in entry))!;
    const ready = modelReadiness(def, {}, { loaded: true, apiKeys: {} } as never, { loading: false } as never);
    expect(ready.detail ?? '').not.toMatch(/\ba [AEIOU]/);
  });

  it('a key notice names the key once', () => {
    expect(keyChangedLine('REPLICATE_API_TOKEN', true)).toBe('Replicate key saved.');
    expect(keyChangedLine('REPLICATE_API_TOKEN', false)).toBe('Replicate key removed.');
    expect(keyChangedLine('KREA_API_TOKEN', true)).toBe('Krea · API key saved.');
    expect(keyChangedLine('KREA_USAGE_KEY', false)).toBe('Krea · usage key removed.');
  });
});

describe('the bar’s actions wrap (review 10, copy LOW-1)', () => {
  it('never clips: they wrap, right-aligned', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/canvasProposals.css'), 'utf8');
    const rule = css.match(/\n\.proposal-bar__actions \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    expect(rule).toMatch(/justify-content:\s*flex-end/);
    expect(rule).toMatch(/min-width:\s*0/);
  });
});
