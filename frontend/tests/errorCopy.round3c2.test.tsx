/**
 * Error copy round 3c, part 2 (GM - Design): every place a node's run error
 * reaches the person reads it through nodeErrorCopy, as the node card does.
 * GM's guard: "provider run errors often carry the one fact the person needs
 * ... Don't let the general fallback hide them. On a node with no written
 * line yet, show "Couldn't run the node." with the general line, and put the
 * raw provider text behind the same collapsed "Details" toggle used for
 * Commons analysis."
 *
 * Before this part the Batch card printed `nodeData.error` raw, and the
 * Cinema shot panel printed the shot's error text (the classifier's cut of
 * the raw text) with no heading and no Details. The handoff to motion and
 * the next-step popup said "Could not …" (GM, round 2: never "Could not").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData } from '../src/types';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({ ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

import { BatchNode } from '../src/components/nodes/BatchNode';
import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCinemaMotionStore } from '../src/store/cinemaMotionStore';

const HEADING = "Couldn't run the node.";
// Round 3f (GM): "The Cinema shot panel heading: yes, "Couldn't generate the shot."".
const SHOT_HEADING = "Couldn't generate the shot.";
// Round 3f (GM): a card's general line, with no provider named. "Run the node
// again. If it keeps failing, Details shows what {Provider} said." when the run
// names one (tests/errorCopy.round3f.test.tsx).
const GENERAL = "Run the node again. If it keeps failing, open Details.";
const MASK = 'No mask painted yet — open the Mask Painter node and paint one';
const RAW = 'FAL submit failed (500): {"detail":"upstream exploded","request_id":"req_123"}';

const heading = (root: ParentNode) => root.querySelector('.failure-lines__heading')?.textContent ?? null;
const reason = (root: ParentNode) => root.querySelector('.failure-lines__reason')?.textContent ?? null;

const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };
afterEach(() => {
  cleanup();
  useCinemaMotionStore.getState().clear();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUi, true);
  mocks.fetch.mockReset();
});

// -- the Batch card ------------------------------------------------------------

function batch(patch: Partial<NodeData>): NodeProps {
  const data: NodeData = { definitionId: 'batch', label: 'Batch', params: { items_text: 'a\nb' }, state: 'error',
    outputs: {}, ...patch };
  return { id: 'b1', data, selected: false } as unknown as NodeProps;
}

describe('the Batch card reads its run error like every node card', () => {
  it("shows Nebula's own line under the heading, with no Details", () => {
    const { container } = render(<BatchNode {...batch({ error: MASK, errorCategory: 'unknown',
      errorFriendly: MASK, errorPerson: MASK })} />);
    expect(heading(container)).toBe(HEADING);
    expect(reason(container)).toBe(MASK);
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(MASK);
  });

  it("shows GM's general line over a closed Details for raw provider text", () => {
    const { container } = render(<BatchNode {...batch({ error: RAW, errorCategory: 'unknown',
      errorFriendly: RAW.slice(0, 140) })} />);
    expect(heading(container)).toBe(HEADING);
    expect(reason(container)).toBe(GENERAL);
    const details = container.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('req_123');
  });

  it('shows a line Nebula wrote before the run as it is', () => {
    const { container } = render(<BatchNode {...batch({ error: 'Batch has 30 items, exceeding its cap.' })} />);
    expect(heading(container)).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Batch has 30 items, exceeding its cap.');
    expect(container.querySelector('details')).toBeNull();
  });
});

// -- the Cinema shot panel ---------------------------------------------------------

function scene(output: NonNullable<CinemaSceneSpec['shots'][number]['output']>): CinemaSceneSpec {
  return { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{ id: 'a', prompt: 'Logo', output }] };
}
function shotPanel(output: NonNullable<CinemaSceneSpec['shots'][number]['output']>) {
  const spec = scene(output);
  const node: Node<NodeData> = { id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 }, data: { label: 'Scene',
    definitionId: 'cinema-scene', params: { scene: spec }, state: 'error', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [], isImportingGraph: false, isShotAdmissionBlocked: () => false });
  useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
  return render(<CinemaShotPanel cinemaNodeId="n1" scene={spec} shot={spec.shots[0]} onChangeShot={vi.fn()} />);
}

describe('the Cinema shot panel reads a failed shot like the node card', () => {
  it("shows the handler's line under the heading, with no Details", () => {
    const { container } = shotPanel({ status: 'error', error: MASK, errorCategory: 'unknown', errorPerson: MASK });
    const error = container.querySelector('.cinema-shot-panel__error')!;
    expect(heading(error)).toBe(SHOT_HEADING);
    expect(reason(error)).toBe(MASK);
    expect(error.querySelector('details')).toBeNull();
  });

  it("shows GM's general line with the full raw text behind a closed Details", () => {
    const { container } = shotPanel({ status: 'error', error: RAW.slice(0, 40), errorCategory: 'unknown',
      errorFriendly: RAW.slice(0, 40), errorRaw: RAW });
    const error = container.querySelector('.cinema-shot-panel__error')!;
    expect(heading(error)).toBe(SHOT_HEADING);
    // Round 3g (GM): the shot panel's own wording.
    expect(reason(error)).toBe('Generate the shot again. If it keeps failing, open Details.');
    const details = error.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('req_123');
  });

  it("shows the classifier's line for a failure it names", () => {
    const line = 'Rate limited by the provider. Wait a moment and run again.';
    const { container } = shotPanel({ status: 'error', error: line, errorCategory: 'rate_limit', errorFriendly: line,
      errorRaw: 'HTTP 429 Too Many Requests' });
    const error = container.querySelector('.cinema-shot-panel__error')!;
    expect(reason(error)).toBe(line);
    expect(error.querySelector('details')!.textContent).toContain('HTTP 429');
  });

  it("shows a line Nebula wrote for a shot that didn't start as it is", () => {
    const { container } = shotPanel({ status: 'error', error: 'Validation failed. Check inputs and API keys.' });
    const error = container.querySelector('.cinema-shot-panel__error')!;
    expect(heading(error)).toBeNull();
    expect(error.textContent).toBe('Validation failed. Check inputs and API keys.');
  });
});

// -- "Couldn't confirm …" beside Retry connection ----------------------------------

describe('the motion handoff says "Couldn\'t …" and leaves the retry to its button', () => {
  beforeEach(() => {
    useCinemaMotionStore.getState().clear();
  });

  async function send(reply: () => Promise<unknown>) {
    mocks.fetch.mockImplementationOnce(reply);
    shotPanel({ status: 'done', imageUrl: '/api/outputs/a.png' });
    // The panel reads the source node's outputs for the handoff.
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, data: { ...node.data,
      state: 'complete', outputs: { shot_a: { type: 'Image', value: '/api/outputs/a.png' } } } })) }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to motion' })); });
    return screen.findByRole('alert');
  }

  it('an unconfirmed reply', async () => {
    const alert = await send(async () => ({ ok: true, json: async () => null }));
    expect(alert.textContent).toBe("Couldn't confirm the video connection.");
    expect(screen.getByRole('button', { name: 'Retry connection' })).toBeEnabled();
  });

  it('a request with no answer', async () => {
    const alert = await send(async () => { throw new TypeError('Failed to fetch'); });
    // Round 3f (GM): "don't stack two "Couldn't"s, and Nebula is local".
    expect(alert.textContent).toBe("Couldn't confirm the video connection. Nebula didn't respond.");
  });

  it('a refused request', async () => {
    const alert = await send(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    expect(alert.textContent).toBe("Couldn't connect the video node. Nebula didn't respond.");
  });
});
