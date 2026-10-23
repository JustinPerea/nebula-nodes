/**
 * Error copy round 3c (GM - Design): a node's run error, for the person.
 *
 * GM, on the World nodes: "the person reads these on the node, so their
 * lines shouldn't carry ids or record names. ... The node's error stores the
 * specific text for agents (and the run record and MCP keep it), and the
 * canvas shows the written line."
 *
 * GM's guard for every other node: "On a node with no written line yet,
 * show "Couldn't run the node." with the general line, and put the raw
 * provider text behind the same collapsed "Details" toggle used for Commons
 * analysis."
 *
 * Before 3c the card showed the classifier's line or, for anything it
 * couldn't name, the raw text itself as the line, with no heading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react';
import { NodeError } from '../../src/components/nodes/NodeError';
import { ErrorDetails } from '../../src/components/failure/ErrorDetails';
import { nodeErrorCopy } from '../../src/lib/nodeErrorCopy';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { OutputRenderer } from '../../src/components/create-studio/OutputRenderer';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import type { NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

const HEADING = "Couldn't run the node.";
const GENERAL = "That didn't work. Try again, or reload if it keeps happening.";
const SPECIFIC = 'World Labs generation/recovery was already accepted or is being recovered (operationId=op-77), '
  + 'but Nebula could not finish locally. Recover with resume_operation_id=op-77; cause: boom';
const PERSON = 'World Labs accepted this run, and it may be billed, but Nebula couldn\'t finish it here. Check the job '
  + 'in Marble. The node\'s Resume Operation ID field keeps the job, so running the node again picks it up without paying twice.';
const RAW = 'fal.ai: {"detail":[{"msg":"image too small","type":"value_error"}]} request_id=req_123';

const heading = (root: ParentNode) => root.querySelector('.failure-lines__heading')?.textContent ?? null;
const reason = (root: ParentNode) => root.querySelector('.failure-lines__reason')?.textContent ?? null;

describe('NodeError', () => {
  afterEach(cleanup);

  it("shows the person's line under the heading, and never the specific text", () => {
    const { container } = render(<NodeError raw={SPECIFIC} person={PERSON} category="unknown" friendly={SPECIFIC.slice(0, 140)} />);
    expect(heading(container)).toBe(HEADING);
    expect(reason(container)).toBe(PERSON);
    expect(container.textContent).not.toContain('op-77');
    expect(container.textContent).not.toContain('resume_operation_id');
    expect(container.querySelector('details')).toBeNull();
  });

  it("with no written line: GM's general line, and the raw text only behind a closed Details", () => {
    const { container } = render(<NodeError raw={RAW} category="unknown" friendly={RAW.slice(0, 140)} />);
    expect(heading(container)).toBe(HEADING);
    expect(reason(container)).toBe(GENERAL);
    const details = container.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toBe('Details');
    expect(details.textContent).toContain(RAW);
    // On a React Flow card: no drag from the toggle, and the raw text scrolls in place.
    expect(details.classList.contains('nodrag')).toBe(true);
    expect(details.classList.contains('nowheel')).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
  });

  it("a classified failure keeps its line (the fact the person needs) under the heading, the raw text behind Details", () => {
    const friendly = "This request was blocked by the provider's safety filter. Try rephrasing your prompt or removing flagged content.";
    const { container } = render(<NodeError raw="400 moderation_blocked: prompt flagged" category="blocked" friendly={friendly} />);
    expect(heading(container)).toBe(HEADING);
    expect(reason(container)).toBe(friendly);
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('details')?.textContent).toContain('400 moderation_blocked: prompt flagged');
  });

  it("a line Nebula wrote itself (a refused start, a pre-run check) shows as it is", () => {
    const line = "Couldn't start the run. Nebula didn't respond. Try again.";
    const { container } = render(<NodeError raw={line} />);
    expect(container.textContent).toBe(line);
    expect(container.querySelector('details')).toBeNull();
  });

  it('a new failure starts with Details closed again', () => {
    const { container, rerender } = render(<NodeError raw={RAW} category="unknown" />);
    fireEvent.click(container.querySelector('summary')!);
    expect(container.querySelector('details')!.open).toBe(true);
    rerender(<NodeError raw="HTTP 502 from provider" category="unknown" />);
    expect(container.querySelector('details')!.open).toBe(false);
    expect(container.querySelector('details')!.textContent).toContain('HTTP 502 from provider');
  });

  it('the Details toggle is the one Commons analysis uses', () => {
    const { container } = render(<NodeError raw={RAW} category="unknown" />);
    expect(container.querySelector('details')?.classList.contains('error-details')).toBe(true);
    expect(container.querySelector('.error-details__raw')?.textContent).toBe(RAW);
  });
});

describe('the canvas card', () => {
  let previousGraph: ReturnType<typeof useGraphStore.getState>;
  let previousUi: ReturnType<typeof useUIStore.getState>;
  beforeEach(() => {
    previousGraph = useGraphStore.getState();
    previousUi = useUIStore.getState();
    useUIStore.setState({ skin: 'slava-restraint' });
  });
  afterEach(() => {
    cleanup();
    useGraphStore.setState(previousGraph, true);
    useUIStore.setState(previousUi, true);
  });

  function card(data: Partial<NodeData>) {
    const node: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'worldlabs-environment', label: 'World', params: {}, state: 'error', outputs: {}, ...data } };
    useGraphStore.setState({ nodes: [node], edges: [] });
    return render(<ModelNode {...({ id: 'n1', data: node.data, selected: false } as NodeProps)} />);
  }

  it("a World node's card shows the person's line, never the ids its error keeps for agents", () => {
    const { container } = card({ error: SPECIFIC, errorPerson: PERSON, errorCategory: 'unknown' });
    const shown = container.querySelector('.model-node__error')!;
    expect(heading(shown)).toBe(HEADING);
    expect(reason(shown)).toBe(PERSON);
    expect(container.textContent).not.toContain('operationId=op-77');
    expect(screen.queryByText(/resume_operation_id/)).toBeNull();
  });

  it("another node's provider failure shows the fallback with a closed Details", () => {
    const { container } = card({ definitionId: 'gpt-image-1-generate', error: RAW, errorCategory: 'unknown',
      errorFriendly: RAW.slice(0, 140) });
    const shown = container.querySelector('.model-node__error')!;
    expect(heading(shown)).toBe(HEADING);
    expect(reason(shown)).toBe(GENERAL);
    expect(shown.querySelector('details')?.open).toBe(false);
  });
});

describe('Create Studio results (the same node data)', () => {
  afterEach(cleanup);

  it('says the same lines as the card', () => {
    const { container, rerender } = render(<OutputRenderer state="error" outputs={{}} error={SPECIFIC}
      errorPerson={PERSON} errorCategory="unknown" />);
    expect(heading(container)).toBe(HEADING);
    expect(reason(container)).toBe(PERSON);
    expect(container.textContent).not.toContain('op-77');
    rerender(<OutputRenderer state="error" outputs={{}} error={RAW} errorCategory="unknown" errorFriendly={RAW} />);
    expect(reason(container)).toBe(GENERAL);
    expect(container.querySelector('details')?.open).toBe(false);
  });
});

describe('review: the Details toggle on the canvas, and a named failure after a reload', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // The canvas pans on Space (lib/canvasNavigation.ts), and React Flow's
  // window-wide key listener cancels Space on anything that isn't a button,
  // a link or an input, unless it sits inside `.nokey`. A cancelled keydown
  // stops a <summary> from toggling, so Space never opened Details.
  function pressSpace(target: Element) {
    const down = fireEvent.keyDown(target, { key: ' ', code: 'Space', keyCode: 32 });
    fireEvent.keyUp(target, { key: ' ', code: 'Space', keyCode: 32 });
    return down;
  }

  it.each([
    ['a node card', (raw: string) => <NodeError raw={raw} category="unknown" />],
    ['Commons analysis', (raw: string) => <ErrorDetails raw={raw} />],
  ])("Space reaches %s's Details summary while the canvas is mounted", (_where, details) => {
    const { container } = render(
      <ReactFlowProvider>
        <div style={{ width: 400, height: 300 }}>
          <ReactFlow nodes={[]} edges={[]} panActivationKeyCode="Space" />
        </div>
        {details(RAW)}
      </ReactFlowProvider>,
    );
    const summary = container.querySelector('details.error-details > summary')!;
    expect(summary).not.toBeNull();
    expect(pressSpace(summary)).toBe(true); // not cancelled, so the browser toggles it
    expect(summary.closest('.nokey')).not.toBeNull();
  });

  it("a capability guardrail reads the same live and after a reload", () => {
    const raw = 'Gemini Omni capability guardrail: use Veo 3.1 for video extension.';
    // Live: the ws event's friendly line is the raw text itself.
    const live = nodeErrorCopy({ raw, category: 'invalid_input', friendly: raw });
    // Reload: node_errors dropped the hint that equalled the error, so graphSync has no friendly line.
    const reloaded = nodeErrorCopy({ raw, category: 'invalid_input', friendly: undefined });
    expect(live).toEqual({ heading: HEADING, reason: raw, details: null });
    expect(reloaded).toEqual(live);
    const { container } = render(<NodeError raw={raw} category="invalid_input" />);
    expect(reason(container)).toBe(raw);
    expect(container.querySelector('details')).toBeNull();
  });

  it('an unknown failure with no stored line still falls back to the general line', () => {
    expect(nodeErrorCopy({ raw: RAW, category: 'unknown' })).toEqual({ heading: HEADING, reason: GENERAL, details: RAW });
  });
});
