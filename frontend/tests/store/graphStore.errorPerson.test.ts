/**
 * Error copy round 3c: the person's line travels with a node's run error
 * (the backend's ErrorEvent `person`, node data `errorPerson`), the way
 * `friendly` and `category` already do, and never outlives the error it was
 * written for. The specific text stays in `error` (agents read it there).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../../src/lib/savedParamsUpgrades';
import { RUNTIME_FIELDS } from '../../src/lib/canvasUndo';

const SPECIFIC = 'World Labs export start response was not received. Nebula safety-locked this node …';
const PERSON = 'World Labs didn\'t answer this run, so Nebula locked the node to avoid paying twice. Check the job in '
  + 'Marble, then use “Checked Marble — unlock” before you run it again.';

const node = (id: string, extra: Partial<NodeData> = {}): Node<NodeData> => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: id, definitionId: 'worldlabs-world-export', params: {}, state: 'idle', outputs: {}, ...extra },
});
const send = (event: Record<string, unknown>) =>
  useGraphStore.getState().handleExecutionEvent(event as unknown as ExecutionEvent);
function sync(nodes: Node<NodeData>[]) {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes, edges: [], empty: false } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}
const data = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.data;

beforeEach(() => {
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [node('n2')], edges: [] });
});

describe("a node run error's person line", () => {
  it('comes with the error event, beside the specific text', () => {
    send({ type: 'error', nodeId: 'n2', error: SPECIFIC, person: PERSON, category: 'unknown', friendly: SPECIFIC, retryable: false });
    expect(data('n2')).toMatchObject({ state: 'error', error: SPECIFIC, errorPerson: PERSON });
  });

  it("a later error with no line of its own doesn't keep the older line", () => {
    send({ type: 'error', nodeId: 'n2', error: SPECIFIC, person: PERSON, category: 'unknown', retryable: false });
    send({ type: 'error', nodeId: 'n2', error: 'HTTP 500', category: 'unknown', retryable: true });
    expect(data('n2').errorPerson).toBeUndefined();
  });

  it("a pre-run check's message replaces it", () => {
    send({ type: 'error', nodeId: 'n2', error: SPECIFIC, person: PERSON, category: 'unknown', retryable: false });
    send({ type: 'validationError', errors: [{ nodeId: 'n2', portId: '', message: 'Missing API key: WORLDLABS_API_KEY' }] });
    expect(data('n2')).toMatchObject({ error: 'Missing API key: WORLDLABS_API_KEY' });
    expect(data('n2').errorPerson).toBeUndefined();
  });

  it("a reload's graph sync brings it back with the error, whole", () => {
    sync([node('n2', { state: 'error', error: SPECIFIC, errorPerson: PERSON, errorCategory: 'unknown' })]);
    expect(data('n2')).toMatchObject({ state: 'error', error: SPECIFIC, errorPerson: PERSON });
    // A newer failure from a sync with no line drops the older one.
    sync([node('n2', { state: 'error', error: 'Missing API key: WORLDLABS_API_KEY' })]);
    expect(data('n2').errorPerson).toBeUndefined();
  });

  it('is part of the run state canvas undo leaves alone', () => {
    expect(RUNTIME_FIELDS as readonly string[]).toContain('errorPerson');
  });
});
