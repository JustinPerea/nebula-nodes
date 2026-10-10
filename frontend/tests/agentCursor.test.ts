import { beforeEach, describe, expect, it } from 'vitest';
import type { InternalNode, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import {
  AGENT_CURSOR_SPRING,
  isAtRest,
  resolveAnchor,
  stepSpring,
  type SpringState,
} from '../src/lib/agentCursorMotion';
import { buildCanvasViewReport } from '../src/lib/canvasView';
import { AGENT_CURSOR_EXPIRE_MS, useAgentPresenceStore } from '../src/store/agentPresenceStore';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

type Lookup = Map<string, InternalNode<Node<NodeData>>>;

function internalNode(id: string, x: number, y: number, extra: Record<string, unknown> = {}): InternalNode<Node<NodeData>> {
  return {
    id,
    position: { x, y },
    data: { state: 'idle' } as unknown as NodeData,
    measured: { width: 200, height: 120 },
    internals: {
      positionAbsolute: { x, y },
      z: 0,
      userNode: {} as Node<NodeData>,
      handleBounds: {
        source: [{ id: 'image', x: 194, y: 50, width: 12, height: 12, position: 'right', type: 'source' }],
        target: [{ id: 'prompt', x: -6, y: 40, width: 12, height: 12, position: 'left', type: 'target' }],
      },
    },
    ...extra,
  } as unknown as InternalNode<Node<NodeData>>;
}

function presenceEvent(overrides: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent {
  return {
    type: 'agentPresence',
    agent: { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false },
    target: { nodeId: 'n1' },
    action: 'click',
    say: 'Added Text Input',
    at: 0,
    ...overrides,
  };
}

describe('agent cursor spring', () => {
  it('settles on the target with a small overshoot, not a linear slide', () => {
    let state: SpringState = { x: 0, y: 0, vx: 0, vy: 0 };
    const target = { x: 300, y: 0 };
    let peak = 0;
    let frames = 0;
    while (!isAtRest(state, target) && frames < 600) {
      state = stepSpring(state, target, 1 / 60, AGENT_CURSOR_SPRING);
      peak = Math.max(peak, state.x);
      frames += 1;
    }
    expect(isAtRest(state, target)).toBe(true);
    expect(frames).toBeLessThan(36); // under 0.6 s
    expect(peak).toBeGreaterThan(303); // a readable settle
    expect(peak).toBeLessThan(312); // but no wobble
  });

  it('stays stable across a long frame gap (backgrounded tab)', () => {
    const state = stepSpring({ x: 0, y: 0, vx: 0, vy: 0 }, { x: 100, y: 100 }, 5, AGENT_CURSOR_SPRING);
    expect(Number.isFinite(state.x)).toBe(true);
    expect(Math.abs(state.x - 100)).toBeLessThan(1);
  });
});

describe('resolveAnchor', () => {
  const lookup: Lookup = new Map([['n1', internalNode('n1', 100, 50)]]);

  it('points at a port centre, the node header, or raw flow coordinates', () => {
    expect(resolveAnchor({ nodeId: 'n1', handle: 'prompt' }, lookup)).toEqual({ x: 100, y: 96 });
    expect(resolveAnchor({ nodeId: 'n1', handle: 'image' }, lookup)).toEqual({ x: 300, y: 106 });
    expect(resolveAnchor({ nodeId: 'n1' }, lookup)).toEqual({ x: 200, y: 94 });
    expect(resolveAnchor({ nodeId: 'n1', handle: 'missing' }, lookup)).toEqual({ x: 200, y: 94 });
    expect(resolveAnchor({ x: -4, y: 9 }, lookup)).toEqual({ x: -4, y: 9 });
  });

  it('returns null for a node the canvas has not drawn yet', () => {
    expect(resolveAnchor({ nodeId: 'n9' }, lookup)).toBeNull();
  });
});

describe('agent presence store', () => {
  beforeEach(() => useAgentPresenceStore.getState().clear());

  it('keeps one cursor per agent and counts events so gestures can replay', () => {
    const { apply } = useAgentPresenceStore.getState();
    apply(presenceEvent(), 1_000);
    apply(presenceEvent({ target: { nodeId: 'n2', handle: 'prompt' }, from: { nodeId: 'n1', handle: 'text' }, action: 'drag' }), 2_000);
    const cursor = useAgentPresenceStore.getState().agents['ext:claude-code'];
    expect(cursor.seq).toBe(2);
    expect(cursor.target).toEqual({ nodeId: 'n2', handle: 'prompt' });
    expect(cursor.from).toEqual({ nodeId: 'n1', handle: 'text' });
  });

  it('ignores malformed events and unsafe colours', () => {
    const { apply } = useAgentPresenceStore.getState();
    apply(presenceEvent({ target: { x: Number.NaN, y: 0 } }));
    expect(useAgentPresenceStore.getState().agents).toEqual({});
    apply(presenceEvent({ agent: { id: 'a', name: 'A', color: 'red;background:url(x)', verified: false } }));
    expect(useAgentPresenceStore.getState().agents.a.color).toBe('#E8825A');
  });

  it('forgets node anchors when the graph is cleared or replaced', () => {
    const { apply, forgetGraph } = useAgentPresenceStore.getState();
    apply(presenceEvent(), 1_000);
    apply(presenceEvent({ agent: { id: 'b', name: 'B', color: '#5B9DFF', verified: true }, target: { x: 4, y: 5 }, from: { nodeId: 'n1' }, action: 'drag' }), 1_000);
    forgetGraph();
    const { agents } = useAgentPresenceStore.getState();
    expect(Object.keys(agents)).toEqual(['b']);
    expect(agents.b.from).toBeUndefined();
  });

  it('drops cursors that have been quiet past the expiry', () => {
    const { apply, prune } = useAgentPresenceStore.getState();
    apply(presenceEvent(), 1_000);
    prune(1_000 + AGENT_CURSOR_EXPIRE_MS - 1);
    expect(Object.keys(useAgentPresenceStore.getState().agents)).toHaveLength(1);
    prune(1_000 + AGENT_CURSOR_EXPIRE_MS);
    expect(useAgentPresenceStore.getState().agents).toEqual({});
  });
});

describe('canvas view report', () => {
  it('reports viewport, screen and node bounds and states in flow coordinates', () => {
    const lookup: Lookup = new Map([
      ['n1', internalNode('n1', 10.04, 20)],
      ['n2', internalNode('n2', 400, 0, { hidden: true })],
      ['n3', internalNode('n3', 0, 0, { measured: undefined, data: { state: 'melting' } })],
    ]);
    const report = buildCanvasViewReport([-120.33, 40, 0.8456], { width: 1280.4, height: 720 }, lookup);
    expect(report.viewport).toEqual({ x: -120.3, y: 40, zoom: 0.846 });
    expect(report.screen).toEqual({ width: 1280, height: 720 });
    expect(report.nodes).toEqual([
      { id: 'n1', x: 10, y: 20, width: 200, height: 120, state: 'idle' },
      { id: 'n3', x: 0, y: 0 },
    ]);
  });
});
