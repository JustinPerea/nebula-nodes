/**
 * PR #203 round 9: one cost class, one key state, one cost-tooltip formatter.
 *
 * - Review 8, LOW-3: the class (directRoute keyBilling), the account it
 *   names (keyBillingAccount) and its label (keyBillingLabel) agree with the
 *   backend case by case (backend/tests/fixtures/key_billing_cases.json), and
 *   nothing else in the app reads the route flag.
 * - Review 8, LOW-1 (GM r17 item 1): the switcher's "key is set" is the one
 *   predicate (isKeySet): a key that is only invisible characters is unset.
 * - GM r16 item 3 and r17 items 3 and 4: every cost tooltip leads with the
 *   paid nodes, priced or not, has no bare "Estimated cost" heading, and the
 *   Accept chip writes the Run chip's reason lines through one formatter.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { acceptChipTitle } from '../src/lib/canvasProposals';
import { hasRoutes, keyBilling, keyBillingAccount, keyBillingLabel } from '../src/lib/directRoute';
import { chipEstimate, chipTitle, type PricingTable } from '../src/lib/pricing';
import { providerKeyWarnings } from '../src/lib/providerSwitch';
import { costTitle, runChipTitle, summarizeRunScope } from '../src/lib/runScope';
import type { ProposalView } from '../src/lib/wsClient';
import type { NodeData } from '../src/types';
import keyBillingCases from '../../backend/tests/fixtures/key_billing_cases.json';

type BillingCase = { definitionId: string; params: Record<string, unknown>; apiKeys: Record<string, string>;
  kind: 'free' | 'mayCost'; account: string; label: string };
const CASES = (keyBillingCases as unknown as { cases: BillingCase[] }).cases;

describe('one cost class, as the backend gives it (review 8, LOW-3)', () => {
  it.each(CASES.map((testCase) => [JSON.stringify(testCase.params), JSON.stringify(testCase.apiKeys), testCase] as const))(
    'params %s, keys %s', (_params, _keys, testCase) => {
      const definition = NODE_DEFINITIONS[testCase.definitionId];
      const kind = keyBilling(definition, testCase.params, testCase.apiKeys);
      const account = keyBillingAccount(definition, testCase.params, testCase.apiKeys);
      expect([kind, account]).toEqual([testCase.kind, testCase.account]);
      expect(keyBillingLabel(kind!, account!)).toBe(testCase.label);
    });

  it('the shared cases cover every key-billing node', () => {
    const flagged = Object.values(NODE_DEFINITIONS).filter((definition) => hasRoutes(definition)
      && keyBilling(definition, {}, {}) !== null).map((definition) => definition.id);
    expect(flagged.length).toBeGreaterThan(0);
    expect(new Set(flagged)).toEqual(new Set(CASES.map((testCase) => testCase.definitionId)));
  });

  it('any other node has no class and no account', () => {
    expect(keyBilling(NODE_DEFINITIONS['nano-banana'], {}, { HF_TOKEN: 'hf_x' })).toBeNull();
    expect(keyBillingAccount(NODE_DEFINITIONS['nano-banana'], {}, { HF_TOKEN: 'hf_x' })).toBeNull();
  });
});

// -- the route flag has one reader -------------------------------------------------------

const SRC = resolve(__dirname, '../src');
const FLAG = 'mayBillWithKey';
// The type that declares it, the data that sets it, and the one function
// that reads it (directRoute keyBilling).
const DECLARES = new Set(['types/index.ts', 'constants/nodeDefinitions.ts']);
const READER = { file: 'lib/directRoute.ts', fn: 'keyBilling' };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The code with every comment blanked out (offsets kept). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** Each place outside the one reader that reads the flag as code. */
export function flagReads(files: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (DECLARES.has(file)) continue;
    const body = code(text);
    for (let at = body.indexOf(FLAG); at !== -1; at = body.indexOf(FLAG, at + 1)) {
      const before = body.slice(0, at);
      const fn = [...before.matchAll(/function\s+(\w+)/g)].pop()?.[1];
      if (file === READER.file && fn === READER.fn) continue;
      found.push(`${file}:${before.split('\n').length} in ${fn ?? '<module>'}`);
    }
  }
  return found;
}

describe('nothing but keyBilling reads the route flag (review 8, LOW-3 and NIT-1)', () => {
  it('in the app', () => {
    const files = Object.fromEntries(sources(SRC).map((path) => [relative(SRC, path), readFileSync(path, 'utf8')]));
    expect(Object.keys(files).length).toBeGreaterThan(100);
    expect(files[READER.file]).toContain(FLAG);
    expect(flagReads(files)).toEqual([]);
  });

  it('catches each disguise of a second derivation', () => {
    const planted = {
      'lib/dot.ts': 'export const may = (spec) => spec.mayBillWithKey === true;\n',
      'lib/index.ts': "export const may = (spec) => spec['mayBillWithKey'];\n",
      'lib/directRoute.ts': 'export function keyBilling(spec) { return spec.mayBillWithKey; }\n'
        + 'export function label(spec) { return spec.mayBillWithKey ? "may cost" : "free"; }\n',
      'lib/fine.ts': '/** mayBillWithKey in a comment */\n// and mayBillWithKey here\nexport const x = 1;\n',
    };
    const reported = flagReads(planted).join(' ');
    expect(reported).toContain('lib/dot.ts');
    expect(reported).toContain('lib/index.ts');
    expect(reported).toContain('lib/directRoute.ts:2 in label');
    expect(reported).not.toContain('in keyBilling');
    expect(reported).not.toContain('lib/fine.ts');
  });
});

// -- one key state (GM r17 item 1; review 8, LOW-1) --------------------------------------

describe('the switcher reads a key as set only when it is (review 8, LOW-1)', () => {
  const flux = [{ id: 'f', data: { definitionId: 'flux-2-pro', label: 'Flux', params: { _provider: 'fal' } } }];
  it.each(['', ' ', '​', '﻿​', ' ⁠\n'])('%j is no key', (value) => {
    expect(providerKeyWarnings(flux, NODE_DEFINITIONS, { FAL_KEY: value }))
      .toEqual(['"Flux" (f) is set to fal.ai, which you have no key for.']);
  });
  it('a padded key is a key', () => {
    expect(providerKeyWarnings(flux, NODE_DEFINITIONS, { FAL_KEY: ' fal-key\n' })).toEqual([]);
  });
});

// -- one cost tooltip (GM r16 item 3; r17 items 3 and 4) ---------------------------------

const pricing: PricingTable = {
  currencies: {},
  nodes: {
    'nano-banana': { currency: 'usd', per: 'image', rows: [{ match: { imageSize: '1K' }, price: 0.13 }] },
    'gpt-image-2-edit': { currency: 'usd', per: 'image', plus: 'input images', rows: [{ match: {}, price: [0.01, 0.2] }] },
  },
} as unknown as PricingTable;
const KEYS = { HF_TOKEN: 'hf_fixture', GOOGLE_API_KEY: 'set', OPENAI_API_KEY: 'set' };
const at = (id: string, definitionId: string, label: string, x: number, params: Record<string, unknown> = {}): Node<NodeData> =>
  ({ id, position: { x, y: 0 }, data: { definitionId, label, params } as unknown as NodeData });

describe('no cost tooltip has a bare "Estimated cost" heading (GM r16 item 3)', () => {
  it('every closed chip form is a sentence', () => {
    for (const [low, high] of [[0, 0], [0.0047, 0.0047], [0.01, 0.0149], [0.13, 0.13], [9.996, 10.2], [0, 0.43], [0.05, 0.43]]) {
      const title = chipTitle(chipEstimate(low, high, false));
      expect(title, `${low}–${high}`).not.toMatch(/^Estimated cost$|^Estimated cost under \$0\.01$/);
      expect(title, `${low}–${high}`).toMatch(/\.$/);
    }
  });

  it('the Run chip without Idol leads with the paid node: "“A” calls a paid provider. Estimated cost $0.13."', () => {
    const summary = summarizeRunScope([at('a', 'nano-banana', 'A', 0)], [], { kind: 'graph' }, { pricing, apiKeys: KEYS });
    expect(runChipTitle(summary)).toBe('“A” calls a paid provider. Estimated cost $0.13.');
  });
});

/** The proposal a run of these canvas nodes would be, as the backend sends
 * it (main._proposal_cost, model_pricing.estimate_run reasons). */
function asProposal(entries: Array<{ ref: string; definitionId: string; name: string; x: number; kind: 'paid' | 'mayCost';
  price?: { low: number; high: number } | null; reason?: Record<string, unknown> }>,
estimate: ProposalView['cost']['estimate']): ProposalView {
  const may = entries.filter((entry) => entry.kind === 'mayCost');
  return {
    id: 'p_r9', run: entries.map((entry) => entry.ref), params: [], edges: [],
    nodes: entries.map((entry) => ({ ref: entry.ref, definitionId: entry.definitionId, name: entry.name,
      position: { x: entry.x, y: 0 }, params: {}, cost: { kind: entry.kind, provider: null, label: '' } })),
    cost: {
      paidRuns: entries.length - may.length, mayCostRuns: may.length,
      mayCost: may.map((entry) => ({ name: entry.name, account: 'Hugging Face' })),
      freeRuns: 0, upTo: false, providers: [], note: '', estimate,
      nodes: entries.map((entry) => ({ ref: entry.ref, nodeId: null, definitionId: entry.definitionId, kind: entry.kind,
        provider: null, label: '', price: entry.price ?? null, ...(entry.reason ? { reason: entry.reason } : {}) })),
    },
  } as unknown as ProposalView;
}

describe('the Accept chip carries the Run chip\'s reason lines, by one formatter (GM r17 item 4)', () => {
  it('unpriced paid nodes beside Idol: the same tooltip on both chips', () => {
    const graph = [at('a', 'nano-banana', 'A', 0), at('b', 'claude-chat', 'B', 100), at('e', 'gpt-image-2-edit', 'Edit', 200),
      at('i', 'speridlabs-idol', 'Idol', 300)];
    const run = runChipTitle(summarizeRunScope(graph, [], { kind: 'graph' }, { pricing, apiKeys: KEYS }));
    expect(run).toBe('“A”, “B” and “Edit” call paid providers. The priced part of this run costs between $0.14 and $0.33.\n'
      + '“B” has no listed price.\n'
      + '“Edit” may cost more for its input images, which the estimate leaves out.\n'
      + 'Idol can use your Hugging Face credits.');
    const view = asProposal([
      { ref: '+a', definitionId: 'nano-banana', name: 'A', x: 0, kind: 'paid', price: { low: 0.13, high: 0.13 } },
      { ref: '+b', definitionId: 'claude-chat', name: 'B', x: 100, kind: 'paid', reason: { kind: 'noPrice' } },
      { ref: '+e', definitionId: 'gpt-image-2-edit', name: 'Edit', x: 200, kind: 'paid', price: { low: 0.01, high: 0.2 },
        reason: { kind: 'leftOut', plus: 'input images' } },
      { ref: '+i', definitionId: 'speridlabs-idol', name: 'Idol', x: 300, kind: 'mayCost' },
    ], { currency: 'usd', low: 0.14, high: 0.33, open: true, unpriced: ['+b'], plan: [], plus: ['input images'] });
    expect(acceptChipTitle(view, () => null)).toBe(run);
  });

  it('only unpriced paid nodes and Idol: no estimate line, each reason, Idol last', () => {
    const view = asProposal([
      { ref: '+b', definitionId: 'claude-chat', name: 'B', x: 0, kind: 'paid', reason: { kind: 'noPrice' } },
      { ref: '+f', definitionId: 'flux-2-pro', name: 'Flux', x: 100, kind: 'paid', reason: { kind: 'missingKey', keys: ['FAL_KEY'] } },
      { ref: '+i', definitionId: 'speridlabs-idol', name: 'Idol', x: 200, kind: 'mayCost' },
    ], null);
    expect(acceptChipTitle(view, () => null)).toBe('“B” and “Flux” call paid providers.\n“B” has no listed price.\n'
      + '“Flux” can’t be priced until its fal.ai API key is added.\nIdol can use your Hugging Face credits.');
  });

  it('reads the reasons left to right, a canvas node where it sits', () => {
    const view = asProposal([
      { ref: '+b', definitionId: 'claude-chat', name: 'B', x: 500, kind: 'paid', reason: { kind: 'noPrice' } },
      { ref: 'n7', definitionId: 'flux-2-pro', name: 'Flux', x: 0, kind: 'paid', reason: { kind: 'missingKey', keys: ['FAL_KEY'] } },
    ], null);
    view.cost.nodes[1].nodeId = 'n7';
    const title = acceptChipTitle(view, (id) => (id === 'n7' ? 'Hero' : null), (id) => (id === 'n7' ? { x: 10, y: 0 } : null))!;
    expect(title.indexOf('“Hero” can’t be priced')).toBeLessThan(title.indexOf('“B” has no listed price.'));
  });

  it('a proposal made before reasons were sent still names its unpriced nodes', () => {
    const view = asProposal([
      { ref: '+a', definitionId: 'nano-banana', name: 'A', x: 0, kind: 'paid', price: { low: 0.13, high: 0.13 } },
      { ref: '+b', definitionId: 'claude-chat', name: 'B', x: 100, kind: 'paid' },
    ], { currency: 'usd', low: 0.13, high: 0.13, open: true, unpriced: ['+b'], plan: [], plus: [] });
    expect(acceptChipTitle(view, () => null))
      .toBe('“A” and “B” call paid providers. The priced part of this run costs about $0.13.\n“B” has no listed price.');
  });

  it('has a tooltip whenever its chip shows, and none when Accept runs nothing', () => {
    const view = asProposal([{ ref: '+a', definitionId: 'nano-banana', name: 'A', x: 0, kind: 'paid', price: { low: 0.13, high: 0.13 } }],
      { currency: 'usd', low: 0.13, high: 0.13, open: false, unpriced: [], plan: [], plus: [] });
    expect(acceptChipTitle(view, () => null)).toBe('“A” calls a paid provider. Estimated cost $0.13.');
    expect(acceptChipTitle({ ...view, run: [] }, () => null)).toBeNull();
  });

  it('costTitle keeps line 1 whole: reasons go under it, never inside it', () => {
    const title = costTitle({ paid: ['A', 'B'], estimate: { low: 0.13, high: 0.13, open: true },
      reasons: [{ name: 'B', reason: { kind: 'noPrice' } }], mayCost: [{ name: 'Idol', account: 'Hugging Face' }] })!;
    expect(title.split('\n')).toEqual(['“A” and “B” call paid providers. The priced part of this run costs about $0.13.',
      '“B” has no listed price.', 'Idol can use your Hugging Face credits.']);
  });
});

describe('the bar\'s line 1 wraps and is never cut (GM r16 item 4)', () => {
  it('no rule for it holds it to one line or clips it', () => {
    const css = readFileSync(resolve(SRC, 'styles/canvasProposals.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]*\.proposal-bar__summary[^{}]*)\{([^}]*)\}/g)].map((match) => match[2]);
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) expect(body).not.toMatch(/nowrap|ellipsis|line-clamp|overflow:\s*hidden|max-height/);
  });
});

describe('every tab hears a key change from anywhere (review 8, NIT-3)', () => {
  it('App starts the socket listener with the app, so no screen misses one', () => {
    expect(readFileSync(resolve(SRC, 'App.tsx'), 'utf8')).toMatch(/^import '\.\/store\/settingsChangedSocket';$/m);
  });
});
