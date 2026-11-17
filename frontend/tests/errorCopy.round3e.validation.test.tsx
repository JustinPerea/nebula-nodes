/**
 * Error copy round 3e, item 2 (GM - Design): a pre-run check reads like a
 * run error. The backend's validation errors carry an additive `person`
 * line (ValidationErrorDetail.person) beside `message`, the specific text
 * agents keep word for word. The store puts it in `errorPerson` from both
 * places a refusal arrives (the run call's answer and the socket's
 * validationError event), several checks on one node read together, and a
 * check with no line (only an agent or a damaged saved graph reaches it)
 * reads GM's general line with the text behind Details. The Batch card
 * doesn't say its cap twice.
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
import type { ExecutionEvent } from '../src/lib/wsClient';
import { ModelNode } from '../src/components/nodes/ModelNode';
import { BatchNode } from '../src/components/nodes/BatchNode';
import { OutputRenderer } from '../src/components/create-studio/OutputRenderer';

// Round 3f (GM): a card's general line, with no provider named. "Run the node
// again. If it keeps failing, Details shows what {Provider} said." when the run
// names one (tests/errorCopy.round3f.test.tsx).
const GENERAL = "Nebula couldn’t run the node. Run it again. If it keeps failing, open “Details”.";
const KEY = 'Missing API key: OPENAI_API_KEY';
const KEY_LINE = 'Add an OpenAI API key in Settings to run this node.';
const PORT = "Required input port 'prompt' is not connected";
const PORT_LINE = 'Connect a prompt, then run the node again.';
const OVER_CAP = 'Batch has 3 items, exceeding its batch_size_cap of 2. Reduce the list or raise the cap before running; '
  + 'no generation was started.';
const OVER_CAP_LINE = 'This Batch has 3 items, more than its Item cap of 2. Remove items or raise the cap, then run it again. '
  + 'Nothing was generated.';
const OTHER_NODE = 'Nothing ran. Another node in this run needs a fix first.';

const node = (id: string, definitionId = 'gpt-image-1-generate', extra: Partial<NodeData> = {}, type = 'model-node'): Node<NodeData> => ({
  id, type, position: { x: 0, y: 0 },
  data: { label: id, definitionId, params: {}, state: 'idle', outputs: {}, ...extra },
});
const send = (event: Record<string, unknown>) =>
  useGraphStore.getState().handleExecutionEvent(event as unknown as ExecutionEvent);
const data = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.data;
const reason = (root: ParentNode) => root.querySelector('.model-node__error-message, .failure-lines__reason')?.textContent ?? null;

beforeEach(() => {
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [node('n1'), node('t1', 'text-input')], edges: [], runHistory: [] });
  vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the socket's validationError event", () => {
  it("puts the person's line beside the agents' text", () => {
    send({ type: 'validationError', errors: [{ nodeId: 'n1', portId: '', message: KEY, person: KEY_LINE }] });
    expect(data('n1')).toMatchObject({ state: 'error', error: KEY, errorPerson: KEY_LINE });
    expect(data('n1').errorCategory).toBeUndefined();
  });

  it('reads several checks on one node together, as a reload does', () => {
    send({ type: 'validationError', errors: [
      { nodeId: 'n1', portId: 'prompt', message: PORT, person: PORT_LINE },
      { nodeId: 'n1', portId: '', message: KEY, person: KEY_LINE },
    ] });
    // node_errors joins the same way, so the card reads the same after a reload.
    expect(data('n1')).toMatchObject({ error: `${PORT}; ${KEY}`, errorPerson: `${PORT_LINE} ${KEY_LINE}` });
  });

  it("a check with no line reads GM's general line, with its text behind Details", () => {
    send({ type: 'validationError', errors: [{ nodeId: 'n1', portId: '', message: "Duplicate node id 'n1' makes edge endpoints ambiguous" }] });
    expect(data('n1').errorPerson).toBeUndefined();
    expect(data('n1').errorCategory).toBe('unknown');
  });
});

describe("the run call's own validation answer", () => {
  it("marks the node with the person's line, and the others in the run with a written line", async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'validation_error', errors: [
      { nodeId: 'n1', portId: 'prompt', message: PORT, person: PORT_LINE },
      { nodeId: 'n1', portId: '', message: KEY, person: KEY_LINE },
    ] } as never);
    await useGraphStore.getState().executeGraph();
    expect(data('n1')).toMatchObject({ state: 'error', error: `${PORT}; ${KEY}`, errorPerson: `${PORT_LINE} ${KEY_LINE}` });
    // A node with nothing wrong of its own: no "Validation failed" on its card.
    expect(data('t1')).toMatchObject({ state: 'error', errorPerson: OTHER_NODE });
    expect(String(data('t1').error)).not.toMatch(/Validation failed|execution/i);
  });

  it('says a written line when the answer names no node', async () => {
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'validation_error' } as never);
    await useGraphStore.getState().executeNode('n1');
    expect(data('n1').errorPerson).toBe('Nothing ran. Check the inputs and API keys, then run the node again.');
    expect(String(data('n1').error)).not.toMatch(/Validation failed|execution/i);
  });
});

describe('a refused run for a missing key: the socket frame and the run call agree in either order', () => {
  const keyed = [{ nodeId: 'n1', portId: '', message: KEY, person: KEY_LINE, missingKey: true }];

  it('the frame first, then the run call', async () => {
    send({ type: 'validationError', errors: keyed });
    expect(data('n1').errorMissingKey).toBe(true);
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'validation_error', errors: keyed } as never);
    await useGraphStore.getState().executeNode('n1');
    expect(data('n1')).toMatchObject({ state: 'error', errorPerson: KEY_LINE, errorMissingKey: true });
  });

  it('the run call first, then the frame', async () => {
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'validation_error', errors: keyed } as never);
    await useGraphStore.getState().executeNode('n1');
    expect(data('n1').errorMissingKey).toBe(true);
    send({ type: 'validationError', errors: keyed });
    expect(data('n1')).toMatchObject({ state: 'error', errorPerson: KEY_LINE, errorMissingKey: true });
  });

  it('an unkeyed check on the same node reads as a failure in both', () => {
    send({ type: 'validationError', errors: [{ nodeId: 'n1', portId: 'prompt', message: PORT, person: PORT_LINE }] });
    expect(data('n1').errorMissingKey).toBeUndefined();
  });
});

describe('the Create Studio result card (LOW-3)', () => {
  const output = (missing: boolean) => render(<OutputRenderer outputs={{}} state="error" error={KEY} errorPerson={KEY_LINE}
    errorNotStarted errorMissingKey={missing} />);

  it('draws a missing key neutral, as the canvas card does', () => {
    const { container } = output(true);
    expect(container.querySelector('.create-output--error--key')).not.toBeNull();
    expect(reason(container)).toBe(`Nebula couldn’t start the run. ${KEY_LINE}`);
  });

  it('draws any other refusal as a failure', () => {
    expect(output(false).container.querySelector('.create-output--error--key')).toBeNull();
  });
});

describe('the card', () => {
  const card =(patch: Partial<NodeData>) => ({ id: 'n1', selected: false, data: { ...node('n1').data, state: 'error', ...patch } }) as unknown as NodeProps;

  it("shows the heading over the person's line and no keys", () => {
    const { container } = render(<ModelNode {...card({ error: KEY, errorPerson: KEY_LINE })} />);
    expect(reason(container)).toMatch(/^Nebula couldn’t run the node/);
    expect(reason(container)).toBe(`Nebula couldn’t run the node. ${KEY_LINE}`);
    expect(container.textContent).not.toContain('OPENAI_API_KEY');
  });

  it("shows GM's general line over a closed Details for a check with no line", () => {
    const { container } = render(<ModelNode {...card({ error: "Duplicate node id 'n1'", errorCategory: 'unknown' })} />);
    expect(reason(container)).toBe(GENERAL);
    expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(false);
  });
});

describe('the Batch card over its cap', () => {
  const batch = (patch: Partial<NodeData>) => ({ id: 'b1', selected: false, data: { label: 'Batch', definitionId: 'batch',
    params: { items_text: 'one\ntwo\nthree', batch_size_cap: 2 }, state: 'idle', outputs: {}, ...patch } }) as unknown as NodeProps;

  it('says the cap once when the run stopped on it', () => {
    const { container } = render(<BatchNode {...batch({ state: 'error', error: OVER_CAP, errorPerson: OVER_CAP_LINE })} />);
    expect(reason(container)).toMatch(/^Nebula couldn’t run the node/);
    expect(reason(container)).toBe(`Nebula couldn’t run the node because ${OVER_CAP_LINE.replace('This Batch', 'this Batch')}`);
    expect(container.textContent).not.toContain('exceed the cap');
    expect(container.textContent).not.toContain('batch_size_cap');
  });

  it('draws a missing key neutral, as the canvas card does (LOW-3)', () => {
    const keyed = render(<BatchNode {...batch({ state: 'error', error: KEY, errorPerson: KEY_LINE, errorNotStarted: true, errorMissingKey: true })} />);
    expect(keyed.container.querySelector('.batch-node__warning--key')).not.toBeNull();
    keyed.unmount();
    const plain = render(<BatchNode {...batch({ state: 'error', error: KEY, errorPerson: KEY_LINE, errorNotStarted: true })} />);
    expect(plain.container.querySelector('.batch-node__warning--key')).toBeNull();
  });

  it('keeps its own cap warning while editing, before any run', () => {
    const { container } = render(<BatchNode {...batch({})} />);
    expect(reason(container)).toBeNull();
    expect(container.textContent).toContain('3 items exceed the cap of 2.');
  });

  it('keeps its own warning beside a run error about something else', () => {
    const { container } = render(<BatchNode {...batch({ state: 'error', error: 'boom', errorCategory: 'unknown' })} />);
    expect(reason(container)).toMatch(/^Nebula couldn’t run the node/);
    expect(container.textContent).toContain('3 items exceed the cap of 2.');
  });
});
