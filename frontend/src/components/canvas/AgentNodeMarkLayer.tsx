import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useStore, ViewportPortal, type ReactFlowState } from '@xyflow/react';
import { cleanPending } from '../../lib/pendingNodes';
import { springCssVars } from '../../lib/springs';
import { useProjectStore } from '../../store/projectStore';
import { refreshAgentRoster, useAgentRosterStore } from '../agent-notes/agentRosterStore';
import { isLowZoom, markLabel, marksByNode, markTitle, moreLabel, othersLabel, type NodeMark } from './agentNodeMarks';
import { nodeCardBox, nodeMarkBox, type NodeBox } from './nodeCardBox';
import './agentNodeMarks.css';

/**
 * The agents on the canvas's nodes (Q125 item 3; Justin, 2026-10-24: "The
 * agent stays on the node it's working on ... A node an agent is about to
 * fill shows as a placeholder in its colour"). GM - Design's rulings,
 * 2026-10-25, built verbatim:
 *
 * - The mark: a pill just outside the node's top edge, left-aligned, 6 px
 *   gap, like a tab, so it never covers the header or the preview. The
 *   agent's dot (a ring when it named itself), its name, then the status:
 *   its status line on the node, or "Running FLUX.2 [pro] · 0:41" while a
 *   run it started is on the node. Truncated at the node's width; the full
 *   text in the tooltip. The node's outline doesn't change.
 * - Two or more agents: the most recent one's pill, then a "+1" chip;
 *   hovering or focusing the chip lists the others, one line each.
 * - A fixed size on screen at every zoom (GM, 2026-10-25: "like the cursor
 *   labels: always 22 px tall, never scaled with the canvas"), truncated at
 *   the node's on-screen width.
 * - Below 60% zoom: the dot alone, the same size on screen; name and status
 *   on hover (and on keyboard focus). The "+N" chip stays, so every agent
 *   on the node can still be found from the overview.
 * - The node's keyboard focus shows its pill's whole text at any zoom
 *   (review 3): the full-size pill is no tab stop of its own.
 * - Placeholders: a dashed outline in the owning agent's colour.
 *
 * Draws only what the socket and the roster read bring in, so it mounts at
 * once inside Canvas and is deferred (lib/deferredChunks.ts). It reads the
 * roster when it mounts, so a tab that loads mid-run has the marks.
 */

const zoomSelector = (state: ReactFlowState) => state.transform[2] || 1;

/** The placeholders on the canvas now, as "id|colour" lines (a stable string, so moves alone don't re-render). */
function pendingSelector(state: ReactFlowState): string {
  const lines: string[] = [];
  for (const [id, internal] of state.nodeLookup) {
    const flag = cleanPending((internal.data as Record<string, unknown> | undefined)?.pending);
    if (flag) lines.push(`${id}|${flag.agent.color}`);
  }
  return lines.join('\n');
}

function boxKey(box: NodeBox | null): string {
  return box ? `${box.x},${box.y},${box.width},${box.height}` : '';
}

function useBoxes(ids: string[], measure: typeof nodeMarkBox | typeof nodeCardBox): Map<string, NodeBox> {
  const key = useStore((state) => ids.map((id) => `${id}:${boxKey(measure(state, id))}`).join(';'));
  return useMemo(() => {
    const boxes = new Map<string, NodeBox>();
    for (const part of key ? key.split(';') : []) {
      const [id, raw] = part.split(':');
      if (!raw) continue;
      const [x, y, width, height] = raw.split(',').map(Number);
      boxes.set(id, { x, y, width, height });
    }
    return boxes;
  }, [key]);
}

/** Now, every second while any run's clock is shown. */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [ticking]);
  return now;
}

/**
 * The node that has keyboard focus now (React Flow's node, or a control in
 * it, reached from the keyboard), or null. At 60% zoom and up the pill takes
 * no focus (a tab stop on every node would be too many), so the node's own
 * keyboard focus shows the pill's whole text (review 3, finding 8). Keyboard
 * means a key was pressed since the last pointer press (review 4, L5), not
 * :focus-visible, which a text field clicked with the mouse matches too: a
 * pointer's focus changes nothing, typing in a field included. Below 60% the
 * pill's dot is a Tab stop, and its keyboard focus counts the same.
 */
function useKeyboardFocusedNode(): string | null {
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    let keyboard = false;
    const onKeyDown = () => { keyboard = true; };
    const onPointerDown = () => { keyboard = false; };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const node = target?.closest<HTMLElement>('.react-flow__node[data-id]');
      // Below 60% the dot is its own Tab stop: its keyboard focus shows the
      // whole status too, wrapping past 480 px (round 8: a status keeps a
      // long URL, with no space to wrap at, not 320 px and "…").
      const dot = target?.closest('.agent-node-mark__pill')?.closest<HTMLElement>('.agent-node-mark[data-node]');
      const id = node?.dataset.id ?? dot?.dataset.node ?? null;
      setFocused(keyboard ? id : null);
    };
    const onFocusOut = () => setFocused(null);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);
  return focused;
}

function Dot({ mark }: { mark: NodeMark }) {
  return <span className="agent-node-mark__dot" data-verified={String(mark.agent.verified)} aria-hidden="true" />;
}

function NodeMarkView({ nodeId, box, marks, zoom, focused }: {
  nodeId: string; box: NodeBox; marks: NodeMark[]; zoom: number; focused: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = marks;
  const collapsed = isLowZoom(zoom);
  // GM, 2026-10-25: a fixed screen size at every zoom, like the cursor labels
  // (counter-scaled by --anm-scale), truncated at the node's on-screen width.
  const style = {
    transform: `translate(${box.x}px, ${box.y}px)`,
    '--anm-max': `${box.width * zoom}px`,
    '--anm-scale': String(1 / zoom),
  } as CSSProperties;
  const show = () => setOpen(true);
  const hide = () => setOpen(false);
  return (
    <div className="agent-node-mark" data-node={nodeId} data-collapsed={collapsed ? 'true' : undefined}
      data-focused={focused ? 'true' : undefined} style={style}>
      <div className="agent-node-mark__row">
        <span
          className="agent-node-mark__pill"
          role="img"
          // Below 60% zoom the words show on hover or focus: the dot takes focus then.
          tabIndex={collapsed ? 0 : undefined}
          aria-label={markLabel(first)}
          title={markTitle(first)}
          style={{ '--anm-color': first.agent.color } as CSSProperties}
        >
          <Dot mark={first} />
          <span className="agent-node-mark__name">{first.agent.name}</span>
          <span className="agent-node-mark__status">{first.text}</span>
        </span>
        {rest.length > 0 && (
          <button
            type="button"
            className="agent-node-mark__more nodrag"
            aria-expanded={open ? 'true' : 'false'}
            aria-label={othersLabel(rest)}
            onFocus={show}
            onBlur={hide}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            {moreLabel(rest.length)}
          </button>
        )}
      </div>
      {open && rest.length > 0 && (
        <ul className="agent-node-mark__others">
          {rest.map((mark) => (
            <li key={mark.agent.id} className="agent-node-mark__other" title={markTitle(mark)}
              style={{ '--anm-color': mark.agent.color } as CSSProperties}>
              <Dot mark={mark} />
              <span className="agent-node-mark__name">{mark.agent.name}</span>
              <span className="agent-node-mark__status">{mark.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AgentNodeMarkLayer() {
  const zoom = useStore(zoomSelector);
  const projectId = useProjectStore((state) => state.activeProject?.id ?? null);
  const statuses = useAgentRosterStore((state) => state.statuses);
  const runs = useAgentRosterStore((state) => state.runs);
  const pendingLines = useStore(pendingSelector);
  const focusedNode = useKeyboardFocusedNode();

  // A tab that opens mid-run (or after a reload) reads who is on which node.
  useEffect(() => { void refreshAgentRoster(); }, []);

  const runList = useMemo(() => Object.values(runs).filter((run) => run.projectId === projectId), [runs, projectId]);
  const now = useClock(runList.length > 0);
  const marks = useMemo(
    () => marksByNode({ projectId, now, statuses: Object.values(statuses), runs: runList }),
    [projectId, now, statuses, runList],
  );
  const markedIds = useMemo(() => [...marks.keys()], [marks]);
  const markBoxes = useBoxes(markedIds, nodeMarkBox);

  const placeholders = useMemo(() => (pendingLines ? pendingLines.split('\n') : [])
    .map((line) => { const [id, color] = line.split('|'); return { id, color }; }), [pendingLines]);
  const placeholderIds = useMemo(() => placeholders.map((item) => item.id), [placeholders]);
  const placeholderBoxes = useBoxes(placeholderIds, nodeCardBox);

  const drawnMarks = markedIds.filter((id) => markBoxes.has(id));
  const drawnPlaceholders = placeholders.filter((item) => placeholderBoxes.has(item.id));
  if (drawnMarks.length === 0 && drawnPlaceholders.length === 0) return null;
  const style = { ...springCssVars(), '--anm-zoom': String(zoom) } as CSSProperties;
  return (
    <ViewportPortal>
      <div className="agent-node-marks" style={style}>
        {drawnPlaceholders.map(({ id, color }) => {
          const box = placeholderBoxes.get(id)!;
          return (
            <div key={`p-${id}`} className="agent-placeholder-outline" data-node={id} aria-hidden="true"
              style={{
                transform: `translate(${box.x}px, ${box.y}px)`, width: `${box.width}px`, height: `${box.height}px`,
                '--apo-color': color,
              } as CSSProperties} />
          );
        })}
        {drawnMarks.map((id) => (
          <NodeMarkView key={id} nodeId={id} box={markBoxes.get(id)!} marks={marks.get(id)!} zoom={zoom}
            focused={focusedNode === id} />
        ))}
      </div>
    </ViewportPortal>
  );
}
