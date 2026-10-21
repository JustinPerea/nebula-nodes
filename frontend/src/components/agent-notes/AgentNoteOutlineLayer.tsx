import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore, useStoreApi, ViewportPortal, type Node, type ReactFlowState } from '@xyflow/react';
import type { NodeData } from '../../types';
import { selectActiveOutline, useAgentNotesStore, type OutlineSpec } from '../../store/agentNotesStore';
import { springCssVars, springLinear, SPRING_SOFT } from '../../lib/springs';
import './agentNotes.css';

const zoomSelector = (state: ReactFlowState) => state.transform[2];

interface NodeBox { x: number; y: number; width: number; height: number }

/**
 * The node's card in flow units. A model node's box starts at its small
 * category label, about 38 px above the card (lib/canvasPins.ts), so the
 * outline measures the drawn `.model-node__card` inside it when there is one.
 */
function nodeBox(state: Pick<ReactFlowState, 'nodeLookup' | 'transform'>, id: string): NodeBox | null {
  const internal = state.nodeLookup.get(id);
  if (!internal) return null;
  const position = internal.internals?.positionAbsolute;
  const width = internal.measured?.width ?? internal.width;
  const height = internal.measured?.height ?? internal.height;
  if (!position || !width || !height) return null;
  const box = { x: position.x, y: position.y, width, height };
  if (typeof document === 'undefined') return box;
  const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  const card = el?.querySelector('.model-node__card');
  if (!el || !card) return box;
  const outer = el.getBoundingClientRect();
  const inner = card.getBoundingClientRect();
  const zoom = state.transform[2] || 1;
  if (!outer.width || !inner.width || !inner.height) return box;
  return {
    x: box.x + (inner.left - outer.left) / zoom,
    y: box.y + (inner.top - outer.top) / zoom,
    width: inner.width / zoom,
    height: inner.height / zoom,
  };
}

/** The spec to draw, kept a moment after it goes so the outlines fade out. */
function useShownOutline(): { spec: OutlineSpec | null; leaving: boolean } {
  const active = useAgentNotesStore(selectActiveOutline);
  const [shown, setShown] = useState<{ spec: OutlineSpec | null; leaving: boolean }>({ spec: active, leaving: false });
  if (active && shown.spec !== active) setShown({ spec: active, leaving: false });
  if (!active && shown.spec && !shown.leaving) setShown({ spec: shown.spec, leaving: true });
  useEffect(() => {
    if (!shown.leaving) return;
    const timer = window.setTimeout(() => setShown({ spec: null, leaving: false }), springLinear(SPRING_SOFT).durationMs + 60);
    return () => window.clearTimeout(timer);
  }, [shown]);
  return shown;
}

function Outline({ id, index, spec }: { id: string; index: number; spec: OutlineSpec }) {
  const store = useStoreApi<Node<NodeData>>();
  const ref = useRef<HTMLDivElement | null>(null);
  const [drawn, setDrawn] = useState<NodeBox | null>(() => nodeBox(store.getState(), id));

  // Follow the node as it moves or resizes, without a render per frame.
  useLayoutEffect(() => {
    const apply = () => {
      const box = nodeBox(store.getState(), id);
      const el = ref.current;
      if (!box) {
        setDrawn(null);
        return;
      }
      if (!el) {
        setDrawn(box);
        return;
      }
      el.style.transform = `translate(${box.x}px, ${box.y}px)`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
    };
    return store.subscribe(apply);
  }, [id, store]);

  if (!drawn) return null;
  const style = {
    transform: `translate(${drawn.x}px, ${drawn.y}px)`,
    width: `${drawn.width}px`,
    height: `${drawn.height}px`,
    '--an-delay': `${spec.delayMs + index * spec.staggerMs}ms`,
  } as CSSProperties;
  return <div ref={ref} className="agent-note-outline" data-node={id} style={style} />;
}

/**
 * Outlines the nodes an update names, in its author's colour: while its card
 * is up (fading in 0.8 s after the card, 0.25 s apart), while its row is
 * hovered in the list, and for a moment after Show. Mounted inside React
 * Flow beside AgentCursorLayer; nothing is outlined for a node that isn't
 * drawn. One layer, so a later reader trace (PR10b) shares it.
 */
export function AgentNoteOutlineLayer() {
  const zoom = useStore(zoomSelector);
  const { spec, leaving } = useShownOutline();
  // Only nodes that are drawn, so the stagger counts what is outlined.
  const drawnRefs = useStore((state) => (spec ? spec.refs.filter((id) => state.nodeLookup.has(id)).join('\n') : ''));
  if (!spec || !drawnRefs) return null;
  const style = {
    ...springCssVars(),
    '--an-outline': spec.color,
    '--an-zoom': String(zoom || 1),
  } as CSSProperties;
  return (
    <ViewportPortal>
      <div className="agent-note-outlines" data-leaving={leaving ? 'true' : undefined} style={style} aria-hidden="true">
        {drawnRefs.split('\n').map((id, index) => <Outline key={id} id={id} index={index} spec={spec} />)}
      </div>
    </ViewportPortal>
  );
}
