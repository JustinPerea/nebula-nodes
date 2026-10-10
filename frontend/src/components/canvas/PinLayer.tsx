import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, useStoreApi, ViewportPortal, type Node, type ReactFlowState } from '@xyflow/react';
import { Check, StickyNote, Trash2 } from 'lucide-react';
import type { NodeData } from '../../types';
import type { Pin } from '../../lib/wsClient';
import { AGENT_CURSOR_SPRING, isAtRest, stepSpring, type SpringState } from '../../lib/agentCursorMotion';
import { useCanvasPinsStore } from '../../store/canvasPinsStore';
import { pinPoint, relativeTime } from '../../lib/canvasPins';
import '../../styles/canvasPins.css';

/** A pin newer than this pops in when it first appears (older ones are just there). */
const FRESH_MS = 8_000;
const POP_FROM = 0.6;
/** Card offset (16) + width (220) + a little air. */
const CARD_REACH_PX = 250;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function PinBadge({ pin, slot, zoom }: { pin: Pin; slot: number; zoom: number }) {
  const store = useStoreApi<Node<NodeData>>();
  const remove = useCanvasPinsStore((s) => s.remove);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(zoom);
  const scale = useRef<SpringState>({ x: 1, y: 0, vx: 0, vy: 0 });
  const frame = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [opened, setOpened] = useState(false);
  const expanded = hovered || focused || opened;
  const resolved = pin.status === 'resolved' && pin.reply !== null;
  // A new pin, or a new reply on an old one, earns a small pop.
  const popKey = `${pin.id}:${pin.reply?.at ?? ''}`;

  useLayoutEffect(() => {
    const apply = () => {
      const el = wrapRef.current;
      if (!el) return;
      const point = pinPoint(pin, slot, store.getState().nodeLookup);
      if (!point) {
        el.dataset.placed = 'false';
        return;
      }
      el.style.transform = `translate(${point.x}px, ${point.y}px) scale(${scale.current.x / zoomRef.current})`;
      el.dataset.placed = 'true';
    };
    apply();
    // Follow the node as it moves or resizes.
    const unsubscribe = store.subscribe(apply);
    return unsubscribe;
  }, [pin, slot, store]);

  useEffect(() => {
    const fresh = Date.now() - Date.parse(pin.reply?.at || pin.createdAt) < FRESH_MS;
    if (!fresh || prefersReducedMotion()) return;
    scale.current = { x: POP_FROM, y: 0, vx: 0, vy: 0 };
    let last: number | null = null;
    const tick = (time: number) => {
      const dt = last === null ? 1 / 60 : (time - last) / 1000;
      last = time;
      scale.current = stepSpring(scale.current, { x: 1, y: 0 }, dt, AGENT_CURSOR_SPRING);
      const el = wrapRef.current;
      const point = el ? pinPoint(pin, slot, store.getState().nodeLookup) : null;
      if (el && point) {
        el.style.transform = `translate(${point.x}px, ${point.y}px) scale(${scale.current.x / zoomRef.current})`;
      }
      if (isAtRest(scale.current, { x: 1, y: 0 })) {
        scale.current = { x: 1, y: 0, vx: 0, vy: 0 };
        frame.current = null;
        return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      scale.current = { x: 1, y: 0, vx: 0, vy: 0 };
    };
    // Only a new pin or a new reply replays the pop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popKey]);

  useEffect(() => {
    zoomRef.current = zoom;
    const el = wrapRef.current;
    const point = el ? pinPoint(pin, slot, store.getState().nodeLookup) : null;
    if (el && point) el.style.transform = `translate(${point.x}px, ${point.y}px) scale(${scale.current.x / zoom})`;
  }, [zoom, pin, slot, store]);

  // Open the card toward whichever side has room, so a pin near the right
  // edge of the canvas doesn't push its note off-screen.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || !expanded) return;
    const canvas = el.closest('.react-flow')?.getBoundingClientRect();
    const badge = el.getBoundingClientRect();
    if (!canvas) return;
    el.dataset.side = badge.left + CARD_REACH_PX > canvas.right ? 'left' : 'right';
  }, [expanded]);

  const where = 'nodeId' in pin.anchor ? `on ${pin.anchor.nodeId}` : 'on the canvas';
  return (
    <div
      ref={wrapRef}
      className={`canvas-pin nodrag nopan${resolved ? ' canvas-pin--resolved' : ''}${expanded ? ' canvas-pin--expanded' : ''}`}
      style={resolved ? { ['--agent-color' as string]: pin.reply!.agent.color } : undefined}
      data-pin={pin.id}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        setOpened(false);
        setHovered(false);
        (document.activeElement as HTMLElement | null)?.blur?.();
        setFocused(false);
      }}
    >
      <button
        type="button"
        className="canvas-pin__badge"
        aria-expanded={expanded}
        aria-label={`Note for agents ${where}: ${pin.text}${resolved ? ' (answered)' : ''}`}
        onClick={() => setOpened((value) => !value)}
      >
        {resolved ? <Check size={12} aria-hidden="true" /> : <StickyNote size={12} aria-hidden="true" />}
      </button>
      {expanded && (
        <div className="canvas-pin__card" role="note">
          <p className="canvas-pin__text">{pin.text}</p>
          <p className="canvas-pin__meta">
            {relativeTime(pin.createdAt)}
            {pin.detached && pin.detachedFrom ? ` · its node ${pin.detachedFrom} was removed` : ''}
            {!resolved ? ' · waiting for an agent' : ''}
          </p>
          {resolved && pin.reply && (
            <p className="canvas-pin__reply">
              <span className="canvas-pin__agent">{pin.reply.agent.name}</span>
              <span>{pin.reply.text}</span>
            </p>
          )}
          <button
            type="button"
            className="canvas-pin__delete"
            aria-label="Delete note"
            onClick={() => void remove(pin.id)}
          >
            <Trash2 size={12} aria-hidden="true" />
            <span>Delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Ids of drawn nodes, as one string so the selector only changes when the set does. */
function drawnNodeIds(state: ReactFlowState): string {
  return [...state.nodeLookup.keys()].join('\n');
}

/** The person's notes for agents, drawn as small badges on nodes and canvas spots. */
export function PinLayer() {
  const pins = useCanvasPinsStore((s) => s.pins);
  const zoom = useStore((s) => s.transform[2]);
  const drawn = useStore(drawnNodeIds);
  if (pins.length === 0) return null;

  const drawnIds = new Set(drawn ? drawn.split('\n') : []);
  const slots = new Map<string, number>();
  const visible: Array<{ pin: Pin; slot: number }> = [];
  for (const pin of pins) {
    if ('nodeId' in pin.anchor) {
      // Skipped until the node is drawn; it comes back on the next sync.
      if (!drawnIds.has(pin.anchor.nodeId)) continue;
      const slot = slots.get(pin.anchor.nodeId) ?? 0;
      slots.set(pin.anchor.nodeId, slot + 1);
      visible.push({ pin, slot });
    } else {
      visible.push({ pin, slot: 0 });
    }
  }
  if (visible.length === 0) return null;
  return (
    <ViewportPortal>
      <div className="canvas-pin-layer">
        {visible.map(({ pin, slot }) => (
          <PinBadge key={pin.id} pin={pin} slot={slot} zoom={zoom} />
        ))}
      </div>
    </ViewportPortal>
  );
}
