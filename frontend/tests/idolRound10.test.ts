/**
 * PR #203 round 10: one cost class with the Krea plan and the sourced $0 in
 * it, one cost formatter for every Run surface, and a key change that keeps
 * every check it didn't touch.
 *
 * - GM r18 item 1, r19 item 1 (review 9, cost MEDIUM-1): the class
 *   (costClass) agrees with the backend's (model_pricing.cost_class) case by
 *   case (pricing_cases.json classCases). A sourced $0 is free; a run on the
 *   Krea plan is its own class, "1 on Krea plan", with its own reason line.
 * - GM r19 item 2 (review 9, cost LOW-1): the Run buttons' title and
 *   screen-reader text are the chip's tooltip; a second derivation of any
 *   cost sentence fails the ratchet.
 * - Review 9, cost LOW-3 (mutant C11): no card label is written outside
 *   keyBillingLabel; the account (C12) is pinned in sharedKeyedPaths.test.ts.
 * - Review 9, cost NIT-2: an unknown reason kind reads as no listed price.
 * - GM r19 item 7 (review 9, keys LOW-2): a key change clears only that
 *   key's connection check.
 * - Review 9, keys NIT-2: Settings stores a key only when the backend would
 *   (key_text_cases.json storeCases), before anything is written.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { acceptChipTitle, acceptCountChip, entryReason, proposalSummary } from '../src/lib/canvasProposals';
import { costClass } from '../src/lib/costClass';
import type { PricingTable } from '../src/lib/pricing';
import { PROVIDER_KEYS } from '../src/lib/providerCatalog';
import { providerSwitchState } from '../src/lib/providerSwitch';
import { describeRunScope, runChipLabel, runChipTitle, summarizeRunScope, type RunScopeSummary } from '../src/lib/runScope';
import { SETTINGS_SAVED_EVENT, changedKeys, settingsSavedDetail } from '../src/lib/settingsSignal';
import { storableKey } from '../src/lib/settingsWrites';
import type { ProposalCostReason, ProposalView } from '../src/lib/wsClient';
import { useProviderReadinessStore } from '../src/store/providerReadinessStore';
import { useUIStore } from '../src/store/uiStore';
import type { ModelNodeDefinition, NodeData } from '../src/types';
import pricingCases from '../../backend/tests/fixtures/pricing_cases.json';
import keyTextCases from '../../backend/tests/fixtures/key_text_cases.json';
import shippedTable from '../../backend/data/model_pricing.json';

const SRC = resolve(__dirname, '../src');

const at = (id: string, definitionId: string, label: string, x: number, params: Record<string, unknown> = {}): Node<NodeData> =>
  ({ id, position: { x, y: 0 }, data: { definitionId, label, params } as unknown as NodeData });

// -- one cost class, as the backend gives it -----------------------------------------------

type ClassCase = {
  name: string; nodes: Array<{ id: string; nodeId: string; params: Record<string, unknown> }>; apiKeys: Record<string, string>;
  expected: { paid: string[]; plan: string[]; free: string[]; mayCost: string[]; low: number | null; high: number | null; sourcedZero: boolean };
};
const fixture = pricingCases as unknown as {
  definitions: Record<string, ModelNodeDefinition>; pricing: PricingTable; classCases: ClassCase[];
};
// The fixture's prices over the shipped table, as the backend case reads them.
const classPricing = { ...shippedTable, nodes: { ...shippedTable.nodes, ...fixture.pricing.nodes } } as unknown as PricingTable;

describe('one cost class, as the backend gives it (GM r18 item 1, r19 item 1)', () => {
  const added = Object.keys(fixture.definitions).filter((id) => !(id in NODE_DEFINITIONS));
  beforeAll(() => { for (const id of added) NODE_DEFINITIONS[id] = fixture.definitions[id]; });
  afterAll(() => { for (const id of added) delete NODE_DEFINITIONS[id]; });

  it('covers each class', () => {
    const classes = new Set(fixture.classCases.flatMap((testCase) => (['paid', 'plan', 'free', 'mayCost'] as const)
      .filter((name) => testCase.expected[name].length > 0)));
    expect(classes).toEqual(new Set(['paid', 'plan', 'free', 'mayCost']));
  });

  it.each(fixture.classCases.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const graph = testCase.nodes.map((node, index) => at(node.id, node.nodeId, node.id, index * 100, node.params));
    const summary = summarizeRunScope(graph, [], { kind: 'graph' }, { pricing: classPricing, apiKeys: testCase.apiKeys });
    const may = (summary.mayCost ?? []).map((row) => row.name);
    const plan = summary.plan ?? [];
    const sourced = summary.free ?? [];
    const classOf = (id: string) => (summary.paid.includes(id) ? 'paid' : plan.includes(id) ? 'plan'
      : may.includes(id) ? 'mayCost' : 'free');
    const got = Object.fromEntries((['paid', 'plan', 'free', 'mayCost'] as const).map((name) => [name,
      testCase.nodes.map((node) => node.id).filter((id) => classOf(id) === name).sort()]));
    const expected = Object.fromEntries((['paid', 'plan', 'free', 'mayCost'] as const).map((name) => [name, [...testCase.expected[name]].sort()]));
    expect(got).toEqual(expected);
    // `free` lists the sourced $0 nodes (a key-billing route with no key is free, unlisted), as the backend's does.
    expect(sourced.sort()).toEqual(testCase.nodes.filter((node) => node.nodeId === 'zeroed').map((node) => node.id).sort());
    expect(summary.cost!.plan.sort()).toEqual([...testCase.expected.plan].sort());
    // The figure covers the paid nodes only.
    expect(summary.cost!.lines.every((line) => testCase.expected.paid.includes(line.name))).toBe(true);
    if (testCase.expected.high === null) expect(summary.cost!.lines).toEqual([]);
    else expect(summary.cost!.high).toBeCloseTo(testCase.expected.high, 9);
    expect(summary.cost!.sourcedZero === true).toBe(testCase.expected.sourcedZero);
    for (const id of testCase.expected.plan) {
      expect(summary.cost!.reasons?.find((entry) => entry.name === id)?.reason).toEqual({ kind: 'plan' });
    }
    // Each node's class, from the one function.
    for (const node of testCase.nodes) {
      if (classOf(node.id) === 'free' && node.nodeId === 'zeroed') continue; // free by its price, read with the estimate
      expect(costClass(NODE_DEFINITIONS[node.nodeId], node.params, testCase.apiKeys), node.id).toBe(classOf(node.id));
    }
  });
});

describe('the class of a node by its own price (GM r18 item 1)', () => {
  const nano = NODE_DEFINITIONS['nano-banana'];
  it('free only for a sourced $0: USD, exactly 0, nothing left out', () => {
    expect(costClass(nano, {}, {}, { currency: 'usd', low: 0, high: 0 })).toBe('free');
    expect(costClass(nano, {}, {}, { currency: 'usd', low: 0, high: 0, plus: 'input images' })).toBe('paid');
    expect(costClass(nano, {}, {}, { currency: 'usd', low: 0, high: 0.01 })).toBe('paid');
    expect(costClass(nano, {}, {}, { currency: 'credits', low: 0, high: 0 })).toBe('paid');
    expect(costClass(nano, {}, {}, null)).toBe('paid');
    expect(costClass(nano, {}, {})).toBe('paid');
  });
});

describe('the switcher\'s price rows say a sentence (GM r19 item 4)', () => {
  it('list price, estimate and the Krea plan', () => {
    const state = providerSwitchState(NODE_DEFINITIONS['krea-3'], {}, {
      apiKeys: { FAL_KEY: 'set', BFL_API_KEY: 'set', KREA_API_TOKEN: 'set' }, kreaSignedIn: true,
      pricing: shippedTable as unknown as PricingTable,
    });
    const titles = new Set(state.rows.map((row) => row.priceTitle).filter(Boolean));
    expect(Object.fromEntries(state.rows.map((row) => [row.id, row.priceTitle ?? null]))).toEqual({ auto: null,
      krea: 'List price per run at these settings.', 'krea:plan': 'Runs on your Krea plan.',
      fal: 'An estimate, because the provider’s page doesn’t state this price exactly.' });
    expect(titles).toContain('List price per run at these settings.');
    expect(titles).toContain('An estimate, because the provider’s page doesn’t state this price exactly.');
    expect(titles).toContain('Runs on your Krea plan.');
    for (const title of titles) expect(title).toMatch(/\.$/);
  });
});

// -- the Krea plan is counted apart (GM r19 item 1) ----------------------------------------

const KEYS = { HF_TOKEN: 'hf_fixture', GOOGLE_API_KEY: 'set', ANTHROPIC_API_KEY: 'set' };
const PLAN = { _kreaAuth: 'mcp' };

describe('a run on the Krea plan is its own class (GM r19 item 1; review 9, cost MEDIUM-1)', () => {
  const pricing = shippedTable as unknown as PricingTable;

  it('"2 paid · 1 on Krea plan" beside unpriced paid nodes, and the tooltip in GM\'s order', () => {
    const graph = [at('a', 'claude-chat', 'A', 0), at('b', 'claude-chat', 'B', 100), at('k', 'krea-2-generate', 'Krea 2', 200, PLAN),
      at('i', 'speridlabs-idol', 'Idol', 300)];
    const summary = summarizeRunScope(graph, [], { kind: 'graph' }, { pricing, apiKeys: KEYS });
    expect(summary.paid).toEqual(['A', 'B']);
    expect(summary.plan).toEqual(['Krea 2']);
    expect(runChipLabel(summary)).toBe('2 paid · 1 on Krea plan · 1 may cost');
    // The paid lead, the figure (none here), the reason lines with the plan's, Idol's sentence.
    expect(runChipTitle(summary)).toBe('“A” and “B” call paid providers.\n'
      + '“A” and “B” have no listed price.\n'
      + '“Krea 2” runs on your Krea plan.\n'
      + 'Idol can use your Hugging Face credits.');
  });

  it('beside a priced part: the amount for the paid nodes, the plan apart', () => {
    const graph = [at('n', 'nano-banana', 'Hero', 0), at('k', 'krea-2-generate', 'Krea 2', 100, PLAN)];
    const summary = summarizeRunScope(graph, [], { kind: 'graph' }, { pricing, apiKeys: KEYS });
    const label = runChipLabel(summary)!;
    expect(label).toMatch(/^~\$\d+\.\d\d \+ 1 on Krea plan$/);
    const title = runChipTitle(summary)!.split('\n');
    expect(title[0]).toMatch(/^“Hero” calls a paid provider\. Estimated cost \$/);
    expect(title.slice(1)).toEqual(['“Krea 2” runs on your Krea plan.']);
    expect(summary.cost!.lines.map((line) => line.name)).toEqual(['Hero']);
  });

  it('alone: "1 on Krea plan", never "paid", never "billed"', () => {
    const summary = summarizeRunScope([at('k', 'krea-2-generate', 'Krea 2', 0, PLAN), at('m', 'krea-2-generate', 'Krea 2b', 50, PLAN)],
      [], { kind: 'graph' }, { pricing, apiKeys: {} });
    expect(runChipLabel(summary)).toBe('2 on Krea plan');
    expect(runChipTitle(summary)).toBe('“Krea 2” and “Krea 2b” run on your Krea plan.');
    expect(runChipTitle(summary)).not.toMatch(/paid|billed/i);
  });

  it('the Accept chip counts it the same way and writes the same lines', () => {
    const graph = [at('a', 'claude-chat', 'A', 0), at('b', 'claude-chat', 'B', 100), at('k', 'krea-2-generate', 'Krea 2', 200, PLAN)];
    const run = runChipTitle(summarizeRunScope(graph, [], { kind: 'graph' }, { pricing, apiKeys: KEYS }));
    const entry = (ref: string, name: string, x: number, kind: 'paid' | 'plan', reason: ProposalCostReason) => ({ ref, name, x, kind, reason });
    const entries = [entry('+a', 'A', 0, 'paid', { kind: 'noPrice' }), entry('+b', 'B', 100, 'paid', { kind: 'noPrice' }),
      entry('+k', 'Krea 2', 200, 'plan', { kind: 'plan' })];
    const view = {
      id: 'p', run: entries.map((row) => row.ref), params: [], edges: [],
      nodes: entries.map((row) => ({ ref: row.ref, definitionId: 'claude-chat', name: row.name, position: { x: row.x, y: 0 }, params: {},
        cost: { kind: row.kind, provider: null, label: row.kind === 'plan' ? 'on Krea plan' : '' } })),
      cost: { paidRuns: 2, planRuns: 1, freeRuns: 0, mayCostRuns: 0, mayCost: [], upTo: false, providers: [], note: '',
        estimate: null,
        nodes: entries.map((row) => ({ ref: row.ref, nodeId: null, definitionId: 'claude-chat', kind: row.kind, provider: null,
          label: '', price: null, reason: row.reason })) },
    } as unknown as ProposalView;
    expect(acceptCountChip(view)).toBe('2 paid · 1 on Krea plan');
    expect(acceptChipTitle(view, () => null)).toBe(run);
    // Line 1 counts it outside "paid".
    expect(proposalSummary(view)).toBe('Adds 3 nodes · runs 2 paid models · 1 on Krea plan');
    const planOnly = { ...view, run: ['+k'], cost: { ...view.cost, paidRuns: 0, nodes: [view.cost.nodes[2]] } } as ProposalView;
    expect(acceptCountChip(planOnly)).toBe('1 on Krea plan');
    expect(proposalSummary(planOnly)).toBe('Adds 3 nodes · runs 1 node on your Krea plan');
  });
});

// -- a sourced $0 is free (GM r18 item 1) --------------------------------------------------

describe('a sourced $0 is free (GM r18 item 1)', () => {
  const added = Object.keys(fixture.definitions).filter((id) => !(id in NODE_DEFINITIONS));
  beforeAll(() => { for (const id of added) NODE_DEFINITIONS[id] = fixture.definitions[id]; });
  afterAll(() => { for (const id of added) delete NODE_DEFINITIONS[id]; });

  it('alone: "$0", and the tooltip is only "This costs nothing to run."', () => {
    const summary = summarizeRunScope([at('z', 'zeroed', 'Zero', 0)], [], { kind: 'graph' }, { pricing: classPricing, apiKeys: { FAL_KEY: 'set' } });
    expect([summary.paid, runChipLabel(summary), runChipTitle(summary)]).toEqual([[], '$0', 'This costs nothing to run.']);
    expect(describeRunScope(summary)).toBe('Runs 1 node.\nThis costs nothing to run.');
  });

  it('beside a paid node: never in "N paid", the paid lead or the figure', () => {
    const graph = [at('z', 'zeroed', 'Zero', 0), at('i', 'img', 'Img', 100, { quality: 'low', size: '1024x1024' })];
    const summary = summarizeRunScope(graph, [], { kind: 'graph' }, { pricing: classPricing, apiKeys: { FAL_KEY: 'set', OPENAI_API_KEY: 'set' } });
    expect(summary.paid).toEqual(['Img']);
    expect(runChipTitle(summary)).toBe('“Img” calls a paid provider. Estimated cost $0.01.');
  });
});

// -- one formatter for the Run buttons (GM r19 item 2; review 9, cost LOW-1) ----------------

describe('the Run buttons\' text is the chip\'s tooltip (GM r19 item 2)', () => {
  const pricing = shippedTable as unknown as PricingTable;
  const graphs: Record<string, Node<NodeData>[]> = {
    priced: [at('n', 'nano-banana', 'Hero', 0)],
    unpriced: [at('a', 'claude-chat', 'A', 0), at('n', 'nano-banana', 'Hero', 100)],
    plan: [at('k', 'krea-2-generate', 'Krea 2', 0, PLAN), at('a', 'claude-chat', 'A', 100)],
    idol: [at('i', 'speridlabs-idol', 'Idol', 0), at('n', 'nano-banana', 'Hero', 100)],
    local: [at('t', 'text-input', 'Text', 0)],
  };
  it.each(Object.entries(graphs))('%s', (_name, graph) => {
    const summary = summarizeRunScope(graph, [], { kind: 'graph' }, { pricing, apiKeys: KEYS });
    const text = describeRunScope(summary);
    const title = runChipTitle(summary);
    const count = `Runs ${summary.total} node${summary.total === 1 ? '' : 's'}.`;
    expect(text).toBe(title ? `${count}\n${title}` : `${count} No paid providers.`);
    // No per-node breakdown: no "×" and no figure but the chip's.
    expect(text).not.toMatch(/×|\(Hero \$/);
  });
});

/** Each function in each file that calls `name` (a call, not its definition). */
function callers(files: Record<string, string>, name: string): string[] {
  const found = new Set<string>();
  const call = new RegExp(`\\b${name}\\s*\\(`, 'g');
  for (const [file, text] of Object.entries(files)) {
    const body = code(text);
    for (const match of body.matchAll(call)) {
      const before = body.slice(0, match.index);
      if (/function\s*$/.test(before)) continue;
      const fn = [...before.matchAll(/function\s+(\w+)/g)].pop()?.[1] ?? '<module>';
      found.add(`${file}:${fn}`);
    }
  }
  return [...found].sort();
}

/** The code with every comment blanked out (offsets kept). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const APP = () => Object.fromEntries(sources(SRC).map((path) => [relative(SRC, path), readFileSync(path, 'utf8')]));

// Who may build each piece of a cost tooltip, and who may read the class's parts.
const ALLOWED: Record<string, string[]> = {
  // The tooltip: the Run chip's and the Accept chip's, and the Run buttons' through describeRunScope.
  costTitle: ['lib/canvasProposals.ts:acceptChipTitle', 'lib/runScope.ts:runChipTitle'],
  runChipTitle: ['components/SelectionToolbar.tsx:runSelection', 'components/panels/Toolbar.tsx:Toolbar', 'lib/runScope.ts:describeRunScope'],
  paidSentence: ['lib/runScope.ts:costTitle'],
  estimateSentence: ['lib/runScope.ts:costTitle'],
  reasonSentences: ['lib/runScope.ts:costTitle'],
  mayCostSentence: ['lib/canvasProposals.ts:proposalMayCostSentence', 'lib/runScope.ts:costTitle'],
  // Per-node figures: the costly-run confirm, the switcher's rows and the placeholder dialog's rows.
  formatUsdRange: ['lib/placeholderRunConfirm.ts:rowPrice', 'lib/providerSwitch.ts:price', 'lib/runScope.ts:runCostConfirmMessage'],
  // The class's parts: costClass, and the places that route or show readiness, never count.
  keyBilling: ['lib/costClass.ts:costClass', 'lib/directRoute.ts:keyBillingAccount'],
  usesKreaAccount: ['components/nodes/ModelNode.tsx:ModelNodeComponent', 'components/panels/Inspector.tsx:clearParam',
    'lib/canvasProposals.ts:ghostKeyWarning', 'lib/costClass.ts:costClass', 'lib/directRoute.ts:selectRoute',
    'lib/kreaConnection.ts:ownKeyStatus', 'lib/providerReadiness.ts:modelReadiness'],
};

describe('one derivation of each cost sentence and of the class (review 9, cost LOW-1 and LOW-3)', () => {
  it('in the app', () => {
    const files = APP();
    expect(Object.keys(files).length).toBeGreaterThan(100);
    const got = Object.fromEntries(Object.keys(ALLOWED).map((name) => [name, callers(files, name)]));
    expect(got).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([name, list]) => [name, [...list].sort()])));
  });

  it('catches a second derivation', () => {
    const planted = {
      'components/panels/Toolbar.tsx': 'export function Toolbar() { return runChipTitle(s); }\n'
        + 'function breakdown(cost) { return `Estimated ${formatUsdRange(cost.low, cost.high)}`; }\n',
      'lib/runScope.ts': 'export function describeRunScope(s) { return paidSentence(s.paid); }\n',
      'lib/other.ts': 'export const counts = (d, p, k) => keyBilling(d, p, k) === "mayCost" || usesKreaAccount(d, p);\n',
      'lib/fine.ts': '/** keyBilling( in a comment */\n// costTitle(here)\nexport function keyBilling(d) { return d; }\n',
    };
    expect(callers(planted, 'formatUsdRange')).toEqual(['components/panels/Toolbar.tsx:breakdown']);
    expect(callers(planted, 'paidSentence')).toEqual(['lib/runScope.ts:describeRunScope']);
    expect(callers(planted, 'keyBilling')).toEqual(['lib/other.ts:<module>']);
    expect(callers(planted, 'usesKreaAccount')).toEqual(['lib/other.ts:<module>']);
    expect(callers(planted, 'costTitle')).toEqual([]);
  });
});

/** Each place outside keyBillingLabel that writes a card label's
 * "<class> · <account>" shape. */
function labelTemplates(files: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const body = code(text);
    for (const match of body.matchAll(/\b(?:may cost|free)\b[^\n·]{0,40}·\s*\$\{/g)) {
      const before = body.slice(0, match.index);
      const fn = [...before.matchAll(/function\s+(\w+)/g)].pop()?.[1] ?? '<module>';
      if (file === 'lib/directRoute.ts' && fn === 'keyBillingLabel') continue;
      found.push(`${file}:${before.split('\n').length} in ${fn}`);
    }
  }
  return found;
}

describe('no card label is written outside keyBillingLabel (review 9, cost LOW-3, mutant C11)', () => {
  it('in the app', () => {
    const files = APP();
    expect(code(files['lib/directRoute.ts'])).toMatch(/may cost' : 'free'\} · \$\{account\}/);
    expect(labelTemplates(files)).toEqual([]);
  });

  it('catches an inline label', () => {
    const planted = {
      'lib/canvasProposals.ts': "export function liveKeyBilling() { const label = `${billing === 'mayCost' ? 'may cost' : 'free'} · ${account}`; }\n",
      'lib/runScope.ts': 'export function x() { return `free · ${name}`; }\nexport function y() { return `${n} may cost`; }\n',
    };
    expect(labelTemplates(planted)).toEqual(['lib/canvasProposals.ts:1 in liveKeyBilling', 'lib/runScope.ts:1 in x']);
  });
});

// -- an unknown reason kind (review 9, cost NIT-2) -----------------------------------------

describe('a reason kind this tab doesn\'t know reads as no listed price (review 9, cost NIT-2)', () => {
  it('in entryReason', () => {
    expect(entryReason({ kind: 'fromTheFuture' } as unknown as ProposalCostReason)).toEqual({ kind: 'noPrice' });
    expect(entryReason({ kind: 'plan' })).toEqual({ kind: 'plan' });
    expect(entryReason({ kind: 'missingKey', keys: ['FAL_KEY'] })).toEqual({ kind: 'missingKey', key: 'fal.ai API key' });
  });

  it('and the Accept chip still draws', () => {
    const view = {
      id: 'p', run: ['+b'], params: [], edges: [],
      nodes: [{ ref: '+b', definitionId: 'claude-chat', name: 'B', position: { x: 0, y: 0 }, params: {}, cost: { kind: 'paid', provider: null, label: '' } }],
      cost: { paidRuns: 1, freeRuns: 0, mayCostRuns: 0, mayCost: [], upTo: false, providers: [], note: '', estimate: null,
        nodes: [{ ref: '+b', nodeId: null, definitionId: 'claude-chat', kind: 'paid', provider: null, label: '', price: null,
          reason: { kind: 'fromTheFuture' } }] },
    } as unknown as ProposalView;
    expect(acceptChipTitle(view, () => null)).toBe('“B” calls a paid provider.\n“B” has no listed price.');
  });

  it('a summary with a reason kind runScope never wrote still reads', () => {
    const summary = { total: 1, paid: ['B'], cost: { low: 0, high: 0, lines: [], unpriced: ['B'], plan: [], plus: [], awaitingInput: [],
      sizeRefs: [], reasons: [{ name: 'B', reason: { kind: 'fromTheFuture' } }] } } as unknown as RunScopeSummary;
    expect(runChipTitle(summary)).toBe('“B” calls a paid provider.\n“B” has no listed price.');
  });
});

// -- every provider's link names it (GM r19 item 5) ----------------------------------------

describe('every key link is "Open <provider> keys", the provider\'s own word, no domain (GM r19 item 5)', () => {
  it.each(PROVIDER_KEYS.map((spec) => [spec.key, spec] as const))('%s', (_key, spec) => {
    expect(spec.keyLink).toMatch(/^Open \S.* (keys|tokens|service accounts)$/);
    // A host only where it is the provider's own name (fal.ai).
    const host = new URL(spec.url).host;
    if (host !== spec.label) expect(spec.keyLink).not.toContain(host);
    expect(spec.keyLink).not.toMatch(/https?:|\.com\b|key page/i);
    if (spec.credential === 'token') expect(spec.keyLink).toMatch(/ tokens$/);
  });
});

// -- a key change clears only its own check (GM r19 item 7) --------------------------------

describe('a key change keeps every connection check it didn\'t touch (GM r19 item 7; review 9, keys LOW-2)', () => {
  const entry = { configured: true, status: 'valid' as const, last_checked: '2026-10-30T12:00:00Z' };
  const seed = () => useProviderReadinessStore.setState({ providers: { OpenAI: entry, FAL: entry, 'Hugging Face': entry }, checkedAt: 1 });
  const send = (type: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(type, detail === undefined ? undefined : { detail }));
  afterEach(() => useProviderReadinessStore.getState().invalidate());

  it('a key changed elsewhere clears that provider\'s alone', () => {
    seed();
    send(SETTINGS_SAVED_EVENT, { source: 'remote', keys: ['OPENAI_API_KEY'] });
    expect(Object.keys(useProviderReadinessStore.getState().providers).sort()).toEqual(['FAL', 'Hugging Face']);
  });

  it('a save here that changed a key does the same', () => {
    seed();
    send(SETTINGS_SAVED_EVENT, { source: 'local', keys: ['HF_TOKEN'] });
    expect(Object.keys(useProviderReadinessStore.getState().providers).sort()).toEqual(['FAL', 'OpenAI']);
  });

  it('so does a read of the keys that finds one changed (a reconnect\'s, any refresh): that key\'s alone', () => {
    useUIStore.getState().setSettingsCache({ OPENAI_API_KEY: '***aaaa', FAL_KEY: '***ffff' });
    seed();
    // The same keys read back, padded: nothing changed.
    useUIStore.getState().setSettingsCache({ OPENAI_API_KEY: '***aaaa ', FAL_KEY: '***ffff' });
    expect(Object.keys(useProviderReadinessStore.getState().providers)).toHaveLength(3);
    useUIStore.getState().setSettingsCache({ OPENAI_API_KEY: '***aaaa', FAL_KEY: '***gggg', HF_TOKEN: '***hhhh' });
    expect(Object.keys(useProviderReadinessStore.getState().providers)).toEqual(['OpenAI']);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false } });
  });

  it('a change of no key (a favourite, a folder) and a reconnect keep them all', () => {
    seed();
    send(SETTINGS_SAVED_EVENT, { source: 'local', keys: [] });
    send(SETTINGS_SAVED_EVENT, { source: 'reconnect' });
    expect(Object.keys(useProviderReadinessStore.getState().providers)).toHaveLength(3);
  });

  it('a signal that doesn\'t say (an older sender) clears them all', () => {
    seed();
    send(SETTINGS_SAVED_EVENT);
    expect(useProviderReadinessStore.getState().providers).toEqual({});
  });

  it('reads a detail only in its own shape, and names a key by its masked value', () => {
    expect(settingsSavedDetail(new CustomEvent('x', { detail: { source: 'remote', keys: ['A', 1] } }))).toEqual({ source: 'remote', keys: ['A'] });
    expect(settingsSavedDetail(new CustomEvent('x', { detail: { source: 'elsewhere' } }))).toBeNull();
    expect(settingsSavedDetail(new Event('x'))).toBeNull();
    expect(changedKeys({ A: '***1', B: '***2' }, { A: '***1', B: '***3', C: '***4' })).toEqual(['B', 'C']);
  });
});

// -- Settings stores a key only when the backend would (review 9, keys NIT-2) --------------

describe('a key Settings stores is one the backend keeps (key_text_cases.json storeCases)', () => {
  type StoreCase = { key: string; raw: string; stored: string | null };
  const cases = (keyTextCases as unknown as { storeCases: StoreCase[] }).storeCases;
  it.each(cases.map((testCase) => [testCase.key, JSON.stringify(testCase.raw), testCase] as const))('%s %s', (_key, _raw, testCase) => {
    expect(storableKey(testCase.key, testCase.raw)).toBe(testCase.stored);
  });
});
