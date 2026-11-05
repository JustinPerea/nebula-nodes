import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import { ModelNode } from '../src/components/nodes/ModelNode';
import { DynamicNode } from '../src/components/nodes/DynamicNode';
import { WAITING_FOR_OK } from '../src/lib/canvasProposals';
import { springLinear, SPRING_SOFT } from '../src/lib/springs';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { useGraphStore } from '../src/store/graphStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useUIStore } from '../src/store/uiStore';
import type { ProposalView, ProposalWait } from '../src/lib/wsClient';
import type { NodeData } from '../src/types';

/**
 * A run the daily total holds, PR #212 round 3 (GM - Design's round 2 item 1):
 * the waiting state lives in the node card's header and the node never changes
 * size. The tint, the label that replaces the model chip, the accessible
 * description, and the crossfade on the spring.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

const css = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8');
function rule(file: string, selector: string): string {
  const source = css(file);
  const at = source.indexOf(`${selector} {`);
  expect(at, `${selector} in ${file}`).toBeGreaterThanOrEqual(0);
  return source.slice(source.indexOf('{', at) + 1, source.indexOf('}', at));
}

const BAR = 'This would pass the $5 daily total, which has $0.20 left.';
const BAR_TWO = '“Writer” has no list price, so Nebula can’t count it toward the $5 daily total.';
const wait = (nodeIds: string[], barLine = BAR): ProposalWait => ({
  limitUsd: 5, usedUsd: 4.8, leftUsd: 0.2, runUsd: 0.4, also: null, alsoLimitUsd: null, alsoModel: null,
  alsoFor: null, alsoPlanRuns: null, barLine, nodeIds, names: nodeIds,
});
const view = (id: string, nodeIds: string[], agent: { name: string; color: string }, createdAt: number,
  barLine = BAR): ProposalView => ({
  id, status: 'open', agent: { id: `ext:${agent.name}`, name: agent.name, color: agent.color, verified: false },
  note: barLine, projectId: 'p', createdAt, expiresAt: Date.now() + 600_000,
  nodes: [], edges: [], params: [], run: nodeIds,
  cost: { paidRuns: 1, freeRuns: 0, estimate: 0.4, upTo: false, providers: ['openai'], nodes: [], note: '' },
  references: nodeIds, reason: null, idMap: null, runNodeIds: null, wait: wait(nodeIds, barLine),
});
const CLAUDE = { name: 'Claude Code', color: '#c7f36b' };
const CODEX = { name: 'Codex', color: '#5b9dff' };

let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;

function noMotionPreference(reduced: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query.includes('reduce'), addEventListener() {}, removeEventListener() {},
  }));
}

beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  useUIStore.setState({ skin: 'slava-restraint' });
  usePricingStore.setState({ table: { nodes: {} } as never, loading: false });
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  noMotionPreference(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
  usePricingStore.setState({ table: null, loading: false });
});

/** FLUX.2 has a provider chip (the model chip); Fixture text has none. */
function card(id = 'n1', definitionId = 'flux-2-pro', label = 'FLUX.2') {
  const node: Node<NodeData> = { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label, params: {}, state: 'idle', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [] });
  return render(<ModelNode {...({ id, data: node.data, selected: false } as NodeProps)} />);
}
const header = (container: HTMLElement) => container.querySelector<HTMLElement>('.model-node__header')!;
const label = (container: HTMLElement) => container.querySelector<HTMLElement>('.node-wait-swap__label');
const open = (...views: ProposalView[]) => act(() => {
  for (const v of views) useCanvasProposalsStore.getState().open(v, 'key');
});

describe('the waiting state in the node card\'s header', () => {
  it('tints the header and says "Waiting for your OK" where the model chip was', () => {
    const { container } = card();
    expect(header(container).dataset.waiting).toBeUndefined();
    expect(label(container)).toBeNull();
    open(view('p_one', ['n1'], CLAUDE, 1));
    expect(header(container).dataset.waiting).toBe('true');
    expect(header(container).style.getPropertyValue('--agent-color')).toBe(CLAUDE.color);
    expect(label(container)!.textContent).toBe(WAITING_FOR_OK);
    expect(WAITING_FOR_OK).toBe('Waiting for your OK');
    // The model chip is still there (inert, faded), in the same cell.
    const swap = container.querySelector('.node-wait-swap')!;
    const rest = swap.querySelector<HTMLElement>('.node-wait-swap__rest')!;
    expect(rest.querySelector('.model-node__provider-chip')).not.toBeNull();
    expect(rest.hasAttribute('inert')).toBe(true);
    expect(header(container).contains(swap)).toBe(true);
    // A node no run waits on keeps its header as it was.
    cleanup();
    const other = card('n9');
    expect(header(other.container).dataset.waiting).toBeUndefined();
    expect(label(other.container)).toBeNull();
  });

  it('shows a count when several wait on the node', () => {
    const { container } = card();
    open(view('p_one', ['n1'], CLAUDE, 1), view('p_two', ['n1', 'n3'], CODEX, 2));
    expect(label(container)!.textContent).toBe(`${WAITING_FOR_OK} · 2`);
    // One label per node, whatever the count; the newest speaks for its colour.
    expect(container.querySelectorAll('.node-wait-swap__label')).toHaveLength(1);
    expect(header(container).style.getPropertyValue('--agent-color')).toBe(CODEX.color);
  });

  it('draws one on a node with no model chip too (Dynamic cards)', () => {
    const node: Node<NodeData> = { id: 'n4', type: 'dynamic-node', position: { x: 0, y: 0 },
      data: { definitionId: 'dynamic-nonexistent', label: 'Custom', params: {}, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [] });
    const { container } = render(<DynamicNode {...({ id: 'n4', data: node.data, selected: false } as NodeProps)} />);
    expect(container.querySelector('.node-wait-swap')).toBeNull();
    open(view('p_one', ['n4'], CLAUDE, 1));
    expect(header(container).dataset.waiting).toBe('true');
    expect(label(container)!.textContent).toBe(WAITING_FOR_OK);
  });

  it('never changes the node\'s size: nothing outside the header moves, the header gets no new row', () => {
    const { container } = card();
    const outside = () => [...container.querySelectorAll('.model-node__card > *')]
      .filter((el) => !el.classList.contains('model-node__header')).map((el) => el.outerHTML).join('');
    const headerKids = () => [...header(container).children].map((el) => el.tagName + '.' + el.className);
    const before = { outside: outside(), kids: headerKids() };
    open(view('p_one', ['n1'], CLAUDE, 1));
    expect(outside()).toBe(before.outside);
    expect(headerKids()).toEqual(before.kids);
    // The label and the chip share one grid cell: the label adds no width or height beside the chip.
    const swap = rule('node-wait.css', '.node-wait-swap');
    expect(swap).toMatch(/display:\s*inline-grid/);
    const layers = rule('node-wait.css', '.node-wait-swap > *');
    expect(layers).toMatch(/grid-area:\s*1\s*\/\s*1/);
    // It never sits above the card (the band did) and never takes a row of its own.
    expect(css('node-wait.css')).not.toMatch(/position:\s*(absolute|fixed)[^}]*\n[^}]*top:\s*-/);
  });

  it('keeps the label whole while the title truncates first', () => {
    const swap = rule('node-wait.css', '.node-wait-swap');
    expect(swap).toMatch(/flex:\s*0 0 auto/);                       // never shrinks
    const text = rule('node-wait.css', '.node-wait-swap__label');
    expect(text).toMatch(/white-space:\s*nowrap/);
    expect(text).not.toMatch(/overflow|text-overflow/);              // never cut
    const title = rule('nodes.css', '.model-node__label');
    expect(title).toMatch(/flex:\s*1/);
    expect(title).toMatch(/overflow:\s*hidden/);
    expect(title).toMatch(/text-overflow:\s*ellipsis/);              // the title gives way
  });

  it('gives the header the full reason as its accessible description, and nothing else on the node', () => {
    const { container } = card();
    open(view('p_one', ['n1'], CLAUDE, 1, BAR_TWO));
    const head = header(container);
    const id = head.getAttribute('aria-describedby')!;
    expect(document.getElementById(id)!.textContent).toBe(BAR_TWO);
    expect(head.getAttribute('role')).toBe('group');
    // Visually hidden: the reason isn't drawn on the node.
    expect(rule('node-wait.css', '.node-wait-swap__reason')).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(container.querySelector('.node-wait-band')).toBeNull();
    // The label itself is announced politely as the state starts.
    expect(label(container)!.getAttribute('role')).toBe('status');
    // With two proposals the description carries both reasons.
    open(view('p_two', ['n1'], CODEX, 2));
    expect(document.getElementById(header(container).getAttribute('aria-describedby')!)!.textContent)
      .toBe(`${BAR} ${BAR_TWO}`);
  });

  it('is gone when the proposal is decided: the label crossfades out and the chip comes back', () => {
    vi.useFakeTimers();
    const { container } = card();
    open(view('p_one', ['n1'], CLAUDE, 1));
    act(() => { vi.advanceTimersByTime(20); });
    const swap = () => container.querySelector<HTMLElement>('.node-wait-swap')!;
    expect(swap().dataset.on).toBe('true');
    // Accept or reject.
    act(() => useCanvasProposalsStore.setState({ proposals: {} }));
    expect(header(container).dataset.waiting).toBeUndefined();
    expect(header(container).hasAttribute('aria-describedby')).toBe(false);
    expect(swap().dataset.waiting).toBe('false');
    expect(swap().dataset.on).toBe('false');
    expect(swap().querySelector('.node-wait-swap__rest')!.hasAttribute('inert')).toBe(false);
    // The label stays mounted while it fades, then goes.
    act(() => { vi.advanceTimersByTime(springLinear(SPRING_SOFT).durationMs - 5); });
    expect(label(container)).not.toBeNull();
    act(() => { vi.advanceTimersByTime(10); });
    expect(label(container)).toBeNull();
    expect(swap().querySelector('.model-node__provider-chip')).not.toBeNull();
  });

  it('stops counting a proposal that is closing', () => {
    const { container } = card();
    open(view('p_one', ['n1'], CLAUDE, 1), view('p_two', ['n1'], CODEX, 2));
    expect(label(container)!.textContent).toBe(`${WAITING_FOR_OK} · 2`);
    act(() => useCanvasProposalsStore.setState((state) => ({
      proposals: { ...state.proposals, p_two: { ...state.proposals.p_two, closing: 'rejected' } },
    })));
    expect(label(container)!.textContent).toBe(WAITING_FOR_OK);
    expect(header(container).style.getPropertyValue('--agent-color')).toBe(CLAUDE.color);
  });

  it('crossfades on the springs, never stock easing', () => {
    const rest = rule('node-wait.css', '.node-wait-swap__rest');
    expect(rest).toMatch(/transition:\s*opacity var\(--spring-soft-ms\) var\(--spring-soft\)/);
    const text = rule('node-wait.css', '.node-wait-swap__label');
    expect(text).toMatch(/transition:\s*opacity var\(--spring-soft-ms\) var\(--spring-soft\)/);
    const on = rule('node-wait.css', ".node-wait-swap[data-on='true'] .node-wait-swap__label");
    expect(on).toMatch(/transition:\s*opacity var\(--spring-pop-ms\) var\(--spring-pop\)/);
    expect(rule('node-wait.css', "body.app-slava-restraint .model-node__header")).toMatch(
      /transition:\s*background-color var\(--spring-soft-ms/);
    expect(css('node-wait.css')).not.toMatch(/ease-in-out|ease-out|ease-in|\bease\b/);
  });

  it('turns on the next frame, so the opacity springs in', () => {
    vi.useFakeTimers();
    const { container } = card();
    open(view('p_one', ['n1'], CLAUDE, 1));
    expect(container.querySelector<HTMLElement>('.node-wait-swap')!.dataset.on).toBe('false');
    act(() => { vi.advanceTimersByTime(20); });
    expect(container.querySelector<HTMLElement>('.node-wait-swap')!.dataset.on).toBe('true');
  });

  it('changes at once under reduced motion, in both directions', () => {
    vi.useFakeTimers();
    noMotionPreference(true);
    const { container } = card();
    open(view('p_one', ['n1'], CLAUDE, 1));
    // No frame has run: it is on in the same render.
    expect(container.querySelector<HTMLElement>('.node-wait-swap')!.dataset.on).toBe('true');
    act(() => useCanvasProposalsStore.setState({ proposals: {} }));
    expect(container.querySelector<HTMLElement>('.node-wait-swap')!.dataset.on).toBe('false');
    act(() => { vi.advanceTimersByTime(1); });
    expect(label(container)).toBeNull();
    expect(css('node-wait.css')).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[^}]*\.node-wait-swap__rest,[^}]*\.node-wait-swap__label,[^}]*\{\s*transition: none;/);
  });

  it('leaves no band, overlay tag or pointer at the bar', () => {
    expect(() => readFileSync(join(__dirname, '../src/styles/node-wait-band.css'), 'utf8')).toThrow();
    expect(() => readFileSync(join(__dirname, '../src/components/nodes/NodeWaitBand.tsx'), 'utf8')).toThrow();
    const boundary = readFileSync(join(__dirname, '../src/components/nodes/withNodeCardBoundary.tsx'), 'utf8');
    expect(boundary).not.toMatch(/Wait/);
    expect(css('canvasProposals.css')).not.toContain('.proposal-wait');
    expect(useCanvasProposalsStore.getState()).not.toHaveProperty('shownId');
  });
});
