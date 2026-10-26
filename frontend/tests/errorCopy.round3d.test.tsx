/**
 * Error copy round 3d (GM - Design): a line written for a provider's answer
 * keeps the provider's own words behind Details. GM: "Raw provider text stays
 * behind Details in every case."
 *
 * The backend's ErrorEvent says so with `providerText` (node data
 * `errorProviderText`, a shot's `errorProviderText`): the status table's
 * lines ("Meshy is busy. …"), an empty answer's line, and a handler's line
 * around the provider's words (Krea's refused input). A line Nebula wrote
 * from its own words still shows no Details (round 3c: the specific text is
 * for agents).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { NodeError } from '../src/components/nodes/NodeError';
import { BatchNode } from '../src/components/nodes/BatchNode';
import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { nodeErrorCopy } from '../src/lib/nodeErrorCopy';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { RUNTIME_FIELDS } from '../src/lib/canvasUndo';

const HEADING = "Couldn't run the node.";
const BUSY = 'Meshy is busy. Wait a moment, then run the node again.';
const RAW = 'Meshy submit failed (429): {"message":"Too many requests","request_id":"req_429"}';
const OWN = 'Meshy is taking longer than usual. The job may still finish there and be billed, so check Meshy before you run the node again.';

const heading = (root: ParentNode) => root.querySelector('.failure-lines__heading')?.textContent ?? null;
const reason = (root: ParentNode) => root.querySelector('.failure-lines__reason')?.textContent ?? null;

const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };
afterEach(() => {
  cleanup();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUi, true);
});

describe("a line for a provider's answer", () => {
  it("keeps the provider's words behind a closed Details", () => {
    expect(nodeErrorCopy({ raw: RAW, category: 'rate_limit', person: BUSY, providerText: true }))
      .toEqual({ heading: HEADING, reason: BUSY, details: RAW });
    const { container } = render(<NodeError raw={RAW} category="rate_limit" person={BUSY} providerText />);
    expect(heading(container)).toBe(HEADING);
    expect(reason(container)).toBe(BUSY);
    const details = container.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('req_429');
  });

  it("a line in Nebula's own words still shows none", () => {
    expect(nodeErrorCopy({ raw: 'Meshy task timed out after 300 polls', category: 'timeout', person: OWN }))
      .toEqual({ heading: HEADING, reason: OWN, details: null });
  });

  it('the Batch card reads it the same way', () => {
    const data: NodeData = { definitionId: 'batch', label: 'Batch', params: { items_text: 'a' }, state: 'error',
      outputs: {}, error: RAW, errorCategory: 'rate_limit', errorPerson: BUSY, errorProviderText: true };
    const { container } = render(<BatchNode {...({ id: 'b1', data, selected: false } as unknown as NodeProps)} />);
    expect(reason(container)).toBe(BUSY);
    expect(container.querySelector('details')!.textContent).toContain('req_429');
  });

  it('a Cinema shot reads it the same way', () => {
    const spec: CinemaSceneSpec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{
      id: 'a', prompt: 'Logo', output: { status: 'error', error: RAW, errorCategory: 'rate_limit',
        errorPerson: BUSY, errorProviderText: true, errorRaw: RAW } }] };
    const node: Node<NodeData> = { id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 }, data: {
      label: 'Scene', definitionId: 'cinema-scene', params: { scene: spec }, state: 'error', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [], isImportingGraph: false, isShotAdmissionBlocked: () => false });
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    const { container } = render(<CinemaShotPanel cinemaNodeId="n1" scene={spec} shot={spec.shots[0]} onChangeShot={vi.fn()} />);
    const error = container.querySelector('.cinema-shot-panel__error')!;
    expect(reason(error)).toBe(BUSY);
    expect(error.querySelector('details')!.textContent).toContain('req_429');
  });
});

describe('the store carries the flag with its error, and never past it', () => {
  const node = (id: string, extra: Partial<NodeData> = {}): Node<NodeData> => ({
    id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: id, definitionId: 'meshy-text-to-3d', params: {}, state: 'idle', outputs: {}, ...extra },
  });
  const send = (event: Record<string, unknown>) =>
    useGraphStore.getState().handleExecutionEvent(event as unknown as ExecutionEvent);
  const data = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.data;

  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [node('n2')], edges: [] });
  });

  it('comes with the error event', () => {
    send({ type: 'error', nodeId: 'n2', error: RAW, person: BUSY, providerText: true, category: 'rate_limit', retryable: true });
    expect(data('n2')).toMatchObject({ errorPerson: BUSY, errorProviderText: true });
  });

  it('a later error without it drops it', () => {
    send({ type: 'error', nodeId: 'n2', error: RAW, person: BUSY, providerText: true, category: 'rate_limit', retryable: true });
    send({ type: 'error', nodeId: 'n2', error: 'No mask painted yet', person: 'No mask painted yet', category: 'unknown', retryable: false });
    expect(data('n2').errorProviderText).toBeUndefined();
  });

  it("a pre-run check's message drops it", () => {
    send({ type: 'error', nodeId: 'n2', error: RAW, person: BUSY, providerText: true, category: 'rate_limit', retryable: true });
    send({ type: 'validationError', errors: [{ nodeId: 'n2', portId: '', message: 'Missing API key: MESHY_API_KEY' }] });
    expect(data('n2').errorProviderText).toBeUndefined();
  });

  it("a reload's graph sync brings it back with the error, whole", () => {
    const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, edges: [], empty: false,
      nodes: [node('n2', { state: 'error', error: RAW, errorPerson: BUSY, errorProviderText: true, errorCategory: 'rate_limit' })] };
    for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event as unknown as ExecutionEvent);
    expect(data('n2')).toMatchObject({ errorPerson: BUSY, errorProviderText: true });
  });

  it('is part of the run state canvas undo leaves alone', () => {
    expect(RUNTIME_FIELDS as readonly string[]).toContain('errorProviderText');
  });
});
