import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

// An agent's run (run_nodes, `nebula run`): this tab never started it, so it
// learns of it only from the broadcast events and the graph syncs after them.
const AGENT_RUN = 'cli_run_1';
const OLD_IMAGE = { image: { type: 'Image' as const, value: 'http://localhost:8000/api/outputs/old.png' } };

const node = (id: string, definitionId: string, extra: Partial<NodeData> = {}): Node<NodeData> => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: id, definitionId, params: {}, state: 'idle', outputs: {}, ...extra },
});
function send(event: Record<string, unknown>) {
  useGraphStore.getState().handleExecutionEvent(event as unknown as ExecutionEvent);
}
function sync(nodes: Node<NodeData>[]) {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes, edges: [], empty: false } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}
const data = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.data;

beforeEach(() => {
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({
    nodes: [node('n3', 'gpt-image-2-generate', { outputs: OLD_IMAGE, state: 'complete' }), node('n4', 'nano-banana')],
    edges: [],
  });
});

describe("an agent's run on an open canvas", () => {
  it('shows a failure on the card, and the sync that ends the run keeps it', () => {
    send({ type: 'executing', runId: AGENT_RUN, nodeId: 'n3' });
    send({ type: 'error', runId: AGENT_RUN, nodeId: 'n3', error: 'OPENAI_API_KEY is required', retryable: false });
    expect(data('n3')).toMatchObject({ state: 'error', error: 'OPENAI_API_KEY is required' });

    // The backend still has the old image, so its sync says "complete".
    sync([node('n3', 'gpt-image-2-generate', { outputs: OLD_IMAGE, state: 'complete' }), node('n4', 'nano-banana')]);

    expect(data('n3')).toMatchObject({ state: 'error', error: 'OPENAI_API_KEY is required' });
    expect(data('n3').outputs.image.value).toContain('/api/outputs/old.png');
  });

  it('a new output from the backend replaces the error', () => {
    send({ type: 'error', runId: AGENT_RUN, nodeId: 'n3', error: 'HTTP 500', retryable: true });
    const fresh = { image: { type: 'Image' as const, value: 'http://localhost:8000/api/outputs/new.png' } };

    sync([node('n3', 'gpt-image-2-generate', { outputs: fresh, state: 'complete' }), node('n4', 'nano-banana')]);

    expect(data('n3').state).toBe('complete');
  });

  it('a node the run never reached goes back to idle when the run ends', () => {
    send({ type: 'queued', runId: AGENT_RUN, nodeId: 'n3' });
    send({ type: 'queued', runId: AGENT_RUN, nodeId: 'n4' });
    send({ type: 'executing', runId: AGENT_RUN, nodeId: 'n3' });
    send({ type: 'error', runId: AGENT_RUN, nodeId: 'n3', error: 'OPENAI_API_KEY is required', retryable: false });
    expect(data('n4').state).toBe('queued');

    send({ type: 'executionStatus', runId: AGENT_RUN, status: 'failed' });

    expect(data('n4').state).toBe('idle');
    expect(data('n3').state).toBe('error');
  });

  it('a run the pre-call check refused marks the node, as a refused click on Run does', () => {
    send({ type: 'validationError', runId: AGENT_RUN,
      errors: [{ nodeId: 'n3', portId: '', message: 'Missing API key: OPENAI_API_KEY' }] });

    expect(data('n3')).toMatchObject({ state: 'error', error: 'Missing API key: OPENAI_API_KEY' });
    sync([node('n3', 'gpt-image-2-generate', { outputs: OLD_IMAGE, state: 'complete' }), node('n4', 'nano-banana')]);
    expect(data('n3').state).toBe('error');
  });
});

// The backend keeps each node's last error (services/node_errors.py) and every
// graph it sends says it, so a tab that missed the run's events (a reload, a
// reconnect, a project switch and back) still shows it.
describe('a graph sync that carries a node error', () => {
  const failed = (id: string, definitionId: string, extra: Partial<NodeData> = {}) =>
    node(id, definitionId, { state: 'error', error: 'Missing API key: OPENAI_API_KEY', ...extra });

  it('shows it on a node with no output yet', () => {
    sync([node('n3', 'gpt-image-2-generate', { outputs: OLD_IMAGE, state: 'complete' }), failed('n4', 'nano-banana')]);

    expect(data('n4')).toMatchObject({ state: 'error', error: 'Missing API key: OPENAI_API_KEY' });
  });

  it('shows it over an older output, with the friendly line and category', () => {
    sync([failed('n3', 'gpt-image-2-generate', { outputs: OLD_IMAGE, error: 'HTTP 429',
      errorFriendly: 'OpenAI is busy', errorCategory: 'rate_limit' }), node('n4', 'nano-banana')]);

    expect(data('n3')).toMatchObject({ state: 'error', error: 'HTTP 429', errorFriendly: 'OpenAI is busy',
      errorCategory: 'rate_limit' });
  });

  it("takes the sync's whole error, not an older run's friendly line beside a newer message", () => {
    // This tab saw a 429 (friendly line and category), then missed the
    // events of the run that failed again with a missing key (a reconnect).
    send({ type: 'error', runId: AGENT_RUN, nodeId: 'n3', error: 'HTTP 429', category: 'rate_limit',
      friendly: 'OpenAI is busy', retryable: true });
    sync([failed('n3', 'gpt-image-2-generate', { outputs: OLD_IMAGE }), node('n4', 'nano-banana')]);

    expect(data('n3').error).toBe('Missing API key: OPENAI_API_KEY');
    expect(data('n3').errorFriendly).toBeUndefined();
    expect(data('n3').errorCategory).toBeUndefined();
  });

  it("doesn't stop a run this tab just started", () => {
    send({ type: 'queued', runId: AGENT_RUN, nodeId: 'n4' });
    sync([node('n3', 'gpt-image-2-generate', { outputs: OLD_IMAGE, state: 'complete' }), failed('n4', 'nano-banana')]);

    expect(data('n4').state).toBe('queued');
  });
});
