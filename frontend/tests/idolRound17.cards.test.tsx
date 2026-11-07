/**
 * PR #203 round 17, GM r32: one heading over a refused run. Every card that
 * shows a node's run error (the model card, a universal model's card, the
 * Batch card, Create Studio's result) says "Nebula couldn’t start the run."
 * when the pre-call check refused the run (node data `errorNotStarted`), the
 * Agent log's heading; a run that started and failed keeps "Couldn't run the
 * node.". The person's own refused Run marks its nodes too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

import * as api from '../src/lib/api';
import { useGraphStore } from '../src/store/graphStore';
import { ModelNode } from '../src/components/nodes/ModelNode';
import { DynamicNode } from '../src/components/nodes/DynamicNode';
import { BatchNode } from '../src/components/nodes/BatchNode';
import { OutputRenderer } from '../src/components/create-studio/OutputRenderer';
import { RUNTIME_FIELDS } from '../src/lib/canvasUndo';

const REFUSED = 'Nebula couldn’t start the run.';
const STARTED = "Couldn't run the node.";
const KEY = 'Missing API key: OPENAI_API_KEY';
const KEY_LINE = 'Add your OpenAI API key in Settings, then run the node again.';

const node = (id: string, definitionId = 'gpt-image-1-generate', extra: Partial<NodeData> = {}): Node<NodeData> => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: id, definitionId, params: {}, state: 'idle', outputs: {}, ...extra },
});
const heading = (root: ParentNode) => root.querySelector('.failure-lines__heading')?.textContent ?? null;
const reason = (root: ParentNode) => root.querySelector('.failure-lines__reason')?.textContent ?? null;
const props = (id: string, data: NodeData) => ({ id, selected: false, data }) as unknown as NodeProps;

beforeEach(() => {
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [node('n1')], edges: [], runHistory: [] });
  vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('every card that shows a run error', () => {
  const refused = { state: 'error', error: KEY, errorPerson: KEY_LINE, errorNotStarted: true } as const;
  const failed = { state: 'error', error: KEY, errorPerson: KEY_LINE } as const;

  it.each([[true, REFUSED], [false, STARTED]])('the model card (refused before it started: %s)', (notStarted, expected) => {
    const { container } = render(<ModelNode {...props('n1', { ...node('n1').data, ...(notStarted ? refused : failed) })} />);
    expect(heading(container)).toBe(expected);
    expect(reason(container)).toBe(KEY_LINE);
  });

  it('a universal model’s card', () => {
    const data = { ...node('d1', 'fal-universal').data, ...refused };
    const { container } = render(<DynamicNode {...props('d1', data)} />);
    expect(heading(container)).toBe(REFUSED);
  });

  it('the Batch card', () => {
    const data = { label: 'Batch', definitionId: 'batch', params: { items_text: 'one' }, state: 'error', outputs: {},
      error: KEY, errorPerson: KEY_LINE, errorNotStarted: true } as unknown as NodeData;
    const { container } = render(<BatchNode {...props('b1', data)} />);
    expect(heading(container)).toBe(REFUSED);
  });

  it('Create Studio’s result', () => {
    const { container } = render(<OutputRenderer outputs={{}} state="error" error={KEY} errorPerson={KEY_LINE} errorNotStarted />);
    expect(heading(container)).toBe(REFUSED);
    cleanup();
    const started = render(<OutputRenderer outputs={{}} state="error" error={KEY} errorPerson={KEY_LINE} />);
    expect(heading(started.container)).toBe(STARTED);
  });
});

describe("the person's own Run", () => {
  it('a refusal marks the node and every other node in the run', async () => {
    useGraphStore.setState({ nodes: [node('n1'), node('t1', 'text-input')], edges: [
      { id: 'e1', source: 't1', sourceHandle: 'text', target: 'n1', targetHandle: 'prompt' }] });
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'validation_error',
      errors: [{ nodeId: 'n1', portId: '', message: KEY, person: KEY_LINE }] } as never);
    await useGraphStore.getState().executeNode('n1');
    const data = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.data;
    expect(data('n1')).toMatchObject({ state: 'error', errorPerson: KEY_LINE, errorNotStarted: true });
    expect(data('t1')).toMatchObject({ state: 'error', errorNotStarted: true });
  });

  it('a later start refused another way (busy) drops the mark, so the card says its own heading', async () => {
    useGraphStore.setState({ nodes: [node('n1', 'gpt-image-1-generate', { state: 'error', error: KEY, errorPerson: KEY_LINE,
      errorNotStarted: true })], edges: [] });
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'busy' } as never);
    await useGraphStore.getState().executeNode('n1');
    const data = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!.data;
    expect(data.state).toBe('error');
    expect(data.errorNotStarted).toBeUndefined();
    const { container } = render(<ModelNode {...props('n1', data)} />);
    expect(heading(container)).not.toBe(REFUSED);
  });
});

describe('the mark is run state', () => {
  it('is a runtime field, so an undo of an edit never puts an old mark back or takes one away', () => {
    expect(RUNTIME_FIELDS as readonly string[]).toContain('errorNotStarted');
  });
});
