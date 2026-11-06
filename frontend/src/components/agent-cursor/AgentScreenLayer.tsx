import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAgentPresenceStore, type AgentCursor } from '../../store/agentPresenceStore';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import { AnchorResolver, domEnv, type ResolverEnv } from '../../lib/agentAnchorResolve';
import { screenSpace, type ScreenSpace } from '../../lib/agentCursorSpace';
import { layerOf } from '../../lib/agentCursorLayerOf';
import { inkFor } from '../../lib/agentCursorLook';
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

export function AgentScreenLayer({ canvasMounted, env }: {
  /** The canvas is on screen: a canvas anchor is then the canvas layer's. */
  canvasMounted: boolean;
  /** The page as the resolver reads it; the DOM's unless a test gives its own. */
  env?: ResolverEnv;
}) {
  const everyone = useAgentPresenceStore((s) => s.agents);
  const agents = useMemo(() => {
    const own: typeof everyone = {};
    for (const [key, cursor] of Object.entries(everyone)) {
      if (layerOf(cursor.target, { canvasMounted }) === 'screen') own[key] = cursor;
    }
    return own;
  }, [everyone, canvasMounted]);
  // What the space reads is kept on one object the layer's effects update
  // (the box by its callback ref, the canvas flag when it changes), never
  // read from a ref in a render.
  const [context] = useState(() => new LayerContext(canvasMounted));
  const [space] = useState<ScreenSpace>(() => {
    const resolverEnv = env ?? domEnv();
    return screenSpace({
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

  return (
    <div className="agent-screen-layer" ref={(el) => context.setPane(el)} style={cursorSpringVars()}>
      <AgentCursorSurface
        agents={agents}
        everyone={everyone}
        space={space}
        zoom={1}
        layerClass="agent-cursor-layer agent-cursor-layer--screen"
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
          {ring.more > 0 ? <span className="agent-item-outline__more" style={{ color: inkFor(ring.color) }}>{`+${ring.more}`}</span> : null}
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
              style={{ left: dot.at.x, top: dot.at.y, opacity: dot.idle ? DOT_IDLE_OPACITY : 1, ['--agent-color' as string]: dot.color }}
            />
          ))}
          {group.moreAt ? (
            <span
              className="agent-launcher-dot__more"
              style={{ left: group.moreAt.x, top: group.moreAt.y, ['--agent-color' as string]: group.moreColor, color: inkFor(group.moreColor) }}
            >{`+${group.more}`}</span>
          ) : null}
        </div>
      ))}
      {ghosts.map((ghost) => (ghost.more > 0 ? (
        <span key={ghost.id} className="agent-launcher-dot__more" data-leaving="true"
          style={{ left: ghost.at.x, top: ghost.at.y, ['--agent-color' as string]: ghost.color, color: inkFor(ghost.color) }}>{`+${ghost.more}`}</span>
      ) : (
        <span key={ghost.id} className="agent-launcher-dot" data-leaving="true"
          style={{ left: ghost.at.x, top: ghost.at.y, ['--agent-color' as string]: ghost.color }} />
      )))}
    </div>
  );
}
