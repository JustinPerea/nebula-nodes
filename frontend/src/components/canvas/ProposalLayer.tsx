import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useStoreApi, ViewportPortal, type Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import { AGENT_CURSOR_SPRING, isAtRest, stepSpring, type Point, type SpringState } from '../../lib/agentCursorMotion';
import {
  briefValue,
  changeTag,
  fullValue,
  ghostPosition,
  ghostRows,
  wireEnd,
  wirePath,
  type ProposalView,
} from '../../lib/canvasProposals';
import { useCanvasProposalsStore, type ProposalEntry } from '../../store/canvasProposalsStore';
import '../../styles/canvasProposals.css';

const ENTER_FROM = 0.92;
const GHOST_PARAMS = 3;
const GHOST_VALUE_CHARS = 36;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

type GhostNode = ProposalView['nodes'][number];

function GhostCard({
  proposalId,
  node,
  exact,
  agentName,
  register,
}: {
  proposalId: string;
  node: GhostNode;
  /** The full values Accept will write (browser-only), when the canvas has them. */
  exact?: Record<string, unknown>;
  agentName: string;
  register: (ref: string, el: HTMLDivElement | null) => void;
}) {
  const store = useStoreApi<Node<NodeData>>();
  const moveGhost = useCanvasProposalsStore((s) => s.moveGhost);
  const drag = useRef<{ pointer: number; startX: number; startY: number; from: Point; zoom: number } | null>(null);
  const all = Object.entries(exact ?? node.params ?? {});
  const params = all
    .filter(([, value]) => value !== null && value !== '' && typeof value !== 'object')
    .slice(0, GHOST_PARAMS);
  // The card has room for a few short values. Say so when it shows less than
  // Accept will write, so the person knows to open the bar's details.
  const hidden = all.length - params.length;
  const shortened = params.some(([, value]) => fullValue(value).length > GHOST_VALUE_CHARS);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const entry = useCanvasProposalsStore.getState();
    const view = entry.proposals[proposalId]?.view;
    const from = view ? ghostPosition(view, node.ref, entry.drag[proposalId]) : null;
    if (!from) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from,
      zoom: store.getState().transform[2] || 1,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    // Screen pixels to flow units: the ghost follows the pointer exactly.
    moveGhost(proposalId, node.ref, {
      x: active.from.x + (event.clientX - active.startX) / active.zoom,
      y: active.from.y + (event.clientY - active.startY) / active.zoom,
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div
      ref={(el) => register(node.ref, el)}
      className="proposal-ghost nodrag nopan nowheel"
      style={{ ['--ghost-rows' as string]: ghostRows(node) }}
      data-ref={node.ref}
      aria-label={`Proposed ${node.name} (${node.ref}) from ${agentName}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="proposal-ghost__header">
        <span className="proposal-ghost__category">{node.category || 'node'}</span>
        <span className="proposal-ghost__name">{node.name}</span>
      </div>
      <div className="proposal-ghost__body">
        {params.map(([key, value]) => (
          <p key={key} className="proposal-ghost__param">
            <span className="proposal-ghost__key">{key}</span> {briefValue(value, GHOST_VALUE_CHARS)}
          </p>
        ))}
        {(hidden > 0 || shortened) && (
          <p className="proposal-ghost__more">
            {hidden > 0 ? `+${hidden} more setting${hidden === 1 ? '' : 's'}` : 'Values shortened'} · full values in the bar
          </p>
        )}
        <span className={`proposal-ghost__cost proposal-ghost__cost--${node.cost.kind}`}>{node.cost.label}</span>
        <p className="proposal-ghost__caption">
          {node.ref} · proposed by {agentName}
        </p>
      </div>
      {node.ports.inputs.map((port, row) => (
        <span
          key={`in-${port.id}`}
          className="proposal-ghost__port proposal-ghost__port--in"
          style={{ ['--port-row' as string]: row }}
          title={port.label}
        />
      ))}
      {node.ports.outputs.map((port, row) => (
        <span
          key={`out-${port.id}`}
          className="proposal-ghost__port proposal-ghost__port--out"
          style={{ ['--port-row' as string]: row }}
          title={port.label}
        />
      ))}
    </div>
  );
}

/** One proposal's ghosts, wires and param-change rings, positioned imperatively. */
function ProposalGhosts({ entry }: { entry: ProposalEntry }) {
  const store = useStoreApi<Node<NodeData>>();
  const { view } = entry;
  const cards = useRef(new Map<string, HTMLDivElement>());
  const paths = useRef(new Map<number, SVGPathElement>());
  const rings = useRef(new Map<string, HTMLDivElement>());
  const scale = useRef<SpringState>({ x: prefersReducedMotion() ? 1 : ENTER_FROM, y: 0, vx: 0, vy: 0 });
  const apply = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    apply.current = () => {
      const lookup = store.getState().nodeLookup;
      const drag = useCanvasProposalsStore.getState().drag[view.id];
      for (const node of view.nodes) {
        const el = cards.current.get(node.ref);
        const at = ghostPosition(view, node.ref, drag);
        if (el && at) el.style.transform = `translate(${at.x}px, ${at.y}px) scale(${scale.current.x})`;
      }
      view.edges.forEach((edge, index) => {
        const path = paths.current.get(index);
        if (!path) return;
        const from = wireEnd(view, edge.source, edge.sourceHandle, 'output', drag, lookup);
        const to = wireEnd(view, edge.target, edge.targetHandle, 'input', drag, lookup);
        if (from && to) {
          path.setAttribute('d', wirePath(from, to));
          path.dataset.placed = 'true';
        } else {
          path.dataset.placed = 'false';
        }
      });
      for (const change of view.params) {
        const el = rings.current.get(change.nodeId);
        const node = lookup.get(change.nodeId);
        if (!el) continue;
        if (!node) {
          el.dataset.placed = 'false';
          continue;
        }
        const { x, y } = node.internals.positionAbsolute;
        el.style.transform = `translate(${x - 6}px, ${y - 6}px)`;
        el.style.width = `${(node.measured?.width ?? 0) + 12}px`;
        el.style.height = `${(node.measured?.height ?? 0) + 12}px`;
        el.dataset.placed = 'true';
      }
    };
    apply.current();
    // Follow real nodes as they move, and ghosts as the person drags them.
    const offFlow = store.subscribe(() => apply.current());
    const offDrag = useCanvasProposalsStore.subscribe((state, previous) => {
      if (state.drag !== previous.drag) apply.current();
    });
    return () => {
      offFlow();
      offDrag();
    };
  }, [store, view]);

  // Ghosts settle in on the cursor spring; reduced motion starts them at rest.
  useEffect(() => {
    if (prefersReducedMotion()) {
      scale.current = { x: 1, y: 0, vx: 0, vy: 0 };
      apply.current();
      return;
    }
    let frame: number | null = null;
    let last: number | null = null;
    const tick = (time: number) => {
      const dt = last === null ? 1 / 60 : (time - last) / 1000;
      last = time;
      scale.current = stepSpring(scale.current, { x: 1, y: 0 }, dt, AGENT_CURSOR_SPRING);
      if (isAtRest(scale.current, { x: 1, y: 0 })) {
        scale.current = { x: 1, y: 0, vx: 0, vy: 0 };
        apply.current();
        frame = null;
        return;
      }
      apply.current();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [view.id]);

  return (
    <div
      className={`proposal-ghosts${entry.closing ? ' proposal-ghosts--closing' : ''}`}
      style={{ ['--agent-color' as string]: view.agent.color }}
      data-proposal={view.id}
    >
      <svg className="proposal-wires" aria-hidden="true">
        {view.edges.map((edge, index) => (
          <path
            key={`${edge.source}.${edge.sourceHandle}-${edge.target}.${edge.targetHandle}`}
            ref={(el) => {
              if (el) paths.current.set(index, el);
              else paths.current.delete(index);
            }}
            className="proposal-wire"
          />
        ))}
      </svg>
      {view.params.map((change) => (
        <div
          key={change.nodeId}
          ref={(el) => {
            if (el) rings.current.set(change.nodeId, el);
            else rings.current.delete(change.nodeId);
          }}
          className="proposal-ring"
          data-node={change.nodeId}
        >
          <span className="proposal-ring__tag" title={changeTag(entry.values?.params[change.nodeId] ?? change.changes, 400)}>
            proposed: {changeTag(entry.values?.params[change.nodeId] ?? change.changes)}
          </span>
        </div>
      ))}
      {view.nodes.map((node) => (
        <GhostCard
          key={node.ref}
          proposalId={view.id}
          node={node}
          exact={entry.values?.nodes[node.ref]}
          agentName={view.agent.name}
          register={(ref, el) => {
            if (el) {
              cards.current.set(ref, el);
              apply.current();
            } else {
              cards.current.delete(ref);
            }
          }}
        />
      ))}
    </div>
  );
}

/**
 * Agents' proposals drawn as ghosts: translucent cards and dashed wires in
 * the agent's colour. Nothing here touches the graph store, so ghosts never
 * reach autosave, the project snapshot or a run.
 */
export function ProposalLayer() {
  const proposals = useCanvasProposalsStore((s) => s.proposals);
  const entries = Object.values(proposals);
  if (entries.length === 0) return null;
  return (
    <ViewportPortal>
      <div className="proposal-layer">
        {entries.map((entry) => (
          <ProposalGhosts key={entry.view.id} entry={entry} />
        ))}
      </div>
    </ViewportPortal>
  );
}
