import { describe, expect, it } from 'vitest';
import pricingCases from '../../../backend/tests/fixtures/pricing_cases.json';
import routeCases from '../../../backend/tests/fixtures/route_cases.json';
import { applyProviderPick, providerKeyWarnings, providerSwitchState, snapForRoute, type SwitchContext } from '../../src/lib/providerSwitch';
import type { PricingTable } from '../../src/lib/pricing';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import type { ModelNodeDefinition } from '../../src/types';

/** The five-route fixture with its prices (pricing_cases.json `table`) and
 * the Krea-maker and plan-only fixtures (route_cases.json). */
const pricing = pricingCases as unknown as { definitions: Record<string, ModelNodeDefinition>; pricing: PricingTable };
const TABLE = pricing.definitions.table;
const routed = (routeCases as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions;
const KEY = 'fixture-only';

function context(apiKeys: Record<string, string>, extra: Partial<SwitchContext> = {}): SwitchContext {
  return { apiKeys, kreaSignedIn: false, pricing: pricing.pricing, ...extra };
}

describe('providerSwitchState', () => {
  it('lists Auto, every route, and a plan row for the Krea route, with key state and price', () => {
    const state = providerSwitchState(TABLE, {}, context({ BFL_API_KEY: KEY }));
    expect(state.rows.map((row) => [row.id, row.label, row.keyState, row.price])).toEqual([
      ['auto', 'Auto · runs on Black Forest Labs', null, '$0.03'],
      ['bfl', 'Black Forest Labs', 'set', '$0.03'],
      ['fal', 'fal.ai', 'missing', '$0.035*'],
      ['replicate', 'Replicate', 'missing', '$0.04'],
      ['openrouter', 'OpenRouter', 'missing', '-'],
      ['krea', 'Krea · API balance', 'missing', '$0.05'],
      ['krea:plan', 'Krea · plan', 'sign-in', '-'],
    ]);
    expect(state.rows.filter((row) => row.selected).map((row) => row.id)).toEqual(['auto']);
    expect(state.chip).toBe('Auto · BFL');
    expect(state.blocked).toBe(false);
    expect(state.rows.find((row) => row.id === 'fal')?.setup).toEqual({ kind: 'api-key', key: 'FAL_KEY' });
    expect(state.rows.find((row) => row.id === 'krea:plan')?.setup).toEqual({ kind: 'krea-mcp' });
  });

  it('notes the routes that cannot take a setting and prices them "-"', () => {
    const state = providerSwitchState(TABLE, { resolution: '1.5k' }, context({ BFL_API_KEY: KEY }));
    const fal = state.rows.find((row) => row.id === 'fal')!;
    expect(fal.block).toBe("Doesn't take 1.5k");
    expect(fal.price).toBe('-');
    expect(state.rows.find((row) => row.id === 'bfl')?.block).toBeNull();
  });

  it('stops Auto with the reason and the keyed routes that take it, one click each', () => {
    const state = providerSwitchState(TABLE, { resolution: '1.5k' }, context({ FAL_KEY: KEY, REPLICATE_API_TOKEN: KEY }));
    expect(state.rows[0].label).toBe("Auto · can't run: 1.5k isn't on fal.ai");
    expect(state.blocked).toBe(true);
    expect(state.chip).toBe('Auto · fal');
    expect(state.alternatives).toEqual([{ routeId: 'replicate', label: 'Replicate', writes: { _provider: 'replicate', _kreaAuth: 'api-token' } }]);
    expect(state.message).toContain("can't run on fal.ai");
  });

  it('says when no provider has a key, and names the chosen route that lacks one', () => {
    expect(providerSwitchState(TABLE, {}, context({})).rows[0].label).toBe("Auto · can't run: no provider key set");
    const chosen = providerSwitchState(TABLE, { _provider: 'replicate' }, context({ BFL_API_KEY: KEY }));
    expect(chosen.chip).toBe('Rep');
    expect(chosen.blocked).toBe(true);
    expect(chosen.rows.find((row) => row.id === 'replicate')?.selected).toBe(true);
    expect(chosen.alternatives).toEqual([{ routeId: 'bfl', label: 'Black Forest Labs', writes: { _provider: 'bfl', _kreaAuth: 'api-token' } }]);
  });

  it('keeps the Krea API row and plan row apart, and each pick writes both billing params', () => {
    const api = providerSwitchState(TABLE, { _provider: 'krea', _kreaAuth: 'api-token' }, context({ KREA_API_TOKEN: KEY }));
    expect(api.rows.filter((row) => row.selected).map((row) => row.id)).toEqual(['krea']);
    expect(api.chip).toBe('Krea');
    const plan = providerSwitchState(TABLE, { _provider: 'krea', _kreaAuth: 'mcp' }, context({}, { kreaSignedIn: true }));
    expect(plan.rows.filter((row) => row.selected).map((row) => row.id)).toEqual(['krea:plan']);
    expect(plan.chip).toBe('Krea plan');
    expect(plan.blocked).toBe(false);
    expect(plan.rows.find((row) => row.id === 'krea:plan')?.keyState).toBe('signed-in');
    expect(api.rows.find((row) => row.id === 'krea')?.writes).toEqual({ _provider: 'krea', _kreaAuth: 'api-token' });
    expect(api.rows.find((row) => row.id === 'krea:plan')?.writes).toEqual({ _provider: 'krea', _kreaAuth: 'mcp' });
    // Every other pick writes the billing mode too, so an earlier plan pick
    // never stays saved for a later Krea pick to bill.
    expect(plan.rows.find((row) => row.id === 'fal')?.writes).toEqual({ _provider: 'fal', _kreaAuth: 'api-token' });
    expect(plan.rows[0].writes).toEqual({ _provider: 'auto', _kreaAuth: 'api-token' });
    const offered = providerSwitchState(TABLE, { _provider: 'fal', _kreaAuth: 'mcp' }, context({ KREA_API_TOKEN: KEY }, { kreaSignedIn: true }));
    expect(offered.alternatives).toEqual([{ routeId: 'krea', label: 'Krea', writes: { _provider: 'krea', _kreaAuth: 'api-token' } }]);
    // Signed out, the plan run can't start: the chip warns.
    expect(providerSwitchState(TABLE, { _provider: 'krea', _kreaAuth: 'mcp' }, context({})).blocked).toBe(true);
  });

  it('shows one plan row for a plan-only route, and Auto on a Krea-maker node can run on the plan', () => {
    const video = providerSwitchState(routed['routes-video'], {}, context({ BFL_API_KEY: KEY }));
    expect(video.rows.map((row) => row.id)).toEqual(['auto', 'bfl', 'openrouter', 'krea-plan:plan']);
    const krea = providerSwitchState(routed['routes-krea'], { _kreaAuth: 'mcp' }, context({}, { kreaSignedIn: true }));
    expect(krea.rows[0].label).toBe('Auto · runs on Krea plan');
    expect(krea.chip).toBe('Auto · Krea plan');
    // Where Krea is the maker, Auto bills the saved mode: the Auto row keeps it.
    expect(krea.rows[0].writes).toEqual({ _provider: 'auto' });
    // A plan-only route's row bills the plan; every other row the API.
    expect(video.rows.find((row) => row.id === 'krea-plan:plan')?.writes).toEqual({ _provider: 'krea-plan', _kreaAuth: 'mcp' });
    expect(video.rows.find((row) => row.id === 'bfl')?.writes).toEqual({ _provider: 'bfl', _kreaAuth: 'api-token' });
  });

  it('counts wired inputs against a route port limit', () => {
    const keys = { OPENROUTER_API_KEY: KEY };
    const five = providerSwitchState(TABLE, { _provider: 'openrouter' }, context(keys, { wired: new Map([['images', 5]]) }));
    expect(five.blocked).toBe(true);
    expect(five.rows.find((row) => row.id === 'openrouter')?.block).toBe('Takes at most 4 images');
    const four = providerSwitchState(TABLE, { _provider: 'openrouter' }, context(keys, { wired: new Map([['images', 4]]) }));
    expect(four.blocked).toBe(false);
  });

  it("shows a route's note on its API row (Krea 3's early access), not on the plan row", () => {
    const krea3 = (NODE_DEFINITIONS as Record<string, ModelNodeDefinition>)['krea-3'];
    const state = providerSwitchState(krea3, {}, context({ KREA_API_TOKEN: KEY }));
    expect(state.rows.map((row) => [row.id, row.info])).toEqual([
      ['auto', undefined],
      ['krea', "Early access: Krea 3 on Krea's API is for beta workspaces"],
      ['krea:plan', undefined],
      ['fal', undefined],
    ]);
  });
});

describe('snapForRoute (a person switching provider)', () => {
  it('moves each saved value the new route does not take to its closest value there, with a note each', () => {
    const { params, notes } = snapForRoute(TABLE, { resolution: '1.5k', aspect_ratio: '9:21', grounding: true }, 'fal');
    expect(params).toEqual({ resolution: '2k', aspect_ratio: '16:9', grounding: true });
    expect(notes).toEqual(["9:21 isn't on fal.ai: set to 16:9", "1.5k isn't on fal.ai: set to 2k"]);
  });

  it('clamps a number into the route range', () => {
    expect(snapForRoute(TABLE, { safety_tolerance: 6 }, 'bfl')).toEqual({
      params: { safety_tolerance: 4 }, notes: ["6 isn't on Black Forest Labs: set to 4"],
    });
  });

  it('leaves values the route takes, and values it never shows, alone', () => {
    expect(snapForRoute(TABLE, { resolution: '2k', safety_tolerance: 3 }, 'bfl')).toEqual({
      params: { resolution: '2k', safety_tolerance: 3 }, notes: [],
    });
  });

  it('snaps onto the route Auto takes when the person picks Auto', () => {
    const picked = applyProviderPick(TABLE, { _provider: 'bfl', resolution: '1.5k' }, { writes: { _provider: 'auto' }, routeId: null },
      { apiKeys: { FAL_KEY: KEY } });
    expect(picked.params).toEqual({ _provider: 'auto', resolution: '2k' });
    expect(picked.notes).toEqual(["1.5k isn't on fal.ai: set to 2k"]);
  });

  it('a Krea plan pick writes the provider and the billing mode', () => {
    const picked = applyProviderPick(TABLE, { resolution: '4k' }, { writes: { _provider: 'krea', _kreaAuth: 'mcp' }, routeId: 'krea' },
      { apiKeys: {} });
    expect(picked.params._provider).toBe('krea');
    expect(picked.params._kreaAuth).toBe('mcp');
    expect(picked.params.resolution).toBe('2k');
  });
});

describe('providerKeyWarnings (the .nebula import summary)', () => {
  const definitions = { table: TABLE };
  it('names nodes set to a provider with no key, and Auto nodes with no key at all', () => {
    const nodes = [
      { id: 'n1', data: { definitionId: 'table', label: 'Hero', params: { _provider: 'replicate' } } },
      { id: 'n2', data: { definitionId: 'table', label: 'Plan', params: { _provider: 'krea', _kreaAuth: 'mcp' } } },
      { id: 'n3', data: { definitionId: 'table', label: 'Auto', params: {} } },
      { id: 'n4', data: { definitionId: 'text-input', label: 'Prompt', params: {} } },
    ];
    expect(providerKeyWarnings(nodes, definitions, { FAL_KEY: KEY })).toEqual([
      '"Hero" (n1) is set to Replicate, which you have no key for.',
    ]);
    expect(providerKeyWarnings(nodes, definitions, {})).toEqual([
      '"Hero" (n1) is set to Replicate, which you have no key for.',
      '"Auto" (n3) is on Auto, and none of its providers has a key here.',
    ]);
  });
});
