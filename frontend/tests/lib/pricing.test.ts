import { describe, expect, it } from 'vitest';
import shared from '../../../backend/tests/fixtures/pricing_cases.json';
import shippedTable from '../../../backend/data/model_pricing.json';
import backendCatalog from '../../../backend/data/node_definitions.json';
import { estimateNode, estimateRoutes, formatUsd, formatUsdRange, pricedKeys, routePriceUnconfirmed, RUN_TIME_VARIABLES, type PriceEntry, type PricingTable } from '../../src/lib/pricing';
import type { ModelNodeDefinition } from '../../src/types';

type Fixture = {
  definitions: Record<string, Record<string, unknown>>;
  pricing: { nodes: Record<string, PriceEntry> };
  cases: Array<{
    name: string;
    nodeId: string;
    params?: Record<string, unknown>;
    routeProvider?: string;
    wired?: string[];
    expected: { currency: string; low: number; high: number; plus?: string } | null;
  }>;
};

const fixture = shared as unknown as Fixture;

describe('estimateNode (cases shared with the backend)', () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const result = estimateNode(
        fixture.pricing.nodes[testCase.nodeId],
        fixture.definitions[testCase.nodeId] ?? {},
        testCase.params,
        testCase.routeProvider,
        testCase.wired,
      );
      if (testCase.expected === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result).not.toBeNull();
      expect(result!.currency).toBe(testCase.expected.currency);
      expect(result!.low).toBeCloseTo(testCase.expected.low, 9);
      expect(result!.high).toBeCloseTo(testCase.expected.high, 9);
      expect(result!.plus).toBe(testCase.expected.plus);
    });
  }
});

describe('the shipped price table', () => {
  const nodes = (shippedTable as unknown as { nodes: Record<string, PriceEntry> }).nodes;
  const catalog = backendCatalog as unknown as Record<string, Record<string, unknown>>;

  it('prices every entry at its default settings', () => {
    // Every curated or generated entry must resolve at the node's defaults,
    // or the chip would read "unpriced" for a fresh node.
    // A dual-route node prices each route on its own: check every route.
    // A local node priced only in a paid mode (QC Jev) is free at its
    // defaults, so it must resolve in that mode instead. A price that reads
    // the source clip (FLUX Video Edit and Upscale) is known only once the
    // run is, so it is the one kind left unpriced on a fresh node.
    const runTime = (entry: PriceEntry) => RUN_TIME_VARIABLES.some((key) => pricedKeys(entry).has(key));
    const routed = Object.entries(nodes)
      .flatMap(([id, entry]) => (entry.routes
        ? Object.entries(entry.routes).map(([provider, priced]) => [id, entry, provider, `${id} (${provider})`, priced] as const)
        : [[id, entry, entry.provider, id, entry] as const]));
    expect(routed.filter(([, , , , priced]) => runTime(priced)).map(([, , , label]) => label)).toEqual([
      'flux-video-edit (bfl)', 'flux-video-edit (fal)',
      'flux-video-upscale (bfl)', 'flux-video-upscale (fal)', 'flux-video-upscale (replicate)',
    ]);
    const missing = routed
      .filter(([, , , , priced]) => !runTime(priced))
      .filter(([id, entry, provider]) => {
        const local = catalog[id]?.apiProvider === 'utility';
        const params = local ? { ...(entry.rows?.[0]?.match ?? {}) } : {};
        return estimateNode(entry, catalog[id] ?? {}, params, provider) === null;
      })
      .map(([, , , label]) => label);
    expect(missing).toEqual([]);
  });
});

describe('estimateRoutes on the shipped table (cases shared with the backend)', () => {
  // The registry's route-table nodes priced by backend/data/model_pricing.json
  // (pricing_cases.json shippedRouteCases; test_flux3_nodes.py runs them too).
  const cases = (shared as unknown as {
    shippedRouteCases: Array<{ name: string; nodeId: string; params: Record<string, unknown>; wired: string[];
      expected: Record<string, number | [number, number] | null> }>;
  }).shippedRouteCases;
  const table = shippedTable as unknown as PricingTable;
  const registry = backendCatalog as unknown as Record<string, ModelNodeDefinition>;
  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = estimateRoutes(registry[testCase.nodeId], testCase.params, testCase.wired, table);
      expect(Object.keys(result).sort()).toEqual(Object.keys(testCase.expected).sort());
      for (const [routeId, price] of Object.entries(testCase.expected)) {
        const estimate = result[routeId];
        if (price === null) { expect(estimate, routeId).toBeNull(); continue; }
        const [low, high] = Array.isArray(price) ? price : [price, price];
        expect(estimate?.low, routeId).toBeCloseTo(low, 6);
        expect(estimate?.high, routeId).toBeCloseTo(high, 6);
      }
    });
  }
});

describe('formatUsd', () => {
  it('keeps two significant figures under a dollar', () => {
    expect(formatUsd(0.04)).toBe('$0.04');
    expect(formatUsd(0.0047)).toBe('$0.0047');
    expect(formatUsd(0.428)).toBe('$0.43');
    expect(formatUsd(0.1)).toBe('$0.10');
    expect(formatUsd(0.067)).toBe('$0.067');
  });

  it('rounds dollars to cents and tens to whole dollars', () => {
    expect(formatUsd(1.2)).toBe('$1.20');
    expect(formatUsd(12.4)).toBe('$12');
    expect(formatUsd(0)).toBe('$0');
  });

  it('collapses equal bounds and joins a range with one dollar sign', () => {
    expect(formatUsdRange(0.04, 0.04)).toBe('$0.04');
    expect(formatUsdRange(0.0047, 0.428)).toBe('$0.0047–0.43');
  });
});

describe('estimateRoutes (cases shared with the backend)', () => {
  const cases = (shared as unknown as {
    routeEstimateCases: Array<{ name: string; nodeId: string; params: Record<string, unknown>; wired?: string[]; expected: Record<string, number | null> }>;
  }).routeEstimateCases;
  for (const testCase of cases) {
    it(testCase.name, () => {
      const definition = fixture.definitions[testCase.nodeId] as unknown as ModelNodeDefinition;
      const result = estimateRoutes(definition, testCase.params, testCase.wired ?? [], fixture.pricing as unknown as PricingTable);
      expect(Object.keys(result).sort()).toEqual(Object.keys(testCase.expected).sort());
      for (const [routeId, price] of Object.entries(testCase.expected)) {
        if (price === null) expect(result[routeId], routeId).toBeNull();
        else expect(result[routeId]).toEqual({ currency: 'usd', low: price, high: price });
      }
    });
  }

  it('marks a route price the provider page does not state exactly (model_pricing.route_price_unconfirmed)', () => {
    const definition = fixture.definitions.table as unknown as ModelNodeDefinition;
    const pricing = fixture.pricing as unknown as PricingTable;
    expect(Object.fromEntries(definition.routes!.map((route) => [route.id, routePriceUnconfirmed(definition, route.id, pricing)])))
      .toEqual({ bfl: false, fal: true, replicate: false, openrouter: false, krea: false });
    expect(routePriceUnconfirmed(definition, 'nope', pricing)).toBe(false);
    expect(routePriceUnconfirmed(definition, 'fal', null)).toBe(false);
  });

  it('is empty for a node without a route table', () => {
    const definition = fixture.definitions.dual as unknown as ModelNodeDefinition;
    expect(estimateRoutes(definition, {}, [], fixture.pricing as unknown as PricingTable)).toEqual({});
  });
});
