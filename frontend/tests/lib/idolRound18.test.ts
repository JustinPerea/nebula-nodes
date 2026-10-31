// PR #203 round 18, GM r34 item 2: the switcher's Auto row drops the colon.
// "Auto · fal.ai doesn’t take “Resolution” set to 1.5K": every Auto reason
// kind reads as a fragment after "Auto · ", names the provider that can't
// take the run, and never says "can’t run:".
import { describe, expect, it } from 'vitest';
import routeCases from '../../../backend/tests/fixtures/route_cases.json';
import { providerSwitchState } from '../../src/lib/providerSwitch';
import { notReadyShown } from '../../src/lib/canvasProposals';
import { routeAction } from '../../src/lib/directRoute';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import type { ModelNodeDefinition } from '../../src/types';

const KEY = 'fixture-only';
const base = (routeCases as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions['routes-image'];

/** routes-image with one fal.ai route under `rules` (and `keys`), so Auto is that route. */
function oneRoute(rules: Record<string, unknown>, keys = ['FAL_KEY']): ModelNodeDefinition {
  const fal = base.routes!.find((route) => route.id === 'fal')!;
  return { ...base, id: 'auto-fixture', routes: [{ ...fal, keys, rules, maker: true }] } as ModelNodeDefinition;
}

/** routes-image with fal.ai and Replicate routes holding these keys. */
function twoRoutes(falKeys: string[], replicateKeys: string[]): ModelNodeDefinition {
  const route = (id: string) => base.routes!.find((spec) => spec.id === id)!;
  return { ...base, id: 'auto-fixture-2', routes: [{ ...route('fal'), keys: falKeys, maker: true },
    { ...route('replicate'), keys: replicateKeys }] } as ModelNodeDefinition;
}

function autoLabel(definition: ModelNodeDefinition, params: Record<string, unknown>, apiKeys: Record<string, string>,
  wired: Record<string, number> = {}): string {
  return providerSwitchState(definition, params, { apiKeys, kreaSignedIn: false, pricing: null,
    wired: new Map(Object.entries(wired)) }).rows[0].label;
}

const CASES: [string, string, string][] = [
  ['rejects', autoLabel(oneRoute({ rejects: { resolution: ['4k'] } }), { resolution: '4k' }, { FAL_KEY: KEY }),
    'Auto · fal.ai doesn’t take “Resolution” set to 4k'],
  ['blocked', autoLabel(oneRoute({ blockedBy: ['safety_tolerance'] }), { safety_tolerance: 3 }, { FAL_KEY: KEY }),
    'Auto · fal.ai doesn’t take “Safety tolerance”'],
  ['requires', autoLabel(oneRoute({ requires: 'safety_tolerance' }), {}, { FAL_KEY: KEY }),
    'Auto · fal.ai needs “Safety tolerance”'],
  ['size', autoLabel(oneRoute({ size: { param: 'resolution', unsupported: ['4k'] } }), { resolution: '4k' }, { FAL_KEY: KEY }),
    'Auto · fal.ai can’t make that size'],
  ['retired', autoLabel(oneRoute({ retires: { on: '2000-01-01' } }), {}, { FAL_KEY: KEY }),
    'Auto · fal.ai no longer runs this model'],
  ['ports', autoLabel(oneRoute({ ports: { images: { max: 1 } } }), {}, { FAL_KEY: KEY }, { images: 2 }),
    'Auto · fal.ai doesn’t take this many images'],
  ['hidden', autoLabel(NODE_DEFINITIONS['flux-3-image-klein'], { seed: 7 }, { OPENROUTER_API_KEY: KEY }),
    'Auto · OpenRouter doesn’t take “Seed”'],
  ['no key', autoLabel(oneRoute({}), {}, {}), 'Auto · needs a key'],
  // GM r35 item 2: the providers' own noun, from providerCatalog.credentialNoun.
  ['no Replicate token', autoLabel(oneRoute({}, ['REPLICATE_API_TOKEN']), {}, {}), 'Auto · needs a token'],
  ['no Hugging Face token', autoLabel(oneRoute({}, ['HF_TOKEN']), {}, {}), 'Auto · needs a token'],
  ['a key or a token', autoLabel(twoRoutes(['FAL_KEY'], ['REPLICATE_API_TOKEN']), {}, {}), 'Auto · needs a key'],
];

describe('the Auto row has no colon and leads with the provider (GM r34 item 2, r35 item 2)', () => {
  it('GM’s line, word for word', () => {
    expect(autoLabel(NODE_DEFINITIONS['flux-3-image'], { resolution: '1.5K' }, { FAL_KEY: KEY }))
      .toBe('Auto · fal.ai doesn’t take “Resolution” set to 1.5K');
  });

  it.each(CASES)('every reason kind reads as a fragment after "Auto · " (%s)', (_kind, label, expected) => {
    expect(label).toBe(expected);
    expect(label).not.toMatch(/can.t run|:\s/);
    // Subject first (GM r35 item 2): the provider leads, or "needs a key/token" when none can.
    expect(label).toMatch(/^Auto · (?:(?:fal\.ai|OpenRouter|Black Forest Labs|Replicate|Krea) |needs a (?:key|token)$)/);
  });

  it('no Auto row in the route cases says "can’t run:" or a colon', () => {
    const cases = (routeCases as unknown as { definitions: Record<string, ModelNodeDefinition>;
      cases: { nodeId: string; params: Record<string, unknown>; apiKeys?: Record<string, string> }[] });
    const definitions = { ...(NODE_DEFINITIONS as Record<string, ModelNodeDefinition>), ...cases.definitions };
    let blocked = 0;
    for (const { nodeId, params, apiKeys } of cases.cases) {
      const definition = definitions[nodeId];
      if (!definition) continue;
      const state = providerSwitchState(definition, { ...params, _provider: 'auto' }, { apiKeys: apiKeys ?? {}, kreaSignedIn: false, pricing: null });
      if (state.rows[0].label.startsWith('Auto · runs on')) continue;
      blocked += 1;
      expect(state.rows[0].label).not.toMatch(/can.t run|:\s/);
    }
    expect(blocked).toBeGreaterThan(5);
  });
});

describe('the bar: r24 for the summary, the per-reason count inside the list (GM r35 item 1)', () => {
  const KEY_REASON = { one: 'needs your OpenAI API key. Add it in Settings.', many: 'need your OpenAI API key. Add it in Settings.' };
  const ROUTE_REASON = { one: 'is set to Replicate, which needs your Replicate token. Add it in Settings.',
    many: 'are set to Replicate, which needs your Replicate token. Add it in Settings.' };
  const row = (i: number, name: string, reason: { one: string; many: string }) => ({
    ref: `n${i}`, nodeId: `n${i}`, name, missing: 'needs OPENAI_API_KEY in Settings > Providers',
    person: `“${name}” ${reason.one}`, reason });

  it('4 nodes on one reason: the summary counts, the list says the count in the reason’s sentence', () => {
    const rows = ['A', 'B', 'C', 'D'].map((name, i) => row(i, name, KEY_REASON));
    const shown = notReadyShown(rows, null);
    expect(shown.lines.map((line) => line.text)).toEqual(['4 nodes can’t run here yet.']);
    expect(shown.inDetails.map((line) => line.text)).toEqual(['4 nodes need your OpenAI API key. Add it in Settings.']);
  });

  it('two reasons: one sentence each in the list, the summary counts every node', () => {
    const rows = [...['A', 'B', 'C', 'D'].map((name, i) => row(i, name, KEY_REASON)), row(4, 'E', ROUTE_REASON)];
    const shown = notReadyShown(rows, null);
    expect(shown.lines.map((line) => line.text)).toEqual(['5 nodes can’t run here yet.']);
    expect(shown.inDetails.map((line) => line.text)).toEqual([
      '4 nodes need your OpenAI API key. Add it in Settings.',
      '“E” is set to Replicate, which needs your Replicate token. Add it in Settings.']);
  });
});

// Round 18, section 2: review 17's copy findings and GM r36 B4.
describe('Krea’s sign-in line never names a provider that can’t take the run (review 17 LOW-3)', () => {
  const krea3 = () => NODE_DEFINITIONS['krea-3'];
  const plan = { _provider: 'krea', _kreaAuth: 'mcp' };
  const line = (params: Record<string, unknown>) => providerSwitchState(krea3(), { ...plan, ...params },
    { apiKeys: { FAL_KEY: KEY }, kreaSignedIn: false, pricing: null }).message;

  it('fal.ai takes it: named', () => {
    expect(line({})).toBe(`“${krea3().displayName}” runs on your Krea plan. Sign in to Krea in Settings, or switch to fal.ai.`);
  });

  it('fal.ai’s key is set but it refuses high reasoning with no image: "or choose another provider"', () => {
    expect(line({ reasoning_level: 'high' })).toBe(
      `“${krea3().displayName}” runs on your Krea plan. Sign in to Krea in Settings, or choose another provider.`);
  });
});

describe('the switcher row’s size note (review 17 LOW-4)', () => {
  it('reads “Can’t make that size.” with a curly apostrophe', () => {
    const definition = oneRoute({ size: { param: 'resolution', unsupported: ['4k'] } });
    const state = providerSwitchState(definition, { resolution: '4k' }, { apiKeys: { FAL_KEY: KEY }, kreaSignedIn: false,
      pricing: null });
    expect(state.rows.map((row) => row.block).filter(Boolean)).toEqual(['Can’t make that size.']);
  });
});

describe('two actions take a comma when either holds its own "or" (GM r36 B4)', () => {
  it.each([
    [{ text: 'Pick 1K', options: 1 }, ['fal.ai', 'Replicate'], 'Pick 1K, or switch to fal.ai or Replicate.'],
    [{ text: 'Pick 1K', options: 1 }, ['fal.ai'], 'Pick 1K or switch to fal.ai.'],
    [{ text: 'Pick 1K or 2K', options: 2 }, ['fal.ai'], 'Pick 1K or 2K, or switch to fal.ai.'],
    [{ text: 'Turn “Raw” off', options: 1 }, ['fal.ai', 'Replicate'], 'Turn “Raw” off, or switch to fal.ai or Replicate.'],
  ] as const)('%o with %o', (fix, others, expected) => {
    expect(routeAction(fix, others, [], null)).toBe(expected);
  });
});
