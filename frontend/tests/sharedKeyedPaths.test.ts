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
import { proposalEstimateLabel } from '../src/lib/canvasProposals';
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
  it('a keyed route priced at a sourced $0 reads "$0" with its tooltip', () => {
    const summary = summarizeRunScope([node()], [], { kind: 'graph' }, { pricing, apiKeys: { [KEY]: 'set' } });
    expect(summary.paid).toEqual(['Synthetic']);
    expect(summary.cost?.sourcedZero).toBe(true);
    expect(runChipLabel(summary)).toBe('$0');
    expect(runChipTitle(summary)).toBe(`“Synthetic” calls a paid provider. ${SOURCED_ZERO_TITLE}`);
  });

  it('a proposal whose estimate is a sourced $0 reads "$0", one that rounds to it "~$0"', () => {
    const estimate = { currency: 'usd' as const, low: 0, high: 0, open: false, unpriced: [], plan: [], plus: [] };
    const view = (sourced: boolean) => ({ run: ['+s'], cost: { estimate: sourced ? { ...estimate, sourcedZero: true as const } : estimate } }) as unknown as ProposalView;
    expect(proposalEstimateLabel(view(true))).toBe('$0');
    expect(proposalEstimateLabel(view(false))).toBe('~$0');
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
