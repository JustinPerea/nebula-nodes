import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useAgentPresenceStore, type AgentCursor } from '../../store/agentPresenceStore';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import { AnchorResolver, domEnv, type ResolverEnv } from '../../lib/agentAnchorResolve';
import { useStoreApi } from '@xyflow/react';
import { canvasSpace, screenSpace, watchFlowStore, type FlowStoreLike, type ScreenSpace } from '../../lib/agentCursorSpace';
import { cursorHandoff, flyingBack, handoffVersion, subscribeHandoff } from '../../lib/agentCursorHandoff';
import { layerOf } from '../../lib/agentCursorLayerOf';
import { OutlineBook } from '../../lib/agentCursorOutlines';
import { DOT_IDLE_OPACITY, DotBook } from '../../lib/agentLauncherDots';
import { cursorSpringVars } from '../../lib/agentCursorSpringVars';
import type { AgentCursorAnchor } from '../../lib/wsClient';
import { AgentCursorSurface, type CursorLandings } from './AgentCursorField';
import '../../styles/agentCursorAnywhere.css';

/**
 * The screen layer (Phase 3, "Anywhere", slice 5): the agent cursors on every
 * surface beside the canvas, the Moodboard panel and Studio first. One fixed,
 * click-through box over the window, mounted once at the app root (lazy with
 * the cursor chunk, never in the entry), above the docks and below modals and
 * the notice region (GM - Design 5: z-index in agentCursorAnywhere.css).
 *
 * It runs the same view and column field as the canvas layer
 * (AgentCursorField.tsx) over a `CursorSpace` of the window
 * (lib/agentCursorSpace.ts screenSpace), so names, columns, says, recency and
 * reduced motion hold here as they do there. A cursor lives in exactly one
 * layer (lib/agentCursorLayerOf.ts); this one filters the one presence store
 * for the rest.
 *
 * Nothing here opens, scrolls or pans anything: it reads rects.
 */

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** The image's item no longer exists: a removed image the cursor holds the
 *  spot of (GM - Design 4). Only while its board is open in the Studio and
 *  the image is not among its images: a panel that closed isn't a removal. */
function removedImage(anchor: AgentCursorAnchor): boolean {
  if (!('surface' in anchor)) return false;
  const [board, image] = anchor.itemId.split('/');
  if (!image) return false;
  const studio = useBoardCanvasStore.getState().studioBoard;
  return studio !== null && studio.boardId === board && !studio.imageIds.includes(image);
}

/** What the screen space reads of the layer: its box and whether the canvas is on screen. */
class LayerContext {
  pane: Element | null = null;
  canvasMounted: boolean;

  constructor(canvasMounted: boolean) {
    this.canvasMounted = canvasMounted;
  }

  setPane(element: Element | null): void {
    this.pane = element;
  }

  setCanvasMounted(mounted: boolean): boolean {
    const changed = this.canvasMounted !== mounted;
    this.canvasMounted = mounted;
    return changed;
  }
}

/**
 * The canvas pane's box, read once a frame however many cursors resolve in it
 * (a layout read between transform writes forces a layout each time). The
 * read is dropped on the next frame: the callback that clears it is queued
 * before the cursor's own next frame, so it runs first.
 */
class FrameBox {
  private box: DOMRect | null = null;
  private element: Element | null = null;

  of(dom: Element): DOMRect {
    if (this.box && this.element === dom) return this.box;
    this.box = dom.getBoundingClientRect();
    this.element = dom;
    requestAnimationFrame(() => { this.box = null; });
    return this.box;
  }
}

/** The canvas's React Flow store, when the layer sits inside its provider (the app's always does). */
function useFlowStore(): FlowStoreLike | null {
  try {
    return useStoreApi() as unknown as FlowStoreLike;
  } catch {
    return null;
  }
}

export function AgentScreenLayer({ canvasMounted, env }: {
  /** The canvas is on screen: a canvas anchor is then the canvas layer's. */
  canvasMounted: boolean;
  /** The page as the resolver reads it; the DOM's unless a test gives its own. */
  env?: ResolverEnv;
}) {
  const everyone = useAgentPresenceStore((s) => s.agents);
  // A cursor flying back to a canvas node is this layer's until it lands
  // (GM r137): the canvas layer sits under the docks, so a cursor that left a
  // dock would fly behind it. It is drawn here as a flight only (no say, no
  // gesture: the canvas layer plays those at the landing).
  const handoff = useSyncExternalStore(subscribeHandoff, handoffVersion);
  useEffect(() => { cursorHandoff.retain(Object.keys(everyone)); }, [everyone]);
  const { agents, transit } = useMemo(() => {
    const own: typeof everyone = {};
    const flying = new Set<string>();
    for (const [key, cursor] of Object.entries(everyone)) {
      if (layerOf(cursor.target, { canvasMounted }) === 'screen') own[key] = cursor;
      else if (flyingBack(cursor, canvasMounted)) {
        own[key] = { ...cursor, say: '', action: 'click', from: undefined };
        flying.add(key);
      }
    }
    return { agents: own, transit: flying };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `handoff` is the registry's version: a claim or a landing changes who flies it
  }, [everyone, canvasMounted, handoff]);
  // What the space reads is kept on one object the layer's effects update
  // (the box by its callback ref, the canvas flag when it changes), never
  // read from a ref in a render.
  const [context] = useState(() => new LayerContext(canvasMounted));
  const flowApi = useFlowStore();
  const [space] = useState<ScreenSpace>(() => {
    const resolverEnv = env ?? domEnv();
    const paneBox = new FrameBox();
    const onCanvas = flowApi ? canvasSpace(flowApi as unknown as Parameters<typeof canvasSpace>[0]) : null;
    return screenSpace({
      // Where a canvas node is on screen, while it is inside the canvas's box.
      canvasPoint: (anchor, waitRest = false) => {
        const dom = onCanvas?.pane();
        const flow = waitRest ? onCanvas?.waitRest?.(anchor) : onCanvas?.resolve(anchor);
        if (!onCanvas || !dom || !flow) return null;
        const box = paneBox.of(dom);
        const at = onCanvas.toClient(flow, box);
        const inside = at && at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom;
        return inside ? at : null;
      },
      resolver: new AnchorResolver(resolverEnv),
      measure: resolverEnv.measure,
      watch: resolverEnv.watch,
      pane: () => context.pane,
      canvasMounted: () => context.canvasMounted,
      gone: removedImage,
    });
  });
  // The canvas mounting or going changes what a canvas anchor resolves to:
  // wake every cursor so it reads the page again.
  useLayoutEffect(() => {
    if (context.setCanvasMounted(canvasMounted)) space.refresh();
  }, [canvasMounted, context, space]);

  // The canvas panning, zooming or a node dragging moves a cursor parked at a
  // Moodboard node with no DOM event: wake on the canvas store's changes.
  const flowStore = useFlowStore();
  useEffect(() => (flowStore ? watchFlowStore(flowStore, () => space.refresh()) : undefined), [flowStore, space]);

  return (
    <div className="agent-screen-layer" ref={(el) => context.setPane(el)} style={cursorSpringVars()}>
      <AgentCursorSurface
        agents={agents}
        everyone={everyone}
        space={space}
        zoom={1}
        layerClass="agent-cursor-layer agent-cursor-layer--screen"
        transit={transit}
        beside={(landings) => (
          <>
            <ItemOutlines agents={agents} space={space} landings={landings} />
            <LauncherDots agents={agents} space={space} landings={landings} />
          </>
        )}
      />
    </div>
  );
}

/**
 * The item outlines: a 1.5 px agent-colour rect on the item a cursor that has
 * landed is typing in (solid) or proposing on (dashed), held at least
 * `minHoldMs`. Agents on one item nest 2 px apart, the earliest innermost,
 * "+N" from the third (lib/agentCursorOutlines.ts). Drawn clipped to where the
 * item shows; measured when a cursor lands, the cursors change, or the page
 * moves (never per frame), so a resting outline rides a scroll with its item.
 */
function ItemOutlines({ agents, space, landings }: { agents: Record<string, AgentCursor>; space: ScreenSpace; landings: CursorLandings }) {
  const [book] = useState(() => new OutlineBook({ landings, space }));
  const rings = useSyncExternalStore(book.subscribe, book.getSnapshot);
  useEffect(() => { book.setAgents(agents); }, [book, agents]);
  if (rings.length === 0) return null;
  return (
    <div className="agent-item-outlines" aria-hidden="true">
      {rings.map((ring) => (
        <div
          key={ring.key}
          className="agent-item-outline"
          data-kind={ring.kind}
          data-ring={ring.index}
          style={{
            left: ring.box.left,
            top: ring.box.top,
            width: ring.box.width,
            height: ring.box.height,
            ['--agent-color' as string]: ring.color,
          }}
        >
          {ring.more > 0 ? <span className="agent-item-outline__more" style={ringStyle(ring.surface ?? '')}>{`+${ring.more}`}</span> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * The launcher dots (slice 8, GM - Design 2): a 6 px agent-colour dot on the
 * launcher a landed cursor is parked at (the board's row, the dock's tab, the
 * rail's "Open assets", a Studio's "Back to Canvas"); two agents give two
 * dots, from three one dot and "+N". Dimmed with the cursor at the idle, gone
 * when it leaves, is sent elsewhere or is pruned. Drawn here, not in the rail
 * (so it never re-renders on a presence event); `aria-hidden`, the Agents
 * panel lists every agent. Lib: lib/agentLauncherDots.ts.
 */
/** The badge ring takes the launcher's own surface colour; none set, the stylesheet's default. */
const ringStyle = (ring: string): CSSProperties => (ring ? { ['--agent-badge-ring' as string]: ring } : {});

function LauncherDots({ agents, space, landings }: { agents: Record<string, AgentCursor>; space: ScreenSpace; landings: CursorLandings }) {
  const [book] = useState(() => new DotBook({ landings, space, reducedMotion: prefersReducedMotion }));
  const { groups, ghosts } = useSyncExternalStore(book.subscribe, book.getSnapshot);
  useEffect(() => { book.setAgents(agents); }, [book, agents]);
  if (groups.length === 0 && ghosts.length === 0) return null;
  return (
    <div className="agent-launcher-dots" aria-hidden="true">
      {groups.map((group) => (
        <div key={group.launcher} className="agent-launcher-dots__group" data-launcher={group.launcher}>
          {group.dots.map((dot) => (
            <span
              key={dot.key}
              className="agent-launcher-dot"
              data-agent-key={dot.key}
              data-idle={dot.idle ? 'true' : undefined}
              style={{ left: dot.at.x, top: dot.at.y, opacity: dot.idle ? DOT_IDLE_OPACITY : 1, ['--agent-color' as string]: dot.color, ...ringStyle(group.ring) }}
            />
          ))}
          {group.moreAt ? (
            <span
              className="agent-launcher-dot__more"
              style={{ left: group.moreAt.x, top: group.moreAt.y, ...ringStyle(group.ring) }}
            >{`+${group.more}`}</span>
          ) : null}
        </div>
      ))}
      {ghosts.map((ghost) => (ghost.more > 0 ? (
        <span key={ghost.id} className="agent-launcher-dot__more" data-leaving="true"
          style={{ left: ghost.at.x, top: ghost.at.y, ...ringStyle(ghost.ring) }}>{`+${ghost.more}`}</span>
      ) : (
        <span key={ghost.id} className="agent-launcher-dot" data-leaving="true"
          style={{ left: ghost.at.x, top: ghost.at.y, ['--agent-color' as string]: ghost.color, ...ringStyle(ghost.ring) }} />
      )))}
    </div>
  );
}
