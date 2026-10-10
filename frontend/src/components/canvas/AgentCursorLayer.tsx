import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, useStoreApi, ViewportPortal, type Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import {
  AGENT_CURSOR_IDLE_MS,
  AGENT_SAY_MS,
  useAgentPresenceStore,
  type AgentCursor,
} from '../../store/agentPresenceStore';
import {
  AGENT_CURSOR_SPRING,
  AGENT_DRAG_SPRING,
  isAtRest,
  resolveAnchor,
  stepSpring,
  type Point,
  type SpringState,
} from '../../lib/agentCursorMotion';
import '../../styles/agentCursor.css';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

type Phase = 'pickup' | 'travel' | 'rest';

function AgentCursorView({ cursor, zoom }: { cursor: AgentCursor; zoom: number }) {
  const store = useStoreApi<Node<NodeData>>();
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const wireRef = useRef<SVGLineElement | null>(null);
  const spring = useRef<SpringState | null>(null);
  const phase = useRef<Phase>('rest');
  const zoomRef = useRef(zoom);
  const frame = useRef<number | null>(null);
  const lastTime = useRef<number | null>(null);
  const wake = useRef<() => void>(() => {});
  const [arrivedSeq, setArrivedSeq] = useState(0);
  // Each holds the event seq whose timer ran out, so a new event resets both.
  const [sayDoneSeq, setSayDoneSeq] = useState(0);
  const [idleSeq, setIdleSeq] = useState(0);
  const showSay = Boolean(cursor.say) && sayDoneSeq !== cursor.seq;
  const idle = idleSeq === cursor.seq;

  const dragging = cursor.action === 'drag' && cursor.from !== undefined;

  // Narration and idle dimming follow each new event.
  useEffect(() => {
    const seq = cursor.seq;
    const sayTimer = window.setTimeout(() => setSayDoneSeq(seq), AGENT_SAY_MS);
    const idleTimer = window.setTimeout(() => setIdleSeq(seq), AGENT_CURSOR_IDLE_MS);
    return () => {
      window.clearTimeout(sayTimer);
      window.clearTimeout(idleTimer);
    };
  }, [cursor.seq]);

  useLayoutEffect(() => {
    const reduced = prefersReducedMotion();
    const apply = () => {
      const el = cursorRef.current;
      const state = spring.current;
      if (!el || !state) return;
      el.style.transform = `translate(${state.x}px, ${state.y}px) scale(${1 / zoomRef.current})`;
      // Set outside React so a re-render never hides a placed cursor again.
      el.dataset.placed = 'true';
    };
    const updateWire = (start: Point | null) => {
      const line = wireRef.current;
      const state = spring.current;
      if (!line) return;
      if (!start || !state || phase.current !== 'travel' || !dragging) {
        line.style.opacity = '0';
        return;
      }
      line.setAttribute('x1', String(start.x));
      line.setAttribute('y1', String(start.y));
      line.setAttribute('x2', String(state.x));
      line.setAttribute('y2', String(state.y));
      line.style.strokeWidth = String(2 / zoomRef.current);
      line.style.opacity = '1';
    };

    const tick = (time: number) => {
      frame.current = null;
      const lookup = store.getState().nodeLookup;
      const target = resolveAnchor(cursor.target, lookup);
      const start = dragging && cursor.from ? resolveAnchor(cursor.from, lookup) : null;
      if (!target) return; // Node not drawn yet; the store subscription wakes us.

      if (!spring.current) {
        // First sighting: enter from just up-left of where the gesture begins.
        const origin = start ?? target;
        spring.current = reduced
          ? { ...target, vx: 0, vy: 0 }
          : { x: origin.x - 36, y: origin.y - 28, vx: 0, vy: 0 };
      }
      const goal = phase.current === 'pickup' && start ? start : target;
      const dt = lastTime.current === null ? 1 / 60 : (time - lastTime.current) / 1000;
      lastTime.current = time;

      if (reduced) {
        spring.current = { ...target, vx: 0, vy: 0 };
        phase.current = 'rest';
      } else {
        const config = phase.current === 'travel' && dragging ? AGENT_DRAG_SPRING : AGENT_CURSOR_SPRING;
        spring.current = stepSpring(spring.current, goal, dt, config);
        if (phase.current === 'pickup' && Math.hypot(spring.current.x - goal.x, spring.current.y - goal.y) < 4) {
          phase.current = 'travel';
        }
      }
      apply();
      updateWire(start);

      if (phase.current !== 'pickup' && isAtRest(spring.current, target)) {
        if (phase.current === 'travel') {
          phase.current = 'rest';
          setArrivedSeq(cursor.seq);
          updateWire(null);
        }
        lastTime.current = null;
        return; // At rest: sleep until the canvas changes.
      }
      frame.current = requestAnimationFrame(tick);
    };

    wake.current = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
    };

    phase.current = dragging && !reduced ? 'pickup' : 'travel';
    lastTime.current = null;
    wake.current();
    // Nodes move, resize, or appear after a graph sync: follow them.
    const unsubscribe = store.subscribe(() => wake.current());
    return () => {
      unsubscribe();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [cursor.seq, cursor.target, cursor.from, dragging, store]);

  useEffect(() => {
    zoomRef.current = zoom;
    const el = cursorRef.current;
    const state = spring.current;
    if (el && state) el.style.transform = `translate(${state.x}px, ${state.y}px) scale(${1 / zoom})`;
  }, [zoom]);

  const gesture = cursor.action === 'click' || cursor.action === 'drag';
  return (
    <>
      <svg className="agent-cursor__wire-layer" aria-hidden="true">
        <line ref={wireRef} className="agent-cursor__wire" stroke={cursor.color} />
      </svg>
      <div
        ref={cursorRef}
        className={`agent-cursor${idle ? ' agent-cursor--idle' : ''}`}
        style={{ ['--agent-color' as string]: cursor.color }}
        data-agent={cursor.id}
        role="status"
        aria-label={`${cursor.name}${cursor.say ? `: ${cursor.say}` : ''}`}
      >
        {gesture && arrivedSeq === cursor.seq && !prefersReducedMotion() && (
          <span key={cursor.seq} className="agent-cursor__ripple" />
        )}
        <svg className="agent-cursor__pointer" width="20" height="22" viewBox="0 0 20 22" aria-hidden="true">
          <path d="M1.5 1.5 L1.5 17.5 L6 13.3 L9.1 20.1 L11.9 18.9 L8.9 12.3 L14.7 12.1 Z" />
        </svg>
        <div className="agent-cursor__label">
          <span className="agent-cursor__name">{cursor.name}</span>
          {showSay && !idle && <span className="agent-cursor__say">{cursor.say}</span>}
        </div>
      </div>
    </>
  );
}

const PRUNE_INTERVAL_MS = 5_000;

/** Live cursors for agents working on the canvas, drawn in flow coordinates. */
export function AgentCursorLayer() {
  const agents = useAgentPresenceStore((s) => s.agents);
  const prune = useAgentPresenceStore((s) => s.prune);
  const zoom = useStore((s) => s.transform[2]);

  useEffect(() => {
    const timer = window.setInterval(() => prune(), PRUNE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [prune]);

  const cursors = Object.values(agents);
  if (cursors.length === 0) return null;
  return (
    <ViewportPortal>
      <div className="agent-cursor-layer">
        {cursors.map((cursor) => (
          <AgentCursorView key={cursor.id} cursor={cursor} zoom={zoom} />
        ))}
      </div>
    </ViewportPortal>
  );
}
