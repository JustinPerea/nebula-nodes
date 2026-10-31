import { describe, expect, it } from 'vitest';
import pricingCases from '../../../backend/tests/fixtures/pricing_cases.json';
import routeCases from '../../../backend/tests/fixtures/route_cases.json';
import switchCases from '../../../backend/tests/fixtures/switch_cases.json';
import clientDefinitions from '../../../backend/tests/fixtures/route_client_definitions.json';
import {
  applyFix, applyProviderPick, fixLabel, providerKeyWarnings, providerSwitchState, snapForRoute, snapHidden,
  type SwitchContext,
} from '../../src/lib/providerSwitch';
import { allParamDefinitions, shownRouteId, withWiredBlockers } from '../../src/lib/directRoute';
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
    expect(fal.block).toBe("Doesn’t take “Resolution” set to 1.5k.");
    expect(fal.price).toBe('-');
    expect(state.rows.find((row) => row.id === 'bfl')?.block).toBeNull();
  });

  it('stops Auto with the reason and the keyed routes that take it, one click each', () => {
    const state = providerSwitchState(TABLE, { resolution: '1.5k' }, context({ FAL_KEY: KEY, REPLICATE_API_TOKEN: KEY }));
    expect(state.rows[0].label).toBe("Auto · fal.ai doesn’t take “Resolution” set to 1.5k");
    expect(state.blocked).toBe(true);
    expect(state.chip).toBe('Auto · fal');
    expect(state.alternatives).toEqual([{ routeId: 'replicate', label: 'Replicate', writes: { _provider: 'replicate', _kreaAuth: 'api-token' } }]);
    expect(state.message).toContain('can’t run on fal.ai');
  });

  it("names keys by provider and never a route id or env-var name in the stop line (error copy round 3e)", () => {
    const flux2 = NODE_DEFINITIONS['flux-2-pro'];
    const env = /[A-Z0-9]+_(API_KEY|API_TOKEN|TOKEN|KEY|CREDENTIALS|USAGE_KEY)\b/;
    const chosen = providerSwitchState(flux2, { _provider: 'bfl' }, context({}));
    expect(chosen.blocked).toBe(true);
    expect(chosen.message).toBe(
      '“FLUX.2” is set to Black Forest Labs, which needs your Black Forest Labs API key. Add it in Settings.');
    const unknown = providerSwitchState(flux2, { _provider: 'xyz' }, context({ BFL_API_KEY: KEY }));
    expect(unknown.message).toBe('“FLUX.2” is set to a provider that isn’t in its list. Choose one in its provider switcher.');
    const auto = providerSwitchState(flux2, {}, context({}));
    expect(auto.message).toMatch(/^Add your .* in Settings, then run the node again\.$/);
    for (const state of [chosen, unknown, auto]) {
      expect(state.message).not.toMatch(env);
      expect(state.message).not.toMatch(/Settings > Providers|'xyz'|\bauto\b|\(/);
    }
  });

  it('says when no provider has a key, and names the chosen route that lacks one', () => {
    expect(providerSwitchState(TABLE, {}, context({})).rows[0].label).toBe('Auto · needs a key');
    const chosen = providerSwitchState(TABLE, { _provider: 'replicate' }, context({ BFL_API_KEY: KEY }));
    // Round 3g (GM, rule 9): the full name wherever it fits the chip.
    expect(chosen.chip).toBe('Replicate');
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
    expect(five.rows.find((row) => row.id === 'openrouter')?.block).toBe('Takes at most 4 images.');
    const four = providerSwitchState(TABLE, { _provider: 'openrouter' }, context(keys, { wired: new Map([['images', 4]]) }));
    expect(four.blocked).toBe(false);
  });

  it('counts FLUX 3 Video\'s start image, keyframes and end image against one ten-image cap', () => {
    const video = (NODE_DEFINITIONS as Record<string, ModelNodeDefinition>)['flux-3-video'];
    const keys = { BFL_API_KEY: KEY, FAL_KEY: KEY, REPLICATE_API_TOKEN: KEY };
    const twelve = new Map([['start_image', 1], ['keyframes', 10], ['end_image', 1]]);
    const state = providerSwitchState(video, {}, context(keys, { wired: twelve }));
    expect(state.blocked).toBe(true);
    expect(state.rows[0].label).toBe("Auto · Black Forest Labs doesn’t take this many images");
    for (const id of ['bfl', 'fal', 'replicate']) {
      expect(state.rows.find((row) => row.id === id)?.block).toBe('Takes at most 10 images.');
    }
    const ten = new Map([['start_image', 1], ['keyframes', 8], ['end_image', 1]]);
    expect(providerSwitchState(video, {}, context(keys, { wired: ten })).blocked).toBe(false);
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
    // Grounding is another route's own setting, saved on: fal doesn't offer
    // it and BFL would honor it, so the click turns it off (rule H, PR 5).
    expect(params).toEqual({ resolution: '2k', aspect_ratio: '16:9', grounding: false });
    expect(notes).toEqual(["9:21 isn't on fal.ai: set to 16:9", "1.5k isn't on fal.ai: set to 2k",
      "Grounding isn't on fal.ai: turned off"]);
  });

  it('clamps a number into the route range', () => {
    expect(snapForRoute(TABLE, { safety_tolerance: 6 }, 'bfl')).toEqual({
      params: { safety_tolerance: 4 }, notes: ["6 isn't on Black Forest Labs: set to 4"],
    });
  });

  it('rounds a half up when it snaps an integer, as the Python twin does (node_route._closest_value)', () => {
    const flux2 = (NODE_DEFINITIONS as Record<string, ModelNodeDefinition>)['flux-2-pro'];
    expect(snapForRoute(flux2, { model: 'flex', num_inference_steps: 2.5 }, 'fal')).toEqual({
      params: { model: 'flex', num_inference_steps: 3 }, notes: ["2.5 isn't on fal.ai: set to 3"],
    });
  });

  it('leaves values the route takes, and values it never shows, alone', () => {
    expect(snapForRoute(TABLE, { resolution: '2k', safety_tolerance: 3 }, 'bfl')).toEqual({
      params: { resolution: '2k', safety_tolerance: 3 }, notes: [],
    });
  });

  it("turns off another route's setting the new route refuses and shows no control for (FLUX 3 Video's Draft)", () => {
    const video = (NODE_DEFINITIONS as Record<string, ModelNodeDefinition>)['flux-3-video'];
    expect(snapForRoute(video, { _provider: 'openrouter', draft: true }, 'openrouter')).toEqual({
      params: { _provider: 'openrouter', draft: false }, notes: ["Draft (fast preview) isn't on OpenRouter: turned off"],
    });
    // Before the click the rows name the setting, not its value.
    const before = providerSwitchState(video, { _provider: 'bfl', draft: true }, context({ BFL_API_KEY: KEY }));
    expect(before.rows.find((row) => row.id === 'krea')?.block).toBe("Doesn’t take “Draft (fast preview)”.");
    // A route that offers the param keeps it, and an unset one is left alone.
    expect(snapForRoute(video, { draft: true }, 'fal')).toEqual({ params: { draft: true }, notes: [] });
    expect(snapForRoute(video, {}, 'krea')).toEqual({ params: {}, notes: [] });
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

type Params = Record<string, unknown>;
interface SwitchCase {
  name: string; definition: string; saved: Params; keys: string[]; wired: Record<string, unknown>;
  click: string | null; switcher: { notes: string[] }; writes: Params;
}
const SWITCH_CASES = (switchCases as unknown as { cases: SwitchCase[] }).cases;
const CLIENT_DEFINITIONS = (clientDefinitions as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions;

describe('switch_cases.json clicks at the lib level (the twin of node_route.snap_for_route / snap_hidden)', () => {
  it.each(SWITCH_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const definition = CLIENT_DEFINITIONS[c.definition] ?? (NODE_DEFINITIONS as Record<string, ModelNodeDefinition>)[c.definition];
    const before: Params = { ...Object.fromEntries(allParamDefinitions(definition)
      .filter((param) => param.default !== undefined).map((param) => [param.key, param.default])), ...c.saved };
    const apiKeys = Object.fromEntries(c.keys.map((key) => [key, KEY]));
    const wired = new Map(Object.keys(c.wired).map((port) => [port, 1]));
    const ctx = { ...context(apiKeys), wired };
    let result: { params: Params; notes: string[] } = { params: before, notes: [] };
    if (c.click?.startsWith('edit:')) {
      const [key, value] = c.click.slice('edit:'.length).split(/=(.*)/s);
      const edited = { ...before, [key]: JSON.parse(value) };
      result = snapHidden(definition, edited, shownRouteId(definition, withWiredBlockers(definition, edited, wired), apiKeys), key);
    } else if (c.click?.startsWith('fix:')) {
      const fix = providerSwitchState(definition, before, ctx).fixes.find((candidate) => candidate.param === c.click!.slice(4))!;
      expect(fix.label).toBe(fixLabel(definition, fix));
      result = { params: applyFix(before, fix), notes: [] };
    } else if (c.click?.startsWith('alternative:')) {
      const routeId = c.click.slice('alternative:'.length);
      const offer = providerSwitchState(definition, before, ctx).alternatives.find((a) => a.routeId === routeId)!;
      result = applyProviderPick(definition, before, { writes: offer.writes, routeId }, ctx);
    } else if (c.click) {
      const row = providerSwitchState(definition, before, ctx).rows.find((candidate) => candidate.id === c.click)!;
      result = applyProviderPick(definition, before, row, ctx);
    }
    const expected: Params = { ...before, ...c.writes };
    for (const [key, value] of Object.entries(c.writes)) if (value === null) delete expected[key];
    expect(result.params).toEqual(expected);
    expect(result.notes).toEqual(c.switcher.notes);
  });
});

describe('snapHidden (a person editing a setting that controls a hidden one)', () => {
  const flux2 = (NODE_DEFINITIONS as Record<string, ModelNodeDefinition>)['flux-2-pro'];
  it('resets only what the edited setting now hides on the shown route, when another route would honor it', () => {
    expect(snapHidden(flux2, { model: 'klein-4b', safety_tolerance: '3' }, 'fal', 'model')).toEqual({
      params: { model: 'klein-4b', safety_tolerance: '2' },
      notes: ["Safety 3 isn't on fal.ai with FLUX.2 [klein] 4B: back to 2"],
    });
    // Flash: BFL has no Flash, so no route would honor Safety there; kept.
    expect(snapHidden(flux2, { model: 'flash', safety_tolerance: '3' }, 'fal', 'model').notes).toEqual([]);
    // An edit of another setting resets nothing.
    expect(snapHidden(flux2, { model: 'klein-4b', safety_tolerance: '3' }, 'fal', 'seed').notes).toEqual([]);
    // Flex-only steps hidden on Pro are hidden on every route: kept.
    expect(snapHidden(flux2, { model: 'pro', num_inference_steps: 30 }, 'fal', 'model').notes).toEqual([]);
  });

  it('offers the reset as a fix row under a stop, labelled as the message ends', () => {
    const state = providerSwitchState(flux2, { _provider: 'fal', model: 'klein-9b', safety_tolerance: '5' },
      context({ FAL_KEY: KEY, BFL_API_KEY: KEY }));
    expect(state.fixes).toEqual([{ param: 'safety_tolerance', value: '2', label: 'Set Safety back to 2' }]);
    expect(state.rows.find((row) => row.id === 'fal')?.block).toBe("Doesn’t take “Safety”.");
    const auto = providerSwitchState(flux2, { model: 'klein-9b', safety_tolerance: '5' }, context({ FAL_KEY: KEY }));
    expect(auto.rows[0].label).toBe("Auto · fal.ai doesn’t take “Safety”");
    expect(fixLabel(flux2, { param: 'seed', value: null })).toBe('Clear Seed');
    expect(fixLabel(flux2, { param: 'enable_safety_checker', value: true })).toBe('Turn Safety Checker on');
    expect(applyFix({ seed: 4, model: 'pro' }, { param: 'seed', value: null })).toEqual({ model: 'pro' });
  });
});

describe('a route priced from the input file', () => {
  it('shows "by size" where the clip will set the price, and "-" where nothing can', async () => {
    const shipped = (await import('../../../backend/data/model_pricing.json')).default as unknown as PricingTable;
    const state = providerSwitchState(NODE_DEFINITIONS['flux-video-upscale'], {}, {
      apiKeys: { BFL_API_KEY: KEY }, kreaSignedIn: false, pricing: shipped, wired: new Map([['video', 1]]),
    });
    const prices = Object.fromEntries(state.rows.map((row) => [row.id, [row.price, row.priceTitle]]));
    expect(prices.bfl).toEqual(['by size', 'Priced from the input’s size when it runs.']);
    expect(prices.replicate[0]).toBe('by size');
    expect(prices.fal[0]).toBe('-');
    expect(prices.auto[0]).toBe('by size');
  });
});
