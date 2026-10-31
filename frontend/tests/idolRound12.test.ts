/**
 * PR #203 round 12: GM r22 and r23, and review 11's copy and settings items.
 *
 * - GM r22 item 1: "~$0.13 · 1 may cost", pinned on the Run chip.
 * - GM r22 item 4: person lines say "Krea API key", as the row does.
 * - GM r23 (review 11, copy NIT-1): "Hugging Face token saved." /
 *   "Hugging Face token removed." / "Hugging Face token saved. Checking it now."
 * - GM r23 (review 11, copy NIT-3): the Krea sign-in row's summary and the
 *   readiness detail.
 * - Review 11, copy LOW-2: the notice region keeps clear of the workspace rail.
 * - Review 11, copy MEDIUM-1: each tab knows its own write's echo (lib/tabId.ts).
 * - Review 11, NIT-4: a kind the canvas doesn't name is never counted free.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { connectedRows, KREA_ROW, NOUS_ROW } from '../src/components/panels/settings/rowHelpers';
import { KEY_NAMES } from '../src/lib/directRoute';
import type { PricingTable } from '../src/lib/pricing';
import { modelReadiness } from '../src/lib/providerReadiness';
import { runChipLabel, summarizeRunScope } from '../src/lib/runScope';
import { keyChangedLine, keyNoun } from '../src/lib/settingsWrites';
import type { NodeData } from '../src/types';
import shippedTable from '../../backend/data/model_pricing.json';
import routeTables from '../../backend/tests/fixtures/route_tables.json';

const SRC = resolve(__dirname, '../src');
const at = (id: string, definitionId: string, label: string, x: number, params: Record<string, unknown> = {}): Node<NodeData> =>
  ({ id, position: { x, y: 0 }, data: { definitionId, label, params } as unknown as NodeData });

describe('"~$0.13 · 1 may cost" (GM r22 item 1)', () => {
  it('is the Run chip for a priced paid run beside Idol with a token', () => {
    const graph = [at('n', 'gpt-image-1-5', 'Hero', 0), at('i', 'speridlabs-idol', 'Idol', 100)];
    const summary = summarizeRunScope(graph, [], { kind: 'graph' },
      { pricing: shippedTable as unknown as PricingTable, apiKeys: { OPENAI_API_KEY: 'set', HF_TOKEN: 'hf_fixture' } });
    expect(summary.mayCost).toEqual([{ name: 'Idol', account: 'Hugging Face' }]);
    expect(runChipLabel(summary)).toBe('~$0.13 · 1 may cost');
  });
});

describe('the provider’s own noun (GM r23; review 11, copy NIT-1)', () => {
  it('says "Hugging Face token" in every notice', () => {
    expect(keyNoun('HF_TOKEN')).toBe('Hugging Face token');
    expect(keyChangedLine('HF_TOKEN', true)).toBe('Hugging Face token saved.');
    expect(keyChangedLine('HF_TOKEN', false)).toBe('Hugging Face token removed.');
  });

  it('keeps every other row’s word: "Replicate key", "Krea · API key"', () => {
    expect(keyChangedLine('REPLICATE_API_TOKEN', true)).toBe('Replicate key saved.');
    expect(keyNoun('KREA_API_TOKEN')).toBe('Krea · API key');
    expect(keyNoun('OPENAI_API_KEY')).toBe('OpenAI key');
  });

  it('builds the own-save toast from the same noun', () => {
    const source = readFileSync(resolve(SRC, 'lib/settingsWrites.ts'), 'utf8');
    expect(source).toContain('notify(`${keyNoun(key)} saved. Checking it now.`');
    expect(source).toContain('notify(`${keyNoun(key)} removed.`)');
  });
});

describe('"Krea API key" in person lines, as the row says (GM r22 item 4)', () => {
  it('names the key as the backend does', () => {
    expect(KEY_NAMES.KREA_API_TOKEN).toEqual(['Krea', 'API key']);
    expect((routeTables as unknown as { keyNames: Record<string, string[]> }).keyNames.KREA_API_TOKEN).toEqual(['Krea', 'API key']);
  });

  it('says it in the readiness line for a Krea copy without a key', () => {
    const ready = modelReadiness(NODE_DEFINITIONS['krea-image-google-nano-banana-2'], {}, { loaded: true, apiKeys: {} } as never,
      { loading: false, providers: {}, checkedAt: null, error: null } as never);
    expect(JSON.stringify(ready)).not.toContain('Krea API token');
  });
});

describe('the Krea sign-in words (GM r23; review 11, copy NIT-3 and LOW-3)', () => {
  it('the readiness detail', () => {
    const def = NODE_DEFINITIONS['krea-2-generate'];
    const ready = modelReadiness(def, { _kreaAuth: 'mcp' }, { loaded: true, apiKeys: {}, kreaConnection: { status: 'disconnected' } } as never,
      { loading: false, providers: {}, checkedAt: null, error: null } as never);
    expect(ready.detail).toBe('This recipe uses Krea sign-in. Sign in to Krea in Settings; an API key doesn’t replace it.');
  });
});

describe('the notice region keeps clear of the workspace rail (review 11, copy LOW-2)', () => {
  const css = readFileSync(resolve(SRC, 'styles/noticeRegion.css'), 'utf8');
  const rule = css.match(/:root:has\(\.workspace-rail\) \.notice-region\s*\{([^}]*)\}/)?.[1] ?? '';

  it('starts past the rail’s column and keeps the same room on the right', () => {
    expect(rule).toMatch(/--notice-rail-clearance:\s*calc\(var\(--workspace-rail-left[^)]*\) \+ var\(--workspace-rail-width[^)]*\) \+ var\(--notice-gap\)\)/);
    expect(rule).toMatch(/left:\s*max\(var\(--page-gutter, 16px\), var\(--notice-rail-clearance\)\)/);
    expect(rule).toMatch(/right:\s*max\(var\(--page-gutter, 16px\), var\(--notice-rail-clearance\), var\(--agent-log-clearance, 0px\)\)/);
  });

  it('changes no layer: the bar stays under the rail’s labels, menus and popovers', () => {
    expect(rule).not.toMatch(/z-index|transform|isolation|filter|opacity|contain|will-change/);
  });
});

describe('each tab knows its own write (review 11, copy MEDIUM-1)', () => {
  it('has one id: the socket drops echoes by the id apiFetch sends (tests/idolRound12.tabEcho.test.ts)', () => {
    const socket = readFileSync(resolve(SRC, 'store/settingsChangedSocket.ts'), 'utf8');
    expect(socket).toContain("import { TAB_ID } from '../lib/tabId';");
    expect(readFileSync(resolve(SRC, 'lib/settingsSignal.ts'), 'utf8')).not.toMatch(/TAB_ID|randomUUID/);
  });
});

describe('one source for the badge and "Connected · N" (review 11, copy NIT-2)', () => {
  const nous = (checkedAt: number) => ({ checkedAt, providers: {
    Nous: { configured: true, status: 'valid', last_checked: new Date(checkedAt).toISOString() } } } as never);

  it('counts Nous only by a current check, and Krea unless it is disconnected', () => {
    const now = Date.now();
    expect(connectedRows({ apiKeys: {}, kreaStatus: 'connecting', health: nous(now) })).toMatchObject({ [NOUS_ROW]: true, [KREA_ROW]: true });
    const stale = now - 30 * 24 * 60 * 60 * 1000;
    expect(connectedRows({ apiKeys: {}, kreaStatus: 'disconnected', health: nous(stale) })).toMatchObject({ [NOUS_ROW]: false, [KREA_ROW]: false });
    expect(connectedRows({ apiKeys: {}, kreaStatus: undefined, health: { checkedAt: null, providers: {} } as never })[KREA_ROW]).toBe(false);
  });
});

describe('a kind the canvas doesn’t name is never counted free (review 11, NIT-4)', () => {
  it('counts free runs from kind "free" when a token turns Idol into may cost', async () => {
    const { liveKeyBilling } = await import('../src/lib/canvasProposals');
    const view = {
      nodes: [],
      cost: {
        paidRuns: 1, planRuns: 0, mayCostRuns: 0, mayCost: [], freeRuns: 1, upTo: false, providers: [],
        nodes: [
          { ref: '+i', nodeId: null, definitionId: 'speridlabs-idol', kind: 'free', provider: 'speridlabs', label: 'free · Hugging Face' },
          { ref: '+s', nodeId: null, definitionId: 'text-input', kind: 'someday', provider: null, label: 'someday' },
        ],
      },
    } as unknown as Parameters<typeof liveKeyBilling>[0];
    const live = liveKeyBilling(view, { HF_TOKEN: 'hf_fixture' }, () => ({}));
    expect(live.cost.mayCostRuns).toBe(1);
    expect(live.cost.freeRuns).toBe(0);
    expect(live.cost.paidRuns).toBe(1);
  });
});
