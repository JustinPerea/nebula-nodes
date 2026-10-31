import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, useStoreApi, ViewportPortal, type Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import {
  AGENT_CURSOR_IDLE_MS,
  AGENT_SAY_FADE_MS,
  AGENT_SAY_MS,
  useAgentPresenceStore,
  type AgentCursor,
} from '../../store/agentPresenceStore';
import type { AgentCursorAction } from '../../lib/wsClient';
import { resolveAnchor, type Point } from '../../lib/agentCursorMotion';
import {
  AGENT_CURSOR_FADE_SPRING,
  AGENT_CURSOR_IDLE_OPACITY,
  AGENT_CURSOR_MOVING_SPEED,
  createMotion,
  entranceStart,
  isMoving,
  planMove,
  stepMotion,
  type CursorMotion,
} from '../../lib/agentCursorPlanner';
import {
  AGENT_CURSOR_NAME_FIRST_SIGHT_MS,
  deStack,
  inkFor,
  labelLayout,
  nameVisible,
  paintOrder,
  sessionFill,
  sessionName,
} from '../../lib/agentCursorLook';
import { SPRING_SOFT, springFromStiffness, springLinear } from '../../lib/springs';
import '../../styles/agentCursor.css';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Until each action has its own look (GM's agent cursor spec, phase 2), an
 * action draws today's nearest visual: these ripple on arrival, a drag also
 * pulls its wire, and move, look and think draw nothing extra.
 */
const RIPPLE_ACTIONS: ReadonlySet<AgentCursorAction> = new Set(['click', 'drag', 'type', 'run', 'propose', 'wait', 'error']);

/** The CSS springs, sampled once (agentCursor.css reads them). */
let springVars: Record<`--${string}`, string> | null = null;
function cursorSpringVars(): Record<`--${string}`, string> {
  if (springVars) return springVars;
  const soft = springLinear(SPRING_SOFT);
  const ring = springLinear(springFromStiffness(AGENT_CURSOR_FADE_SPRING.stiffness, AGENT_CURSOR_FADE_SPRING.damping));
  springVars = {
    '--agent-cursor-soft': `${soft.durationMs}ms ${soft.easing}`,
    '--agent-cursor-ring': `${ring.durationMs}ms ${ring.easing}`,
  };
  return springVars;
}

/** The person's pointer over a cursor's arrow or pills (cursors take no pointer events). */
const HOVER_SLOP_PX = 4;

/**
 * What the cursors share: each one's resolved target, so a later cursor
 * lands beside an earlier one rather than on it, and the person's pointer,
 * for the arc's side and the name on hover.
 */
class CursorField {
  readonly targets = new Map<string, { target: Point; receivedAt: number }>();
  readonly wakers = new Map<string, () => void>();
  readonly pointerListeners = new Set<() => void>();
  pointer: Point | null = null;

  report(key: string, target: Point, receivedAt: number): void {
    const before = this.targets.get(key);
    if (before && before.receivedAt === receivedAt && before.target.x === target.x && before.target.y === target.y) return;
    this.targets.set(key, { target, receivedAt });
    for (const [other, wake] of this.wakers) if (other !== key) wake();
  }

  spot(key: string, zoom: number): Point | undefined {
    if (this.targets.size < 2) return this.targets.get(key)?.target;
    const entries = [...this.targets].map(([k, v]) => ({ key: k, ...v }));
    return deStack(entries, zoom).get(key);
  }

  forget(key: string): void {
    this.targets.delete(key);
    this.wakers.delete(key);
    for (const wake of this.wakers.values()) wake();
  }
}

function overlaps(rect: DOMRect, x: number, y: number): boolean {
  return rect.width > 0 && x >= rect.left - HOVER_SLOP_PX && x <= rect.right + HOVER_SLOP_PX
    && y >= rect.top - HOVER_SLOP_PX && y <= rect.bottom + HOVER_SLOP_PX;
}

type Phase = 'pickup' | 'travel' | 'rest';

function AgentCursorView({ cursor, zoom, peers, field }: {
  cursor: AgentCursor;
  zoom: number;
  peers: number;
  field: CursorField;
}) {
  const store = useStoreApi<Node<NodeData>>();
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<SVGSVGElement | null>(null);
  const wireRef = useRef<SVGLineElement | null>(null);
  const motion = useRef<CursorMotion | null>(null);
  const phase = useRef<Phase>('rest');
  // A new event plans a fresh move from wherever the cursor is.
  const planPending = useRef(false);
  const zoomRef = useRef(zoom);
  const peersRef = useRef(peers);
  const frame = useRef<number | null>(null);
  const lastTime = useRef<number | null>(null);
  const firstSightAt = useRef<number | null>(null);
  const hovered = useRef(false);
  const sayShownRef = useRef(false);
  const idleRef = useRef(false);
  const wake = useRef<() => void>(() => {});
  const updateLabel = useRef<() => void>(() => {});
  const [arrivedSeq, setArrivedSeq] = useState(0);
  // Each holds the event seq whose timer ran out, so a new event resets both.
  const [sayDoneSeq, setSayDoneSeq] = useState(0);
  const [sayFadeSeq, setSayFadeSeq] = useState(0);
  const [idleSeq, setIdleSeq] = useState(0);
  const showSay = Boolean(cursor.say) && sayDoneSeq !== cursor.seq;
  // Fading out, still mounted (GM - Design, round 19); a new event's seq ends it.
  const sayLeaving = sayFadeSeq === cursor.seq;
  const idle = idleSeq === cursor.seq;

  const dragging = cursor.action === 'drag' && cursor.from !== undefined;
  const fill = sessionFill(cursor.color, cursor.session);
  const name = sessionName(cursor.name, cursor.session);

  // Narration and idle dimming follow each new event. The bubble fades on a
  // spring about 3 s after the last event, then goes; at once under reduced
  // motion. A new event clears both timers, so a fade in progress stops.
  useEffect(() => {
    const seq = cursor.seq;
    let fadeTimer: number | undefined;
    const sayTimer = window.setTimeout(() => {
      if (prefersReducedMotion()) {
        setSayDoneSeq(seq);
        return;
      }
      setSayFadeSeq(seq);
      fadeTimer = window.setTimeout(() => setSayDoneSeq(seq), AGENT_SAY_FADE_MS);
    }, AGENT_SAY_MS);
    const idleTimer = window.setTimeout(() => setIdleSeq(seq), AGENT_CURSOR_IDLE_MS);
    return () => {
      window.clearTimeout(sayTimer);
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
      window.clearTimeout(idleTimer);
    };
  }, [cursor.seq]);

  // What the loop, the pointer and the timers read between renders.
  useLayoutEffect(() => {
    sayShownRef.current = showSay && !idle;
    idleRef.current = idle;
    peersRef.current = peers;
  });

  useLayoutEffect(() => {
    const reduced = prefersReducedMotion();
    const opacityTarget = () => (idleRef.current ? AGENT_CURSOR_IDLE_OPACITY : 1);
    // The person's pointer in flow coordinates, or null off the canvas.
    const pointerInFlow = (): Point | null => {
      const client = field.pointer;
      const { domNode, transform } = store.getState();
      if (!client || !domNode || !transform) return null;
      const box = domNode.getBoundingClientRect();
      if (client.x < box.left || client.x > box.right || client.y < box.top || client.y > box.bottom) return null;
      const [tx, ty, scale] = transform;
      return { x: (client.x - box.left - tx) / scale, y: (client.y - box.top - ty) / scale };
    };
    const apply = () => {
      const el = cursorRef.current;
      const m = motion.current;
      if (!el || !m) return;
      el.style.transform = `translate(${m.pos.x}px, ${m.pos.y}px) scale(${1 / zoomRef.current})`;
      el.style.opacity = String(Math.min(1, Math.max(0, m.opacity.x)));
      if (pointerRef.current) pointerRef.current.style.transform = m.lean.x === 0 ? '' : `rotate(${m.lean.x}deg)`;
      // Set outside React so a re-render never hides a placed cursor again.
      el.dataset.placed = 'true';
    };
    const updateWire = (start: Point | null) => {
      const line = wireRef.current;
      const m = motion.current;
      if (!line) return;
      if (!start || !m || phase.current !== 'travel' || !dragging) {
        line.style.opacity = '0';
        return;
      }
      line.setAttribute('x1', String(start.x));
      line.setAttribute('y1', String(start.y));
      line.setAttribute('x2', String(m.pos.x));
      line.setAttribute('y2', String(m.pos.y));
      line.style.strokeWidth = String(2 / zoomRef.current);
      line.style.opacity = '1';
    };
    // The name and say rules (§4), written as one attribute from the loop,
    // the pointer and the timers: never React state per frame.
    updateLabel.current = () => {
      const el = cursorRef.current;
      if (!el) return;
      const m = motion.current;
      const sinceFirstSightMs = firstSightAt.current === null ? 0 : performance.now() - firstSightAt.current;
      const shown = nameVisible({
        moving: !reduced && m !== null && isMoving(m, zoomRef.current),
        peers: peersRef.current,
        hovered: hovered.current,
        sinceFirstSightMs,
      });
      el.dataset.label = labelLayout(shown, sayShownRef.current);
    };

    const tick = (time: number) => {
      frame.current = null;
      const lookup = store.getState().nodeLookup;
      const resolved = resolveAnchor(cursor.target, lookup);
      const start = dragging && cursor.from ? resolveAnchor(cursor.from, lookup) : null;
      if (!resolved) return; // Node not drawn yet; the store subscription wakes us.
      const z = zoomRef.current;
      field.report(cursor.key, resolved, cursor.receivedAt);
      const target = field.spot(cursor.key, z) ?? resolved;
      const goal = phase.current === 'pickup' && start ? start : target;
      const pointer = pointerInFlow();

      if (!motion.current) {
        // First sighting: in from 64 px back along the line to its first target.
        motion.current = reduced
          ? createMotion(target, opacityTarget())
          : createMotion(entranceStart(goal, start ? { from: start, to: target } : null, z), 0);
        firstSightAt.current = performance.now();
        window.setTimeout(() => updateLabel.current(), AGENT_CURSOR_NAME_FIRST_SIGHT_MS + 20);
        if (!reduced) planMove(motion.current, goal, { zoom: z, pointer });
      } else if (planPending.current && !reduced) {
        planMove(motion.current, goal, { zoom: z, pointer });
      }
      planPending.current = false;

      const m = motion.current;
      const dt = lastTime.current === null ? 1 / 60 : (time - lastTime.current) / 1000;
      lastTime.current = time;
      const result = stepMotion(m, goal, dt, { zoom: z, reduced, opacityTarget: opacityTarget(), pointer });

      if (phase.current === 'pickup' && start) {
        // At the port, nearly still: now pull the wire to the target.
        const near = Math.hypot(m.pos.x - start.x, m.pos.y - start.y) * z < 2;
        if (!m.plan && near && Math.hypot(m.vel.x, m.vel.y) * z < AGENT_CURSOR_MOVING_SPEED) {
          phase.current = 'travel';
          planMove(m, target, { zoom: z, pointer });
        }
      } else if (phase.current === 'travel' && (result.arrived || reduced || (!m.plan && !m.landing))) {
        phase.current = 'rest';
        setArrivedSeq(cursor.seq);
      }
      apply();
      updateWire(start);
      updateLabel.current();

      if (phase.current === 'rest' && result.atRest) {
        lastTime.current = null;
        return; // At rest: sleep until the canvas, an event or a timer changes.
      }
      frame.current = requestAnimationFrame(tick);
    };

    wake.current = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
    };
    field.wakers.set(cursor.key, () => wake.current());
    const onPointer = () => {
      const client = field.pointer;
      const parts = [pointerRef.current, ...(cursorRef.current?.querySelectorAll('.agent-cursor__name, .agent-cursor__say') ?? [])];
      const over = client !== null && parts.some((part) => part && overlaps(part.getBoundingClientRect(), client.x, client.y));
      if (over === hovered.current) return;
      hovered.current = over;
      updateLabel.current();
    };
    field.pointerListeners.add(onPointer);

    phase.current = dragging && !reduced ? 'pickup' : 'travel';
    planPending.current = true;
    lastTime.current = null;
    wake.current();
    // Nodes move, resize, or appear after a graph sync: follow them.
    const unsubscribe = store.subscribe(() => wake.current());
    return () => {
      unsubscribe();
      field.pointerListeners.delete(onPointer);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [cursor.seq, cursor.key, cursor.target, cursor.from, cursor.receivedAt, dragging, store, field]);

  useEffect(() => () => field.forget(cursor.key), [field, cursor.key]);

  // Idle dims on the fade spring, and the say pill's own timers change the label.
  useEffect(() => {
    wake.current();
  }, [idle]);
  useLayoutEffect(() => {
    updateLabel.current();
  });

  useEffect(() => {
    zoomRef.current = zoom;
    const el = cursorRef.current;
    const m = motion.current;
    if (el && m) el.style.transform = `translate(${m.pos.x}px, ${m.pos.y}px) scale(${1 / zoom})`;
  }, [zoom]);

  const ripple = RIPPLE_ACTIONS.has(cursor.action);
  return (
    <>
      <svg className="agent-cursor__wire-layer" aria-hidden="true">
        <line ref={wireRef} className="agent-cursor__wire" stroke={fill} />
      </svg>
      <div
        ref={cursorRef}
        className="agent-cursor"
        style={{ ['--agent-color' as string]: fill, ['--agent-ink' as string]: inkFor(fill) }}
        data-agent={cursor.id}
        data-session={cursor.session?.key}
        data-action={cursor.action}
        data-idle={idle ? 'true' : undefined}
        role="status"
        aria-label={`${name}${cursor.say ? `: ${cursor.say}` : ''}`}
      >
        {ripple && arrivedSeq === cursor.seq && !prefersReducedMotion() && (
          <span key={cursor.seq} className="agent-cursor__ripple" />
        )}
        <svg ref={pointerRef} className="agent-cursor__pointer" width="20" height="22" viewBox="0 0 20 22" aria-hidden="true">
          <path d="M1.5 1.5 L1.5 17.5 L6 13.3 L9.1 20.1 L11.9 18.9 L8.9 12.3 L14.7 12.1 Z" />
        </svg>
        <div className="agent-cursor__label">
          <span className="agent-cursor__name">{name}</span>
          {showSay && !idle && (
            <span className={`agent-cursor__say${sayLeaving ? ' agent-cursor__say--leaving' : ''}`}>{cursor.say}</span>
          )}
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
  const [field] = useState(() => new CursorField());

  useEffect(() => {
    const timer = window.setInterval(() => prune(), PRUNE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [prune]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      field.pointer = { x: event.clientX, y: event.clientY };
      for (const listener of field.pointerListeners) listener();
    };
    const onLeave = () => {
      field.pointer = null;
      for (const listener of field.pointerListeners) listener();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, [field]);

  const cursors = Object.values(agents);
  if (cursors.length === 0) return null;
  // The most recently active cursor paints on top.
  const byKey = new Map(cursors.map((cursor) => [cursor.key, cursor]));
  return (
    <ViewportPortal>
      <div className="agent-cursor-layer" style={cursorSpringVars()}>
        {paintOrder(cursors).map((key) => (
          <AgentCursorView key={key} cursor={byKey.get(key)!} zoom={zoom} peers={cursors.length} field={field} />
        ))}
      </div>
    </ViewportPortal>
  );
}
