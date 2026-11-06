import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStoreApi, type Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import type { AgentCursor } from '../../store/agentPresenceStore';
import type { CursorSpace } from '../../lib/agentCursorSpace';
import { cursorLabel } from '../../lib/agentCursorLabel';
import { cursorSpringVars } from '../../lib/agentCursorSpringVars';
import { chipName, countName, planChips, type ChipCursor, type ChipPlan } from '../../lib/agentEdgeChips';
import { readChipView } from '../../lib/agentChipChrome';
import { panToTarget } from '../../lib/agentChipPress';
import '../../styles/agentEdgeChips.css';

/**
 * The canvas's edge chips (PR #233 slice 9; GM - Design 7 and 8): for a
 * canvas cursor off screen, a chip at the visible pane's edge (or just
 * outside the panel it is under) with its colour dot, name and a chevron
 * toward it. Pressing a chip pans the canvas to the cursor's target: the
 * person's action, and the only pan in the cursor code (lib/agentChipPress.ts;
 * tests/agentCursorNoOpen.test.ts). Nothing here moves the canvas on its own.
 *
 * Placement is lib/agentEdgeChips.ts (pure). It is worked out when the view
 * moves, the cursors change, the window resizes, and every `RECHECK_MS` while
 * a cursor is out there (a panel opened, closed or was dragged: panels have no
 * event to listen for). Drawn in a fixed box on the body, outside the canvas's
 * viewport, so it is in client px. The "+N" is a count, not a button: the
 * Agents panel lists everyone.
 */
const RECHECK_MS = 250;

export function CanvasEdgeChips({ agents, space }: { agents: Record<string, AgentCursor>; space: CursorSpace }) {
  const store = useStoreApi<Node<NodeData>>();
  const [plan, setPlan] = useState<ChipPlan>({ chips: [], counts: [] });
  const agentsRef = useRef(agents);
  const stopPan = useRef<(() => void) | null>(null);
  const planned = useRef('');

  // The pane's box is read when the view or the window moves, not on each recheck:
  // the recheck is for panels, which stand over the pane and don't change it.
  const paneBox = useRef<DOMRect | null>(null);
  const viewSeen = useRef<unknown>(undefined);
  const resized = useRef(true);

  const measure = useCallback((fresh = true, force = false) => {
    const paneEl = space.pane();
    // A moved view or a resize re-reads it; a node moving or a recheck does not.
    const view = space.viewKey();
    const moved = view !== viewSeen.current;
    viewSeen.current = view;
    if (force || fresh && (moved || resized.current) || !paneBox.current) {
      paneBox.current = paneEl?.getBoundingClientRect() ?? null;
      resized.current = false;
    }
    const rect = paneBox.current;
    if (!paneEl || !rect || rect.width <= 0 || rect.height <= 0) return null;
    const pane = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    const cursors: ChipCursor[] = [];
    for (const cursor of Object.values(agentsRef.current)) {
      const flow = space.resolve(cursor.target);
      const tip = flow && space.toClient(flow, rect);
      if (tip) {
        cursors.push({ key: cursor.key, label: cursorLabel(cursor.name, cursor.session), color: cursor.color, tip,
          activeAt: cursor.receivedAt });
      }
    }
    return { pane, cursors };
  }, [space]);

  const update = useCallback((fresh = true) => {
    const read = measure(fresh);
    const next = read ? planChips({ ...readChipView(read.pane), cursors: read.cursors }) : { chips: [], counts: [] };
    const signature = JSON.stringify(next);
    if (signature === planned.current) return;
    planned.current = signature;
    setPlan(next);
  }, [measure]);

  // Before the effect that plans (effects run in order), so it reads these agents.
  useEffect(() => { agentsRef.current = agents; }, [agents]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement: where the chips go depends on the panes' rendered boxes
  useEffect(() => { update(); }, [update, agents]);
  useEffect(() => {
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; update(); });
    };
    const unsubscribe = space.subscribe(schedule);
    const resize = () => { resized.current = true; schedule(); };
    window.addEventListener('resize', resize);
    const timer = window.setInterval(() => update(false), RECHECK_MS);
    return () => {
      unsubscribe();
      window.removeEventListener('resize', resize);
      window.clearInterval(timer);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [space, update]);
  useEffect(() => () => stopPan.current?.(), []);

  const press = useCallback((key: string) => {
    const cursor = agentsRef.current[key];
    const read = measure(true, true);
    const flow = cursor && space.resolve(cursor.target);
    if (!read || !flow) return;
    stopPan.current?.();
    stopPan.current = panToTarget({ target: flow, view: readChipView(read.pane).view, pane: read.pane, store });
  }, [measure, space, store]);

  const vars = useMemo(() => cursorSpringVars(), []);
  if (typeof document === 'undefined' || (plan.chips.length === 0 && plan.counts.length === 0)) return null;
  return createPortal(
    <div className="agent-edge-chips" style={vars}>
      {plan.chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className="agent-edge-chip"
          data-side={chip.side}
          aria-label={chipName(chip.label)}
          onClick={() => press(chip.key)}
          style={{ left: chip.box.left, top: chip.box.top, width: chip.box.width, height: chip.box.height,
            ['--agent-color' as string]: chip.color, ['--chip-angle' as string]: `${chip.angle}rad` }}
        >
          <span className="agent-edge-chip__dot" aria-hidden="true" />
          <span className="agent-edge-chip__name" aria-hidden="true">{chip.label}</span>
          <svg className="agent-edge-chip__chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <path d="M3 1.5 L7 5 L3 8.5" />
          </svg>
        </button>
      ))}
      {plan.counts.map((count) => (
        <span
          key={count.id}
          className="agent-edge-count"
          data-side={count.side}
          role="img"
          aria-label={countName(count.count)}
          style={{ left: count.box.left, top: count.box.top, width: count.box.width, height: count.box.height }}
        >{`+${count.count}`}</span>
      ))}
    </div>,
    document.body,
  );
}
