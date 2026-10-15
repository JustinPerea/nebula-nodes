import { describe, expect, it } from 'vitest';
import shared from '../../../backend/tests/fixtures/pricing_cases.json';
import shippedTable from '../../../backend/data/model_pricing.json';
import backendCatalog from '../../../backend/data/node_definitions.json';
import { estimateNode, formatUsd, formatUsdRange, type PriceEntry } from '../../src/lib/pricing';

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
    // defaults, so it must resolve in that mode instead.
    const missing = Object.entries(nodes)
      .flatMap(([id, entry]) => (entry.routes
        ? Object.keys(entry.routes).map((provider) => [id, entry, provider, `${id} (${provider})`] as const)
        : [[id, entry, entry.provider, id] as const]))
      .filter(([id, entry, provider]) => {
        const local = catalog[id]?.apiProvider === 'utility';
        const params = local ? { ...(entry.rows?.[0]?.match ?? {}) } : {};
        return estimateNode(entry, catalog[id] ?? {}, params, provider) === null;
      })
      .map(([, , , label]) => label);
    expect(missing).toEqual([]);
  });
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
