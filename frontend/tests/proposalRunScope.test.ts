/**
 * Review r5 LOW-2 of PR #203 (the reviewer's probes, moved into the suite):
 * Accept's and the held "Run now"'s key lock read the run each one starts,
 * as the backend runs it. An approval run is not direct, so it skips an
 * agent's placeholder (main.py _skip_placeholders, direct=None); several run
 * nodes run with their ancestors; a run of nothing has no lock; a held run's
 * deleted node is ignored.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), subscribe: () => () => {} } }));
import { proposalAcceptLock } from '../src/lib/proposalAcceptLock';
import { deferredRunKeyLock } from '../src/store/canvasProposalsStore';
import type { NodeData } from '../src/types';
import type { ProposalView } from '../src/lib/wsClient';
import { keyIdolInEachTest } from './helpers/keyedSpace';

// PR #203 round 7: Idol is keyless. These tests pin the shared key-lock
// machinery on Idol's keyed shape (rounds 4 to 6; tests/helpers/keyedSpace.ts).
keyIdolInEachTest();
const ACC = 'You can accept this after you add your Hugging Face token in Settings.';
const RUN = 'You can run Idol after you add your Hugging Face token in Settings.';
const NO = { loaded: true, apiKeys: {} };
const CODEX = { pending: { agent: { id: 'codex', name: 'Codex', color: '#5B9DFF' }, at: 1 } };
const nd = (id: string, d: string, extra = {}) => ({ id, type: 'model-node', position: { x: 0, y: 0 }, data: { label: id, definitionId: d, params: d === 'image-input' ? { filePath: '/x.png' } : {}, outputs: {}, state: 'idle', ...extra } }) as Node<NodeData>;
const edges = [{ id: 'e1', source: 'img', target: 'idol', sourceHandle: 'image', targetHandle: 'image' },
  { id: 'e2', source: 'idol', target: 'exp', sourceHandle: 'world', targetHandle: 'world' }] as Edge[];
const canvas = (ph: boolean) => ({ nodes: [nd('img', 'image-input'), nd('idol', 'speridlabs-idol', ph ? CODEX : {}), nd('exp', 'worldlabs-world-export'), nd('txt', 'text-input')], edges });
const view = (run: string[], cost: Partial<ProposalView['cost']> = {}) => ({ id: 'p', nodes: [], edges: [], params: [], run,
  cost: { paidRuns: 1, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [], note: '', ...cost } }) as unknown as ProposalView;
describe('accept scope', () => {
  it('one run node over a canvas placeholder Idol: accept run skips it (backend: approval run is not direct) -> unlocked', () => {
    expect(proposalAcceptLock(view(['exp']), undefined, canvas(true), NO)).toBeNull();
  });
  it('one run node over a real Idol -> locked', () => {
    expect(proposalAcceptLock(view(['exp']), undefined, canvas(false), NO)).toBe(ACC);
  });
  it('two run nodes, one fed by a real Idol not in run: cluster takes ancestors -> locked', () => {
    expect(proposalAcceptLock(view(['exp', 'txt']), undefined, canvas(false), NO)).toBe(ACC);
  });
  it('runsNothing view -> no lock', () => {
    expect(proposalAcceptLock(view(['exp'], { paidRuns: 0, freeRuns: 0, pendingSkipped: { count: 2 } as never }), undefined, canvas(false), NO)).toBeNull();
  });
});
describe('deferred scope', () => {
  it('approval run over a placeholder Idol skips it -> unlocked; a no-approval (direct) run takes it -> locked', () => {
    const g = canvas(true);
    expect(deferredRunKeyLock({ agentName: 'Codex', nodeIds: ['exp'], approvalId: 'ap' }, g, NO)).toBeNull();
    expect(deferredRunKeyLock({ agentName: 'Codex', nodeIds: ['exp'], approvalId: null }, g, NO)).toBe(RUN);
  });
  it('a deleted node in the held run is ignored', () => {
    expect(deferredRunKeyLock({ agentName: 'Codex', nodeIds: ['gone'], approvalId: 'ap' }, canvas(false), NO)).toBeNull();
  });
});
