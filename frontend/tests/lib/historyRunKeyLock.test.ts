import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { historyRunKeyLock } from '../../src/lib/historyRunKeyLock';
import type { RunRecord } from '../../src/lib/runHistory';
import type { NodeData } from '../../src/types';

/**
 * GM, PR #203 r8 items 1-3: a Run History replay locks only when the run it
 * replays includes a real Idol, with Idol's line. A whole-canvas replay skips
 * an agent's placeholder, as a canvas run does; a node's replay runs it.
 */
const LINE = 'You can run Idol after you add your Hugging Face token in Settings.';
const NO_TOKEN = { loaded: true, apiKeys: {} };

function record(targetNodeId?: string): RunRecord {
  return {
    id: 'r1', status: 'complete', trigger: targetNodeId ? 'node' : 'graph', startedAt: 1, targetNodeId,
    snapshot: {
      nodes: [{ id: 'text', definitionId: 'text-input', params: { value: 'a cube' }, outputs: {} },
        { id: 'idol', definitionId: 'speridlabs-idol', params: {}, outputs: {} }],
      edges: [],
    },
  };
}

function live(placeholder: boolean): Node<NodeData>[] {
  return [{ id: 'idol', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Idol', definitionId: 'speridlabs-idol', params: {}, outputs: {}, state: 'idle',
      ...(placeholder ? { pending: { agent: { id: 'claude-code', name: 'Claude Code', color: '#d97757' }, at: 1 } } : {}) } }];
}

describe('historyRunKeyLock', () => {
  it("locks a replay that runs a real Idol, with Idol's line", () => {
    expect(historyRunKeyLock(record(), live(false), NO_TOKEN)).toBe(LINE);
    expect(historyRunKeyLock(record('idol'), live(false), NO_TOKEN)).toBe(LINE);
  });

  it("a whole-canvas replay skips the agent's placeholder Idol; a node's replay of it runs it", () => {
    expect(historyRunKeyLock(record(), live(true), NO_TOKEN)).toBeNull();
    expect(historyRunKeyLock(record('idol'), live(true), NO_TOKEN)).toBe(LINE);
  });

  it('a replay of Text alone, the token set, or Settings not loaded: no lock', () => {
    expect(historyRunKeyLock(record('text'), live(false), NO_TOKEN)).toBeNull();
    expect(historyRunKeyLock(record(), live(false), { loaded: true, apiKeys: { HF_TOKEN: 'set' } })).toBeNull();
    expect(historyRunKeyLock(record(), live(false), { loaded: false, apiKeys: {} })).toBeNull();
  });
});
