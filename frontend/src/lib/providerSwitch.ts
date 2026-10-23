import type { ModelNodeDefinition, ParamDefinition, RouteSpec } from '../types';
import {
  allParamDefinitions, AUTO, blockedSetting, effectiveValues, hiddenStops, matchValue, personWords, portLimitName,
  PROVIDER_PARAM, providerChoice,
  providerLabel, routeAcceptRule, routeBlock, routeById, routeParamDefinitions, routeSentKeys, routesOf, routeSwitch,
  routeTakesValue,
  routeUnavailable, selectRoute, settingText, usesRoutePlan, withWiredBlockers, type DirectBlock, type HiddenStop,
  type RouteFix,
} from './directRoute';
import { awaitsInput, entryForRoute, estimateRoutes, formatUsdRange, routePriceUnconfirmed, type PricingTable } from './pricing';
import type { ProviderSetupTarget } from './providerReadiness';

/**
 * What the provider switcher (components/nodes/ProviderSwitcher.tsx) shows
 * and writes for a route-table node (docs/PROVIDER-ROUTES.md): the Auto row,
 * one row per route (two for a Krea route that can bill the plan), the card
 * chip, and what a person's switch does to the saved values.
 *
 * Every answer comes from lib/directRoute.ts (selectRoute, routeUnavailable,
 * routeParamDefinitions), the rule the backend router uses, so the menu
 * never says a route runs when the run would stop.
 */

type Params = Record<string, unknown>;

export interface SwitchContext {
  apiKeys: Readonly<Record<string, string | undefined>>;
  /** The Krea plan's sign-in (settingsCache.kreaConnection is 'connected'). */
  kreaSignedIn: boolean;
  pricing?: PricingTable | null;
  /** Wired input ports, with how many edges reach each (runScope.nodeWiredCounts). */
  wired?: ReadonlyMap<string, number>;
}

export type KeyState = 'set' | 'missing' | 'signed-in' | 'sign-in';

export interface ProviderRow {
  /** 'auto', a route id, or `${route id}:plan` for a Krea route's plan row. */
  id: string;
  routeId: string | null;
  plan: boolean;
  label: string;
  keyState: KeyState | null;
  /** Where "Add key →" or "Sign in" opens Settings. */
  setup?: ProviderSetupTarget;
  /** "$0.04", "$0.05*" (unconfirmed), or "-" (unpriced, blocked, or billed to the plan). */
  price: string;
  priceTitle?: string;
  /** Why this route can't take the recipe as it is ("Doesn't take 1.5k"). */
  block: string | null;
  /** The route's own note (RouteSpec.note, e.g. Krea 3's early access),
   *  on its API row; a block note replaces it. */
  info?: string;
  selected: boolean;
  /** The billing params a pick writes (BILLING_PARAMS). */
  writes: Params;
}

export interface SwitchState {
  /** The Auto row plus one row per route. */
  rows: ProviderRow[];
  /** The card chip: "Auto · BFL", "fal", "Rep", "OR", "Krea", "Krea plan". */
  chip: string;
  /** The run can't start as saved: the chip turns accent with a warning glyph. */
  blocked: boolean;
  /** Why, in the router's words (routeUnavailable), or the Krea sign-in. */
  message: string | null;
  /** The routes with a key that take the recipe as it is: one click each,
   * writing what that route's API-balance row writes (the offer is made on
   * its key, so never the Krea plan). */
  alternatives: { routeId: string; label: string; writes: Params }[];
  /** One-click edits that let the run start where it is (routeUnavailable
   * `fixes`): "Set Safety back to 2", "Clear Seed". `value` null clears. */
  fixes: (RouteFix & { label: string })[];
}

/** Short names for the 10px card chip; anything else uses its full label. */
const SHORT: Readonly<Record<string, string>> = { bfl: 'BFL', fal: 'fal', replicate: 'Rep', openrouter: 'OR', krea: 'Krea' };

export function shortProvider(provider: string | null | undefined): string {
  return provider && Object.hasOwn(SHORT, provider) ? SHORT[provider] : providerLabel(provider);
}

function isSet(apiKeys: SwitchContext['apiKeys'], key: string): boolean {
  const value = apiKeys[key];
  return typeof value === 'string' && value.trim() !== '';
}

function kreaPlanPicked(params: Params): boolean {
  return params._kreaAuth === 'mcp';
}

/** What a pick writes besides `_provider`: on a node with a Krea route that
 * can bill the plan, every pick sets the Krea billing mode too, so a plan
 * picked earlier never stays behind for a later pick (a route row, or a
 * one-click switch offered on an API key) to bill. `plan` is the plan row;
 * `auto` the Auto row, which keeps the saved mode only where Krea is the
 * maker, the one place Auto bills the plan (selectRoute rule 1). */
function billingWrites(definition: ModelNodeDefinition, routeId: string, plan: boolean): Params {
  const routes = routesOf(definition);
  if (!routes.some((spec) => spec.plan)) return { [PROVIDER_PARAM]: routeId };
  if (routeId === AUTO && routes[0]?.maker && routes[0].plan) return { [PROVIDER_PARAM]: AUTO };
  return { [PROVIDER_PARAM]: routeId, _kreaAuth: plan ? 'mcp' : 'api-token' };
}

/** A row's block note: what this route doesn't take of the recipe, the
 * setting by its label in quotes (error copy round 3f, GM: "Switcher notes
 * become "Doesn't take “{Label}”." / "Needs “{Label}”.""). */
function rowBlock(definition: ModelNodeDefinition, route: RouteSpec, block: DirectBlock, params: Params): string {
  if (block.reason === 'hidden' || block.reason === 'unsupported' || block.reason === 'blocked') {
    return `Doesn't take ${blockedSetting(definition, block, params)}.`;
  }
  if (block.reason === 'requires') return `Needs ${blockedSetting(definition, block, params)}.`;
  if (block.reason === 'size') return "Can't make that size.";
  if (block.reason === 'retired') return 'Retired by the maker.';
  if (block.reason === 'ports') {
    const limit = route.rules?.ports?.[block.param ?? ''];
    const name = personWords(portLimitName(block.param ?? '', limit));
    return limit?.max ? `Takes at most ${limit.max} ${name}.` : `Doesn't take connected ${name}.`;
  }
  return `${personWords(String(block.detail ?? block.reason))}.`;
}

/** The Auto row's reason when the run can't start ("fal.ai doesn't take
 * “Resolution” set to 1.5K"). */
function autoReason(definition: ModelNodeDefinition, unavailable: NonNullable<ReturnType<typeof routeUnavailable>>,
  params: Params): string {
  const spec = unavailable.routeId ? routeById(definition, unavailable.routeId) : undefined;
  const label = providerLabel(spec?.provider);
  const block = unavailable.block;
  if (!spec) return unavailable.missing.length ? 'no provider key set' : 'no route can take it';
  if (!block) return `no ${label} key`;
  if (block.reason === 'hidden' || block.reason === 'unsupported' || block.reason === 'blocked') {
    return `${label} doesn't take ${blockedSetting(definition, block, params)}`;
  }
  if (block.reason === 'requires') return `${label} needs ${blockedSetting(definition, block, params)}`;
  if (block.reason === 'ports') {
    return `too many ${personWords(portLimitName(block.param ?? '', spec.rules?.ports?.[block.param ?? '']))} for ${label}`;
  }
  const note = rowBlock(definition, spec, block as DirectBlock, params);
  return note.charAt(0).toLowerCase() + note.slice(1, -1);
}

function price(definition: ModelNodeDefinition, route: RouteSpec, estimates: ReturnType<typeof estimateRoutes>,
  pricing: PricingTable | null | undefined, plan: boolean, params: Params,
  wired: Iterable<string>): { price: string; priceTitle?: string } {
  if (plan) return { price: '-', priceTitle: 'Billed to your Krea plan' };
  const estimate = estimates[route.id];
  if (!estimate && awaitsInput(entryForRoute(pricing?.nodes[definition.id], route.pricing ?? route.id))) {
    return { price: 'by size', priceTitle: "Priced from the input's size when it runs" };
  }
  if (!estimate || estimate.currency !== 'usd') return { price: '-', priceTitle: 'No list price for these settings' };
  const unconfirmed = routePriceUnconfirmed(definition, route.id, pricing, params, wired);
  return {
    price: `${formatUsdRange(estimate.low, estimate.high)}${unconfirmed ? '*' : ''}`,
    priceTitle: unconfirmed ? "Estimate: the provider's page doesn't state this price exactly" : 'List price per run at these settings',
  };
}

/** Everything the switcher shows for this node, params and keys. `params`
 * are the saved params; wired ports are added here (withWiredBlockers), as
 * the router reads them. */
export function providerSwitchState(definition: ModelNodeDefinition, params: Params | undefined, context: SwitchContext): SwitchState {
  const saved = params ?? {};
  const wired = context.wired ?? new Map<string, number>();
  const routed = withWiredBlockers(definition, saved, wired);
  const choice = providerChoice(saved);
  const estimates = estimateRoutes(definition, saved, wired, context.pricing);
  const wiredPorts = [...wired.keys()];
  const unavailable = routeUnavailable(definition, routed, context.apiKeys);
  const route = selectRoute(definition, routed, context.apiKeys);
  const autoRoute = selectRoute(definition, { ...routed, [PROVIDER_PARAM]: AUTO }, context.apiKeys);
  const autoUnavailable = routeUnavailable(definition, { ...routed, [PROVIDER_PARAM]: AUTO }, context.apiKeys);
  const autoSpec = autoRoute.routeId ? routeById(definition, autoRoute.routeId) : undefined;
  const autoName = autoRoute.kind === 'plan' ? 'Krea plan' : providerLabel(autoSpec?.provider);

  const rows: ProviderRow[] = [{
    id: AUTO, routeId: null, plan: false,
    label: autoUnavailable ? `Auto · can't run: ${autoReason(definition, autoUnavailable, { ...routed, [PROVIDER_PARAM]: AUTO })}` : `Auto · runs on ${autoName}`,
    keyState: null, price: autoUnavailable || !autoSpec ? '-'
      : price(definition, autoSpec, estimates, context.pricing, autoRoute.kind === 'plan', saved, wiredPorts).price,
    block: null, selected: choice === AUTO, writes: billingWrites(definition, AUTO, false),
  }];
  for (const spec of routesOf(definition)) {
    const block = routeBlock(definition, spec, routed);
    const note = block ? rowBlock(definition, spec, block, routed) : null;
    const keyed = spec.keys.some((key) => isSet(context.apiKeys, key));
    const label = providerLabel(spec.provider);
    if (spec.plan !== 'only') {
      const both = spec.plan === 'optional';
      rows.push({
        id: spec.id, routeId: spec.id, plan: false,
        label: both ? `${label} · API balance` : label,
        keyState: keyed ? 'set' : 'missing',
        setup: spec.keys[0] ? { kind: 'api-key', key: spec.keys[0] } : undefined,
        ...(block ? { price: '-', priceTitle: note ?? undefined } : price(definition, spec, estimates, context.pricing, false, saved, wiredPorts)),
        block: note,
        ...(spec.note && !note ? { info: spec.note } : {}),
        selected: choice === spec.id && !(both && kreaPlanPicked(saved)),
        writes: billingWrites(definition, spec.id, false),
      });
    }
    if (spec.plan) {
      rows.push({
        id: `${spec.id}:plan`, routeId: spec.id, plan: true,
        label: `${label} · plan`,
        keyState: context.kreaSignedIn ? 'signed-in' : 'sign-in',
        setup: { kind: 'krea-mcp' },
        ...(block ? { price: '-', priceTitle: note ?? undefined } : price(definition, spec, estimates, context.pricing, true, saved, wiredPorts)),
        block: note,
        selected: choice === spec.id && (spec.plan === 'only' || kreaPlanPicked(saved)),
        writes: billingWrites(definition, spec.id, true),
      });
    }
  }

  const planRun = usesRoutePlan(definition, routed);
  const signInNeeded = planRun && !context.kreaSignedIn;
  const shownSpec = route.routeId ? routeById(definition, route.routeId) : undefined;
  const short = route.kind === 'plan' ? 'Krea plan' : shortProvider(shownSpec?.provider ?? route.provider);
  const chip = choice === AUTO ? (autoRoute.routeId ? `Auto · ${autoRoute.kind === 'plan' ? 'Krea plan' : shortProvider(autoSpec?.provider)}` : 'Auto')
    : routeById(definition, choice) ? short : 'Unknown';
  return {
    rows,
    chip,
    blocked: Boolean(unavailable) || signInNeeded,
    message: unavailable?.message
      ?? (signInNeeded ? `${definition.displayName} bills your Krea plan. Sign in to Krea in Settings, or choose another provider.` : null),
    alternatives: (unavailable?.alternatives ?? []).map((routeId) => ({
      routeId, label: providerLabel(routeById(definition, routeId)?.provider),
      writes: billingWrites(definition, routeId, false),
    })),
    fixes: (unavailable?.fixes ?? []).map((fix) => ({ ...fix, label: fixLabel(definition, fix) })),
  };
}

/** A fix row's label: "Set Safety back to 2", "Turn Draft (fast preview)
 * off", "Clear Seed" (the sentence routeUnavailable's message ends with). */
export function fixLabel(definition: ModelNodeDefinition, fix: RouteFix): string {
  const param = allParamDefinitions(definition).find((candidate) => candidate.key === fix.param);
  const label = param?.label || fix.param;
  if (fix.value === null || fix.value === undefined) return `Clear ${label}`;
  if (typeof fix.value === 'boolean') return `Turn ${label} ${fix.value ? 'on' : 'off'}`;
  return `Set ${label} back to ${optionLabel(param, fix.value)}`;
}

/** What a fix row saves: the param set to the fix's value, or removed (cleared). */
export function applyFix(params: Params | undefined, fix: RouteFix): Params {
  const next: Params = { ...(params ?? {}) };
  if (fix.value === null || fix.value === undefined) delete next[fix.param];
  else next[fix.param] = fix.value;
  return next;
}

function optionLabel(param: ParamDefinition | undefined, value: unknown): string {
  const option = param?.options?.find((candidate) => matchValue(candidate.value) === matchValue(value));
  return option?.label ?? matchValue(value);
}

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return value !== undefined && value !== null;
}

/** The value of `param` on `route` closest to `value`: an enum's nearest
 * option the route takes by its place in the full option list (a tie takes
 * the later, larger one: 1.5k between 1k and 2k gives 2k); a number clamped
 * into the route's range; else the param's default. */
function closestValue(route: RouteSpec, offered: ParamDefinition, whole: ParamDefinition | undefined, value: unknown): unknown {
  const options = whole?.options ?? offered.options;
  if (Array.isArray(options) && options.length && Array.isArray(offered.options) && offered.options.length) {
    const order = options.map((option) => matchValue(option.value));
    const at = order.indexOf(matchValue(value));
    if (at >= 0) {
      let best: { value: unknown; distance: number; index: number } | null = null;
      for (const option of offered.options) {
        const index = order.indexOf(matchValue(option.value));
        if (index < 0) continue;
        const distance = Math.abs(index - at);
        if (!best || distance < best.distance || (distance === best.distance && index > best.index)) {
          best = { value: option.value, distance, index };
        }
      }
      if (best) return best.value;
    }
  }
  const rule = routeAcceptRule(route, offered.key);
  if (typeof value === 'number' && Number.isFinite(value) && rule) {
    let next = value;
    if (typeof rule.min === 'number') next = Math.max(next, rule.min);
    if (typeof rule.max === 'number') next = Math.min(next, rule.max);
    if (rule.integer || offered.type === 'integer') next = Math.round(next);
    if (routeTakesValue(route, offered.key, next)) return next;
  }
  return offered.default;
}

function defaultNote(param: ParamDefinition | undefined): string {
  const fallback = param?.default;
  if (fallback === undefined || fallback === null) return 'cleared';
  if (typeof fallback === 'boolean') return fallback === false ? 'turned off' : 'back to its default';
  return `back to ${optionLabel(param, fallback)}`;
}

/** Each rule-H stop back to its default (cleared when it has none), one
 * note each (node_route._snap_stops). */
function snapStops(definition: ModelNodeDefinition, route: RouteSpec, values: Params, stops: HiddenStop[], notes: string[]): void {
  const label = providerLabel(route.provider);
  const whole = new Map(allParamDefinitions(definition).map((param) => [param.key, param]));
  const effective = effectiveValues(definition, values);
  for (const stop of stops) {
    const param = whole.get(stop.param);
    if (stop.controllers.length) {
      const hides = stop.controllers.map((ctrl) => optionLabel(whole.get(ctrl), effective[ctrl])).join(' and ');
      notes.push(`${settingText(param, stop.param, values[stop.param])} isn't on ${label} with ${hides}: ${defaultNote(param)}`);
    } else {
      notes.push(`${param?.label || stop.param} isn't on ${label}: ${defaultNote(param)}`);
    }
    if (param?.default === undefined || param.default === null) delete values[stop.param];
    else values[stop.param] = param.default;
  }
}

/** A person's switch to `routeId`: each saved value that route doesn't take
 * moves to its closest value there (closestValue), with one note per change
 * for the card ("1.5k isn't on fal.ai: set to 2k"). Then every value rule H
 * would stop the run on (hiddenStops: a setting the route doesn't show,
 * that another route would honor) goes back to its default, or is cleared,
 * with one note each ("Seed isn't on OpenRouter: cleared", "Draft (fast
 * preview) isn't on Krea: turned off"). Only an explicit click calls this;
 * a route change without one (keys, a shared graph, an import) keeps every
 * value, and the switcher shows the stop instead
 * (node_route.snap_for_route). */
export function snapForRoute(definition: ModelNodeDefinition, params: Params, routeId: string | null | undefined): { params: Params; notes: string[] } {
  const route = routeId ? routeById(definition, routeId) : undefined;
  if (!route) return { params, notes: [] };
  const whole = new Map(allParamDefinitions(definition).map((param) => [param.key, param]));
  const next: Params = { ...params };
  const notes: string[] = [];
  const label = providerLabel(route.provider);
  const sent = routeSentKeys(definition, route.id, params);
  for (const offered of routeParamDefinitions(definition, route.id)) {
    const value = params[offered.key];
    // A setting the route hides with these values is never sent, so it keeps
    // its value (rule H below decides whether it stops).
    if (!sent.has(offered.key) || !hasValue(value) || routeTakesValue(route, offered.key, value)) continue;
    const snapped = closestValue(route, offered, whole.get(offered.key), value);
    const was = optionLabel(whole.get(offered.key), value);
    if (snapped === undefined) {
      delete next[offered.key];
      notes.push(`${was} isn't on ${label}: back to its default`);
    } else {
      next[offered.key] = snapped;
      notes.push(`${was} isn't on ${label}: set to ${optionLabel(whole.get(offered.key), snapped)}`);
    }
  }
  snapStops(definition, route, next, hiddenStops(definition, route, next), notes);
  return { params: next, notes };
}

/** A person's edit of `changed` (the Inspector or a pill) on the shown
 * route `routeId`: each value the edit now hides there that rule H would
 * stop on goes back to its default, or is cleared, with one note each
 * ("Safety 5 isn't on fal.ai with FLUX.2 [klein] 9B: back to 2"). Only the
 * params `changed` controls on that route; nothing else is reset
 * (node_route.snap_hidden). `params` already hold the edit. */
export function snapHidden(definition: ModelNodeDefinition, params: Params, routeId: string | null | undefined, changed: string): { params: Params; notes: string[] } {
  const route = routeId ? routeById(definition, routeId) : undefined;
  const next: Params = { ...params };
  const notes: string[] = [];
  if (!route || !routeSwitch(definition)) return { params: next, notes };
  const stops = hiddenStops(definition, route, next).filter((stop) => stop.controllers.includes(changed));
  snapStops(definition, route, next, stops, notes);
  return { params: next, notes };
}

/** What a pick in the switcher saves: the row's billing params, then the
 * values snapped onto the route it runs on (under Auto, the route Auto
 * takes with these keys). */
export function applyProviderPick(
  definition: ModelNodeDefinition,
  params: Params | undefined,
  row: Pick<ProviderRow, 'writes' | 'routeId'>,
  context: Pick<SwitchContext, 'apiKeys' | 'wired'>,
): { params: Params; notes: string[] } {
  const picked = { ...(params ?? {}), ...row.writes };
  const routed = withWiredBlockers(definition, picked, context.wired ?? new Map<string, number>());
  const target = row.routeId ?? selectRoute(definition, routed, context.apiKeys).routeId;
  return snapForRoute(definition, picked, target);
}

/** The .nebula import summary's provider lines: each route-table node set
 * to a provider none of whose keys is set here, or on Auto with no key for
 * any of its providers. The values and the choice are kept as saved (a
 * shared graph never resets them); the card's chip shows the stop. */
export function providerKeyWarnings(
  nodes: readonly { id: string; data: { definitionId: string; label?: string; params?: Params } }[],
  definitions: Readonly<Record<string, ModelNodeDefinition>>,
  apiKeys: SwitchContext['apiKeys'],
): string[] {
  const warnings: string[] = [];
  for (const node of nodes) {
    const definition = definitions[node.data.definitionId];
    if (!definition || !routeSwitch(definition)) continue;
    const params = node.data.params ?? {};
    const name = `"${node.data.label || definition.displayName}" (${node.id})`;
    const choice = providerChoice(params);
    const route = choice === AUTO ? undefined : routeById(definition, choice);
    if (route) {
      const planRow = route.plan === 'only' || (route.plan === 'optional' && params._kreaAuth === 'mcp');
      if (!planRow && !route.keys.some((key) => isSet(apiKeys, key))) {
        warnings.push(`${name} is set to ${providerLabel(route.provider)}, which you have no key for.`);
      }
    } else if (choice === AUTO && !routesOf(definition).some((spec) => spec.keys.some((key) => isSet(apiKeys, key)))) {
      warnings.push(`${name} is on Auto, and none of its providers has a key here.`);
    }
  }
  return warnings;
}
