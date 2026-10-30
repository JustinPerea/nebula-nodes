/**
 * The paths Idol staged in PR #203 that GM kept because they are shared
 * (r14, "Staged code": keep them "if they live in the shared formatter and
 * lock helper. Other nodes will reach them, a keyed provider through Accept,
 * for example"): the sourced-$0 chip and its tooltip (runScope runChipLabel /
 * runChipTitle, canvasProposals proposalEstimateLabel), and the key lock
 * lines (runKeyLock: the Run line, withKeyLock, Accept's line through
 * proposalAcceptLock, and a Run History replay's: historyRunKeyLock through
 * canKeyLock, review 8 of PR #203, copy NIT-1). Each is exercised here on a synthetic keyed route
 * that is not Idol, so a later Idol-only shortcut can't pass them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { liveKeyBilling, proposalEstimateLabel } from '../src/lib/canvasProposals';
import type { PricingTable } from '../src/lib/pricing';
import { historyRunKeyLock } from '../src/lib/historyRunKeyLock';
import { proposalAcceptLock } from '../src/lib/proposalAcceptLock';
import type { RunRecord } from '../src/lib/runHistory';
import { canKeyLock, runKeyLockLine, withKeyLock } from '../src/lib/runKeyLock';
import { runChipLabel, runChipTitle, SOURCED_ZERO_TITLE, summarizeRunScope } from '../src/lib/runScope';
import type { ProposalView } from '../src/lib/wsClient';
import type { ModelNodeDefinition, NodeData } from '../src/types';

const ID = 'synthetic-keyed-route';
const LINE = 'You can run Synthetic after you add your Replicate API token in Settings.';
const KEY = 'REPLICATE_API_TOKEN';

function synthetic(): ModelNodeDefinition {
  const base = JSON.parse(JSON.stringify(NODE_DEFINITIONS['speridlabs-idol'])) as ModelNodeDefinition;
  return {
    ...base, id: ID, displayName: 'Synthetic', envKeyName: [KEY], directKeyName: [KEY],
    routes: [{ id: 'syn', provider: 'replicate', handler: 'replicate-model', maker: true, keys: [KEY],
      missingKeyLine: LINE } as never],
  };
}

const pricing = { version: 1, nodes: { [ID]: { routes: { syn: {
  currency: 'usd', per: 'request', rows: [{ match: {}, price: 0 }] } } } } } as unknown as PricingTable;

const node = (): Node<NodeData> => ({ id: 's1', position: { x: 0, y: 0 },
  data: { definitionId: ID, label: '', params: {} } as unknown as NodeData });

let saved: unknown;
beforeEach(() => {
  saved = NODE_DEFINITIONS[ID];
  (NODE_DEFINITIONS as Record<string, unknown>)[ID] = synthetic();
});
afterEach(() => {
  (NODE_DEFINITIONS as Record<string, unknown>)[ID] = saved;
});

describe('the sourced $0 lives in the shared formatter', () => {
  it('a keyed route priced at a sourced $0 is free and reads "$0", its tooltip only that (GM, PR #203 r18 item 1)', () => {
    const summary = summarizeRunScope([node()], [], { kind: 'graph' }, { pricing, apiKeys: { [KEY]: 'set' } });
    expect(summary.paid).toEqual([]);
    expect(summary.free).toEqual(['Synthetic']);
    expect(summary.cost?.sourcedZero).toBe(true);
    expect(runChipLabel(summary)).toBe('$0');
    expect(runChipTitle(summary)).toBe(SOURCED_ZERO_TITLE);
    expect(SOURCED_ZERO_TITLE).toBe('This costs nothing to run.');
  });

  it('a proposal whose estimate is a sourced $0 reads "$0", one that rounds to it "~$0"', () => {
    const estimate = { currency: 'usd' as const, low: 0, high: 0, open: false, unpriced: [], plan: [], plus: [] };
    const view = (sourced: boolean) => ({ run: ['+s'], cost: { estimate: sourced ? { ...estimate, sourcedZero: true as const } : estimate } }) as unknown as ProposalView;
    expect(proposalEstimateLabel(view(true))).toBe('$0');
    expect(proposalEstimateLabel(view(false))).toBe('~$0');
  });
});

/** A key-billing route on Replicate (not a Space, not Hugging Face): the
 * class, its account and its label come from directRoute, never from a
 * hard-coded name (review 9 of PR #203, cost LOW-3: mutants C11 and C12). */
function billing(): ModelNodeDefinition {
  const base = synthetic();
  return { ...base, routes: [{ id: 'syn', provider: 'replicate', handler: 'replicate-model', maker: true, keys: [],
    optionalKeys: [KEY], mayBillWithKey: true } as never] };
}

describe('a key-billing route on another account is named by that account', () => {
  beforeEach(() => { (NODE_DEFINITIONS as Record<string, unknown>)[ID] = billing(); });

  it('the Run chip counts it apart and names Replicate, not Hugging Face', () => {
    const summary = summarizeRunScope([node()], [], { kind: 'graph' }, { pricing, apiKeys: { [KEY]: 'set' } });
    expect(summary.paid).toEqual([]);
    expect(summary.mayCost).toEqual([{ name: 'Synthetic', account: 'Replicate' }]);
    expect(runChipLabel(summary)).toBe('1 may cost');
    expect(runChipTitle(summary)).toBe('Synthetic can use your Replicate credits.');
    // Without the key it is free and the chip says nothing.
    const free = summarizeRunScope([node()], [], { kind: 'graph' }, { pricing, apiKeys: {} });
    expect([free.paid, free.mayCost, runChipLabel(free)]).toEqual([[], undefined, null]);
  });

  it('a proposal\'s card reads its label with the keys set now', () => {
    const view = {
      id: 'p', run: ['+s'], params: [], edges: [],
      nodes: [{ ref: '+s', definitionId: ID, name: 'Synthetic', params: {}, position: { x: 0, y: 0 },
        cost: { kind: 'free', provider: 'replicate', label: 'free · Replicate' } }],
      cost: { paidRuns: 0, freeRuns: 1, mayCostRuns: 0, mayCost: [], estimate: null, upTo: false, providers: [], note: '',
        nodes: [{ ref: '+s', nodeId: null, definitionId: ID, kind: 'free', provider: 'replicate', label: 'free · Replicate', price: null }] },
    } as unknown as ProposalView;
    const live = liveKeyBilling(view, { [KEY]: 'set' }, () => ({}));
    expect(live.nodes[0].cost).toMatchObject({ kind: 'mayCost', label: 'may cost · Replicate', account: 'Replicate' });
    expect(live.cost.mayCost).toEqual([{ name: 'Synthetic', account: 'Replicate' }]);
    expect(live.cost.mayCostRuns).toBe(1);
  });
});

describe('the key lock lines live in the shared lock helper', () => {
  const settings = (keys: Record<string, string>) => ({ loaded: true, apiKeys: keys });

  it('Run is locked with the route\'s own line, and withKeyLock carries it', () => {
    expect(runKeyLockLine([node()], [], { kind: 'node', nodeId: 's1', direct: true }, settings({}))).toBe(LINE);
    expect(runKeyLockLine([node()], [], { kind: 'node', nodeId: 's1', direct: true }, settings({ [KEY]: 'set' }))).toBeNull();
    const locked = withKeyLock({ disabled: false, title: 'Run' }, LINE, 'reason-id');
    expect(locked).toMatchObject({ disabled: false, title: LINE, 'aria-disabled': true, 'data-key-locked': '' });
  });

  it('Accept is locked with the key\'s phrase until it is set', () => {
    const view = {
      run: ['+s'], params: [], edges: [],
      nodes: [{ ref: '+s', definitionId: ID, name: 'Synthetic', params: {}, position: { x: 0, y: 0 } }],
      cost: { paidRuns: 1, freeRuns: 0, nodes: [] },
    } as unknown as ProposalView;
    expect(proposalAcceptLock(view, undefined, { nodes: [], edges: [] }, settings({})))
      .toBe('You can accept this after you add your Replicate API token in Settings.');
    expect(proposalAcceptLock(view, undefined, { nodes: [], edges: [] }, settings({ [KEY]: 'set' }))).toBeNull();
  });

  it('a Run History replay of the route is locked with its line until the key is set (copy NIT-1, M21)', () => {
    expect(canKeyLock(ID)).toBe(true);
    const record = (targetNodeId?: string): RunRecord => ({
      id: 'r1', status: 'complete', trigger: targetNodeId ? 'node' : 'graph', startedAt: 1, targetNodeId,
      snapshot: { nodes: [{ id: 's1', definitionId: ID, params: {}, outputs: {} }], edges: [] },
    } as RunRecord);
    for (const replay of [record(), record('s1')]) {
      expect(historyRunKeyLock(replay, [], settings({}))).toBe(LINE);
      expect(historyRunKeyLock(replay, [], settings({ [KEY]: 'set' }))).toBeNull();
      // An invisible-only key is no key (review 8, LOW-1).
      expect(historyRunKeyLock(replay, [], settings({ [KEY]: '\u200b' }))).toBe(LINE);
    }
  });
});
