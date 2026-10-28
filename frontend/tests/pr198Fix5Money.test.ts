import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Edge, Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import {
  chipEstimate, chipLabel, chipTitle, formatChipEstimate, formatSpentUsd, formatUsd, formatUsdRange, type PricingTable,
} from '../src/lib/pricing';
import {
  describeRunScope, runChipLabel, runChipTitle, runCostConfirmMessage, summarizeRunScope,
} from '../src/lib/runScope';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { routeUnavailable } from '../src/lib/directRoute';
import shippedTable from '../../backend/data/model_pricing.json';
import type { NodeData } from '../src/types';

/**
 * PR #198 fix round 5, the money lane: review 5's N3 and N4, GM r6 items 2
 * and 3, and the "+ unpriced" chip (GM r6 "FROM THE SHOTS", r7 item 3).
 * - N3: a high end under the low end shows the low end on the chip too.
 * - N4: amounts above $10,000,000,000,000 read ">$10,000,000,000,000"
 *   (">$10,000,000,000,000.00" spent), never "1e+306" or "Infinity.NaN".
 * - r6 item 2: a range from $0 reads "Up to $0.43".
 * - r6 item 3: detail lines write each end in full: "$0.0047–$0.43".
 * - The "+" chip reads "<figure> + unpriced"; its tooltip leads with the
 *   priced part and gives one sentence per reason, no colons.
 */

const MONEY = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/fixtures/money/cases.json'), 'utf8')) as {
  spent: { amount: number; text: string }[];
  amount: { amount: number; text: string }[];
};

const BAD_NUMBER = /e\+|e-\d|Infinity|NaN|undefined/;

describe('N3: a high end under the low end', () => {
  it.each([[0.43, -1], [0.43, 0], [0.43, 0.2], [0.43, Number.NEGATIVE_INFINITY]])('%s–%s reads the low end alone', (low, high) => {
    expect(formatChipEstimate(low, high, false)).not.toBe('~$0');
    if (Number.isFinite(high)) {
      expect(formatChipEstimate(low, high, false)).toBe('~$0.43');
      expect(chipTitle(chipEstimate(low, high, false))).toBe('Estimated cost');
    }
    expect(formatUsdRange(low, high)).toBe('$0.43');
  });

  it('open, it reads the low end with the suffix', () => {
    expect(formatChipEstimate(0.43, -1, true)).toBe('$0.43 + unpriced');
  });
});

describe('N4: a ceiling on absurd amounts', () => {
  it('writes amounts above $10,000,000,000,000 as more than it', () => {
    expect(formatUsd(1e13)).toBe('$10,000,000,000,000');
    expect(formatUsd(1e14)).toBe('>$10,000,000,000,000');
    expect(formatUsd(1e306)).toBe('>$10,000,000,000,000');
    expect(formatUsd(Number.MAX_VALUE)).toBe('>$10,000,000,000,000');
    expect(formatSpentUsd(1e13)).toBe('$10,000,000,000,000.00');
    expect(formatSpentUsd(1e14)).toBe('>$10,000,000,000,000.00');
    expect(formatSpentUsd(1e308)).toBe('>$10,000,000,000,000.00');
    expect(formatSpentUsd(Number.MAX_VALUE)).toBe('>$10,000,000,000,000.00');
  });

  it('the float max never reads as an exponent or Infinity.NaN anywhere', () => {
    const max = Number.MAX_VALUE;
    const texts = [
      formatUsd(max), formatSpentUsd(max), formatUsdRange(0.5, max), formatUsdRange(max, max), formatUsdRange(max, 0.5),
      formatChipEstimate(0.5, max, false), formatChipEstimate(0.5, max, true), formatChipEstimate(max, max, false),
      formatChipEstimate(0, max, false), formatChipEstimate(0.004, max, true),
      chipTitle(chipEstimate(0.5, max, false)), chipTitle(chipEstimate(0.5, max, true)), chipTitle(chipEstimate(max, max, true)),
    ];
    for (const text of texts) expect(text, text).not.toMatch(BAD_NUMBER);
  });

  it('as a property: every power of ten up to the float max, on every form', () => {
    for (let exponent = -8; exponent <= 308; exponent += 1) {
      for (const mantissa of [1, 1.7976931348623157, 5, 9.99]) {
        const amount = mantissa * 10 ** exponent;
        if (!Number.isFinite(amount)) continue;
        for (const text of [formatUsd(amount), formatSpentUsd(amount), formatUsdRange(0.02, amount), formatUsdRange(amount, amount * 2),
          formatChipEstimate(0.02, amount, false), formatChipEstimate(amount, amount, true), formatChipEstimate(0, amount, true),
          chipTitle(chipEstimate(0.02, amount, true)), chipTitle(chipEstimate(amount, amount, false))]) {
          expect(text, `${amount}: ${text}`).not.toMatch(BAD_NUMBER);
          expect(text.length, `${amount}: ${text}`).toBeLessThan(80);
        }
      }
    }
  });

  it('the shared table, ceiling rows included, reads as the backend writes it', () => {
    for (const row of MONEY.amount) expect(formatUsd(row.amount), String(row.amount)).toBe(row.text);
    for (const row of MONEY.spent) expect(formatSpentUsd(row.amount), String(row.amount)).toBe(row.text);
  });
});

describe('GM r6 item 2: a range from $0', () => {
  it.each([
    [0, 0.43, false, 'Up to $0.43', 'Up to $0.43.'],
    [0, 0.43, true, 'Up to $0.43 + unpriced', 'The priced part of this run costs up to $0.43.'],
    [0, 0.044, false, 'Up to $0.04', 'Up to $0.04.'],
    [0, 12.4, false, 'Up to $12', 'Up to $12.'],
    [-1, 0.43, false, 'Up to $0.43', 'Up to $0.43.'],
    [Number.NaN, 0.43, false, 'Up to $0.43', 'Up to $0.43.'],
    // Under a cent at the top stays "<$0.01".
    [0, 0.004, false, '<$0.01', 'Estimated cost under $0.01'],
    [0, 0, false, '~$0', 'Estimated cost'],
  ])('%s–%s open=%s: "%s"', (low, high, open, label, title) => {
    expect(formatChipEstimate(low, high, open)).toBe(label);
    expect(chipTitle(chipEstimate(low, high, open))).toBe(title);
  });
});

describe('GM r6 item 3: detail lines write each end in full', () => {
  it.each([
    [0.0047, 0.43, '$0.0047–$0.43'],
    [0, 0.43, '$0–$0.43'],
    [9.5, 12, '$9.50–$12'],
    [0.0099, 0.0101, '$0.0099–$0.010'],
    [5e-324, 0.43, '<$0.000001–$0.43'],
    [0.04, 0.04, '$0.04'],
  ])('%s–%s reads %s', (low, high, text) => {
    expect(formatUsdRange(low, high)).toBe(text);
  });
});

describe('the "+ unpriced" chip label', () => {
  it.each([
    [0.0047, 0.43, 'Up to $0.43 + unpriced', 'The priced part of this run costs up to $0.43.'],
    [9.5, 12, '$9.50–12.00 + unpriced', 'The priced part of this run costs between $9.50 and $12.00.'],
    [0.04, 0.04, '$0.04 + unpriced', 'The priced part of this run costs about $0.04.'],
    [0.004, 0.004, '<$0.01 + unpriced', 'The priced part of this run costs under $0.01.'],
    // GM r8: a free priced part has no line of its own ($0 is a price).
    [0, 0, '$0 + unpriced', ''],
    [0.02, Number.NaN, '$0.02 + unpriced', 'The priced part of this run costs about $0.02.'],
  ])('%s–%s open: "%s"', (low, high, label, lead) => {
    const chip = chipEstimate(low, high, true);
    expect(chipLabel(chip)).toBe(label);
    expect(label).not.toMatch(/\+$/);
    // With no scope, the tooltip is the lead sentence alone.
    expect(chipTitle(chip)).toBe(lead);
  });
});

const priced = (id: string, definitionId: string, params: Record<string, unknown> = {}, label = ''): Node<NodeData> => ({
  id, position: { x: 0, y: 0 }, data: { definitionId, label, params } as unknown as NodeData,
});

const shipped = (shippedTable as unknown as PricingTable).nodes;
const pricing: PricingTable = {
  currencies: {},
  nodes: {
    'nano-banana': { currency: 'usd', per: 'image', rows: [{ match: { imageSize: '1K' }, price: 0.05 }] },
    'gpt-image-2-edit': { currency: 'usd', per: 'image', plus: 'input images', rows: [{ match: {}, price: [0.01, 0.2] }] },
    'seedvr2-upscale': shipped['seedvr2-upscale'],
    'flux-2-pro': shipped['flux-2-pro'],
  },
};
const context = { pricing, apiKeys: {} };

describe('the Run chip tooltip names each reason', () => {
  it('no listed price', () => {
    const summary = summarizeRunScope([priced('a', 'nano-banana', {}, 'Hero'), priced('c', 'claude-chat', {}, 'Writer')],
      [], { kind: 'graph' }, context);
    expect(runChipLabel(summary)).toBe('$0.05 + unpriced');
    expect(runChipTitle(summary)).toBe('The priced part of this run costs about $0.05. “Writer” has no listed price.');
  });

  it('groups nodes that share a reason, with a count from 4', () => {
    const two = summarizeRunScope([priced('a', 'nano-banana'), priced('c', 'claude-chat', {}, 'A'), priced('d', 'claude-chat', {}, 'B')],
      [], { kind: 'graph' }, context);
    expect(runChipTitle(two)).toBe('The priced part of this run costs about $0.05. “A” and “B” have no listed price.');
    const same = summarizeRunScope([priced('a', 'nano-banana'), priced('c', 'claude-chat', {}, 'Text'), priced('d', 'claude-chat', {}, 'Text'),
      priced('e', 'claude-chat', {}, 'Brief')], [], { kind: 'graph' }, context);
    expect(runChipTitle(same)).toBe('The priced part of this run costs about $0.05. 2 “Text” nodes and “Brief” have no listed price.');
    const four = summarizeRunScope([priced('a', 'nano-banana'), ...['A', 'B', 'C', 'D'].map((name) => priced(name, 'claude-chat', {}, name))],
      [], { kind: 'graph' }, context);
    expect(runChipTitle(four)).toBe('The priced part of this run costs about $0.05. 4 nodes have no listed price.');
  });

  it('a missing key names the provider as the node\'s own line does', () => {
    const flux = priced('f', 'flux-2-pro', { _provider: 'fal' }, 'Flux');
    const summary = summarizeRunScope([priced('a', 'nano-banana'), flux], [], { kind: 'graph' }, context);
    expect(runChipTitle(summary)).toBe('The priced part of this run costs about $0.05. “Flux” can\'t be priced until its fal.ai API key is added.');
    // The node's own route line (its card, the switcher and the run error) names it the same way.
    expect(routeUnavailable(NODE_DEFINITIONS['flux-2-pro'], { _provider: 'fal' }, {})!.message).toContain('your fal.ai API key');
    // Auto with no key at all: either provider's key.
    const auto = summarizeRunScope([priced('a', 'nano-banana'), priced('g', 'flux-2-pro', {}, 'Flux auto')], [], { kind: 'graph' }, context);
    expect(runChipTitle(auto)).toContain('“Flux auto” can\'t be priced until its Black Forest Labs or fal.ai API key is added.');
  });

  it('a node priced only on a provider whose key is missing reads as a missing key, not as no listed price (live check)', () => {
    // Seedream is priced on BytePlus only. With no key at all the run would
    // fall back to fal.ai, which has no row, so it read "no listed price".
    const seedream = { pricing: { currencies: {}, nodes: { ...pricing.nodes, 'seedream-4-5': shipped['seedream-4-5'] } } };
    const graph = [priced('a', 'nano-banana'), priced('s', 'cinema-scene', { scene: { shots: [{ id: 's1', prompt: 'a' }] } }, 'Opening'),
      priced('d', 'seedream-4-5', {}, 'Seedream')];
    expect(runChipTitle(summarizeRunScope(graph, [], { kind: 'graph' }, { ...seedream, apiKeys: {} }))).toBe('The priced part of this run costs '
      + 'about $0.05. “Opening” and “Seedream” can\'t be priced until their BytePlus or fal.ai API key is added.');
    // A fal.ai key alone: the run goes to fal.ai, which has no listed price.
    expect(runChipTitle(summarizeRunScope(graph, [], { kind: 'graph' }, { ...seedream, apiKeys: { FAL_KEY: 'set' } })))
      .toBe('The priced part of this run costs about $0.05. “Opening” and “Seedream” have no listed price.');
    // A BytePlus key prices both.
    expect(runChipLabel(summarizeRunScope(graph, [], { kind: 'graph' }, { ...seedream, apiKeys: { BYTEPLUS_API_KEY: 'set' } })))
      .not.toMatch(/unpriced/);
  });

  it('a price read from an input that isn\'t ready yet', () => {
    const upload = priced('in', 'image-input', { filePath: '/out/a.png' }, 'Photo');
    const seedvr = priced('up', 'seedvr2-upscale', {}, 'Upscale');
    const wire: Edge[] = [{ id: 'w', source: 'in', sourceHandle: 'image', target: 'up', targetHandle: 'image' }];
    const keys = { FAL_KEY: 'set' };
    const summary = summarizeRunScope([priced('a', 'nano-banana'), upload, seedvr], wire, { kind: 'graph' }, { pricing, apiKeys: keys });
    expect(runChipTitle(summary)).toBe('The priced part of this run costs about $0.05. “Upscale” is priced from its input, which isn\'t ready yet.');
    const unreadable = summarizeRunScope([priced('a', 'nano-banana'), upload, seedvr], wire, { kind: 'graph' },
      { pricing, apiKeys: keys, sizes: { '/out/a.png': null } });
    expect(runChipTitle(unreadable)).toContain('“Upscale”');
    expect(runChipTitle(unreadable)).not.toContain('isn\'t ready yet');
  });

  it('a cost the estimate leaves out', () => {
    const summary = summarizeRunScope([priced('e', 'gpt-image-2-edit', {}, 'Edit')], [], { kind: 'graph' }, context);
    expect(runChipLabel(summary)).toBe('$0.01–0.20 + unpriced');
    expect(runChipTitle(summary)).toBe('The priced part of this run costs between $0.01 and $0.20. “Edit” may cost more for its input images, which the estimate leaves out.');
  });

  it('orders the lines by where each reason\'s first node is, with no colons', () => {
    const graph = [
      priced('w', 'claude-chat', {}, 'Writer'),
      priced('e', 'gpt-image-2-edit', {}, 'Edit'),
      priced('f', 'flux-2-pro', { _provider: 'fal' }, 'Flux'),
      priced('w2', 'claude-chat', {}, 'Writer 2'),
    ];
    const title = runChipTitle(summarizeRunScope(graph, [], { kind: 'graph' }, context))!;
    expect(title).toBe([
      'The priced part of this run costs between $0.01 and $0.20.',
      '“Writer” and “Writer 2” have no listed price.',
      '“Edit” may cost more for its input images, which the estimate leaves out.',
      '“Flux” can\'t be priced until its fal.ai API key is added.',
    ].join(' '));
    expect(title).not.toContain(':');
    for (const sentence of title.split(/(?<=\.) /)) expect(sentence).toMatch(/\.$/);
  });

  it('the selection toolbar\'s scopes (one node and a cluster) say the same', () => {
    const graph = [priced('a', 'nano-banana'), priced('c', 'claude-chat', {}, 'Writer')];
    const cluster = summarizeRunScope(graph, [], { kind: 'cluster', nodeIds: ['a', 'c'] }, context);
    expect(runChipLabel(cluster)).toBe('$0.05 + unpriced');
    expect(runChipTitle(cluster)).toBe('The priced part of this run costs about $0.05. “Writer” has no listed price.');
    const one = summarizeRunScope(graph, [{ id: 'x', source: 'a', target: 'c' }], { kind: 'node', nodeId: 'c' }, context);
    expect(runChipTitle(one)).toBe('The priced part of this run costs about $0.05. “Writer” has no listed price.');
  });

  it('a closed chip keeps its plain tooltip', () => {
    const summary = summarizeRunScope([priced('a', 'nano-banana')], [], { kind: 'graph' }, context);
    expect(runChipLabel(summary)).toBe('~$0.05');
    expect(runChipTitle(summary)).toBe('Estimated cost');
  });
});

describe('detail lines in the Run button title and the confirm', () => {
  it('write both ends in full', () => {
    const graph = [priced('e', 'gpt-image-2-edit', {}, 'Edit')];
    const summary = summarizeRunScope(graph, [], { kind: 'graph' }, context);
    expect(describeRunScope(summary)).toContain('Estimated $0.01–$0.20 at list prices (Edit $0.01–$0.20)');
    expect(runCostConfirmMessage(summary)).toContain('• Edit: $0.01–$0.20');
  });
});

describe('GM r7 item 3: the reasons follow the canvas', () => {
  it('orders each reason by where its first node sits, left to right', async () => {
    const { runChipTitle } = await import('../src/lib/runScope');
    const title = runChipTitle({ total: 3, paid: ['A', 'B', 'C'], cost: { low: 0.02, high: 0.43, lines: [{ name: 'P', low: 0.02, high: 0.43, runs: [1, 1] }],
      unpriced: ['Right', 'Left'], plan: [], plus: [], awaitingInput: ['Left'], sizeRefs: [],
      reasons: [{ name: 'Right', reason: { kind: 'noPrice' }, at: { x: 900, y: 0 } },
        { name: 'Left', reason: { kind: 'awaitingInput' }, at: { x: 100, y: 400 } }] } } as never)!;
    expect(title.indexOf('“Left”')).toBeGreaterThan(-1);
    expect(title.indexOf('“Left”')).toBeLessThan(title.indexOf('“Right”'));
  });
});
