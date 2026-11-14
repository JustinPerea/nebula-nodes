import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useStore, useStoreApi, ViewportPortal, type Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import { useAgentPresenceStore } from '../../store/agentPresenceStore';
import { canvasSpace } from '../../lib/agentCursorSpace';
import { layerOf } from '../../lib/agentCursorLayerOf';
import { cursorHandoff, flyingBack, handoffVersion, subscribeHandoff } from '../../lib/agentCursorHandoff';
import { AgentCursorSurface } from '../agent-cursor/AgentCursorField';
import { CanvasEdgeChips } from './CanvasEdgeChips';

// The tests that import the layer's numbers keep their path.
export { CARRY_PREVIEW_HOLD_MS } from '../agent-cursor/AgentCursorField';

/**
 * Live cursors for agents working on the canvas, drawn in flow coordinates.
 * The view, the column field and the shared body live in
 * components/agent-cursor/AgentCursorField.tsx (the screen layer draws with
 * them too); this is the canvas's space and its viewport portal.
 */
export function AgentCursorLayer() {
  const everyone = useAgentPresenceStore((s) => s.agents);
  // This layer draws the cursors on the canvas; one on a surface beside it
  // (a moodboard) is the screen layer's (lib/agentCursorLayerOf.ts).
  // One flying back from a panel is the screen layer's until it lands
  // (GM r137), and then this layer's arrival is dated by the landing.
  const handoff = useSyncExternalStore(subscribeHandoff, handoffVersion);
  const agents = useMemo(() => {
    const own: typeof everyone = {};
    let same = true;
    for (const [key, cursor] of Object.entries(everyone)) {
      if (layerOf(cursor.target, { canvasMounted: true }) !== 'canvas' || flyingBack(cursor, true)) {
        same = false;
        continue;
      }
      const landedAt = cursorHandoff.landedAt(key, cursor.seq);
      if (landedAt !== null && landedAt > cursor.receivedAt) {
        own[key] = { ...cursor, receivedAt: landedAt };
        same = false;
      } else {
        own[key] = cursor;
      }
    }
    return same ? everyone : own;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `handoff` is the registry's version: a claim or a landing changes who draws it
  }, [everyone, handoff]);
  const zoom = useStore((s) => s.transform[2]);
  // The canvas as a CursorSpace: the one thing here that knows React Flow
  // (lib/agentCursorSpace.ts). The store's API is the same object for the
  // layer's life.
  const storeApi = useStoreApi<Node<NodeData>>();
  const space = useMemo(() => canvasSpace(storeApi), [storeApi]);
  // Dev only (GM r49): ?cursorStates=1 plays each state in turn for tuning.
  // Behind import.meta.env.DEV, so the production build drops the import and
  // its chunk (scripts/check-dev-only-code.mjs checks dist).
  useEffect(() => {
    if (import.meta.env.DEV) {
      if (!new URLSearchParams(window.location.search).has('cursorStates')) return undefined;
      let stop: (() => void) | null = null;
      let gone = false;
      void import('./agentCursorStatesDriver').then((driver) => {
        if (!gone) stop = driver.startCursorStatesDriver();
      });
      return () => {
        gone = true;
        stop?.();
      };
    }
    return undefined;
  }, []);

  return (
    <>
      <AgentCursorSurface
        agents={agents}
        everyone={everyone}
        space={space}
        zoom={zoom}
        inLayer={(layer) => <ViewportPortal>{layer}</ViewportPortal>}
      />
      <CanvasEdgeChips agents={agents} space={space} />
    </>
  );
}
