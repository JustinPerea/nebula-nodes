import { useEffect, useId, useLayoutEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { getNodeDefinition } from '../../constants/nodeDefinitions';
import { unreadRingColor } from '../../lib/unreadRing';
import { useAgentPresenceStore } from '../../store/agentPresenceStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useAssetProposalsStore } from '../../store/assetProposalsStore';
import { useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { useGraphStore } from '../../store/graphStore';
import { AuthorDot } from './AgentNoteParts';
import {
  AGENTS_HEADING,
  buildRosterRows,
  NEEDS_YOU,
  NO_AGENTS,
  WORKING,
  type RosterCursor,
  type RosterNext,
  type RosterRow,
} from './agentRosterModel';
import { refreshAgentRoster, useAgentRosterStore } from './agentRosterStore';
import './agentRoster.css';

/** The "· 2 min ago" lines and the cursors' two minutes move on this often while it shows. */
const TICK_MS = 15_000;

/**
 * The Agents panel (Q125 item 2, Justin 2026-10-24: "Yes, all four, in that
 * order"), at the top of the opened Updates list. Collapsed it is one line:
 * "Agents", then "Needs you" and "Working" with how many agents are in each
 * (a group with none is left out; with no agents at all, so is the panel).
 * Open, it lists the two groups: Needs you (longest wait first) and Working
 * (most recent first). Only the person opens it: a new question never does.
 * Copy is GM - Design's, 2026-10-25.
 */
export function AgentRoster({
  projectId,
  onFlyTo,
  onOpen,
}: {
  projectId: string | null;
  /** A Working row: bring its node into view. */
  onFlyTo: (nodeId: string, color: string, anchor: HTMLElement) => void;
  /** A Needs-you row: open its oldest question set or proposal. */
  onOpen: (next: RosterNext, anchor: HTMLElement) => void;
}) {
  const expanded = useAgentRosterStore((s) => s.expanded);
  const setExpanded = useAgentRosterStore((s) => s.setExpanded);
  const statuses = useAgentRosterStore((s) => s.statuses);
  const readCursors = useAgentRosterStore((s) => s.cursors);
  const readAt = useAgentRosterStore((s) => s.readAt);
  const liveCursors = useAgentPresenceStore((s) => s.agents);
  const sets = useAgentQuestionsStore((s) => s.sets);
  const canvasProposals = useCanvasProposalsStore((s) => s.proposals);
  const assetProposals = useAssetProposalsStore((s) => s.proposals);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void refreshAgentRoster();
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Every cursor this tab knows: the read's, and the live ones heard since
  // (the read already reports any older one the backend still has).
  const cursors = useMemo(() => {
    const merged = new Map<string, RosterCursor>();
    for (const cursor of Object.values(readCursors)) merged.set(cursor.agent.id, cursor);
    for (const live of Object.values(liveCursors)) {
      if (live.receivedAt < readAt) continue;
      const cursor: RosterCursor = {
        agent: { id: live.id, name: live.name, color: live.color, verified: live.verified },
        nodeId: 'nodeId' in live.target ? live.target.nodeId : null,
        did: live.did,
        projectId: live.projectId,
        at: live.receivedAt,
      };
      const known = merged.get(live.id);
      if (!known || known.at <= cursor.at) merged.set(live.id, cursor);
    }
    return [...merged.values()];
  }, [readCursors, liveCursors, readAt]);

  // The names of the nodes the rows name, as one string so a drag elsewhere re-renders nothing.
  const named = useMemo(() => {
    const ids = new Set<string>();
    for (const status of Object.values(statuses)) if (status.nodeId) ids.add(status.nodeId);
    for (const cursor of cursors) {
      if (cursor.nodeId) ids.add(cursor.nodeId);
      if (cursor.did?.nodeId) ids.add(cursor.did.nodeId);
    }
    return [...ids];
  }, [statuses, cursors]);
  const labels = useGraphStore((s) => named.map((id) => {
    const node = s.nodes.find((n) => n.id === id);
    if (!node) return '';
    const data = node.data as { label?: unknown; definitionId?: unknown };
    const label = typeof data.label === 'string' && data.label ? data.label : null;
    const definitionId = typeof data.definitionId === 'string' ? data.definitionId : '';
    return label ?? getNodeDefinition(definitionId)?.displayName ?? (definitionId || id);
  }).join('\u0000'));

  const rows = useMemo(() => {
    const byId = new Map(named.map((id, index) => [id, labels.split('\u0000')[index] ?? ''] as const));
    return buildRosterRows({
      projectId,
      now,
      statuses: Object.values(statuses),
      cursors,
      questions: Object.values(sets).filter((entry) => entry.answerKey).map((entry) => entry.view),
      canvasProposals: Object.values(canvasProposals).filter((entry) => !entry.closing).map((entry) => entry.view),
      assetProposals: Object.values(assetProposals).filter((entry) => !entry.closing).map((entry) => entry.view),
      nodeLabel: (id) => byId.get(id) || null,
    });
  }, [projectId, now, statuses, cursors, sets, canvasProposals, assetProposals, named, labels]);

  // Opened with no agents around: the panel isn't there, so it isn't open.
  useLayoutEffect(() => {
    if (rows.length === 0 && useAgentRosterStore.getState().expanded) setExpanded(false);
    // Only when the list opens: the empty line is for the last agent leaving while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const headingId = useId();
  if (rows.length === 0 && !expanded) return null;

  const needsYou = rows.filter((row) => row.group === 'needsYou');
  const working = rows.filter((row) => row.group === 'working');
  // The attention colour the chip's unread ring uses, in the longest-waiting agent's colour.
  const attention = needsYou[0] ? unreadRingColor(needsYou[0].agent.color) : undefined;

  return (
    <section className="agent-roster" aria-labelledby={headingId}
      style={attention ? ({ '--ar-attention': attention } as CSSProperties) : undefined}>
      <h3 id={headingId} className="agent-roster__heading">
        <button type="button" className="agent-roster__toggle" aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}>
          <span className="agent-roster__title">{AGENTS_HEADING}</span>
          {needsYou.length > 0 && (
            <span className="agent-roster__group-count">
              {NEEDS_YOU}
              <span className="agent-roster__badge agent-roster__badge--attention">{needsYou.length}</span>
            </span>
          )}
          {working.length > 0 && (
            <span className="agent-roster__group-count">
              {WORKING}
              <span className="agent-roster__badge">{working.length}</span>
            </span>
          )}
          <span className="agent-roster__chevron" aria-hidden="true" />
        </button>
      </h3>
      {expanded && (
        <div className="agent-roster__body">
          {rows.length === 0 && <p className="agent-roster__empty">{NO_AGENTS}</p>}
          {needsYou.length > 0 && (
            <RosterGroup title={NEEDS_YOU} rows={needsYou} onFlyTo={onFlyTo} onOpen={onOpen} />
          )}
          {working.length > 0 && (
            <RosterGroup title={WORKING} rows={working} onFlyTo={onFlyTo} onOpen={onOpen} />
          )}
        </div>
      )}
    </section>
  );
}

function RosterGroup({ title, rows, onFlyTo, onOpen }: {
  title: string;
  rows: RosterRow[];
  onFlyTo: (nodeId: string, color: string, anchor: HTMLElement) => void;
  onOpen: (next: RosterNext, anchor: HTMLElement) => void;
}) {
  return (
    <div className="agent-roster__group">
      <h4 className="agent-roster__group-title">{title}</h4>
      <ul className="agent-roster__list">
        {rows.map((row) => (
          <li key={row.agent.id} className="agent-roster__item">
            <RosterRowView row={row} onFlyTo={onFlyTo} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RosterRowView({ row, onFlyTo, onOpen }: {
  row: RosterRow;
  onFlyTo: (nodeId: string, color: string, anchor: HTMLElement) => void;
  onOpen: (next: RosterNext, anchor: HTMLElement) => void;
}) {
  const lineId = useId();
  const needsYou = row.group === 'needsYou';
  const content = (
    <>
      <AuthorDot author={{ kind: 'agent', name: row.agent.name, color: row.agent.color }} verified={row.agent.verified} />
      <span className="agent-roster__text">
        <span className="agent-roster__name">{row.agent.name}</span>
        {needsYou && <span className="agent-roster__count">{row.countLine}</span>}
        {row.line && <span id={lineId} className="agent-roster__line" title={row.line}>{row.line}</span>}
      </span>
    </>
  );
  // A Working agent with no place on the canvas: a plain row, no tooltip.
  if (!row.tooltip || !row.ariaLabel) return <div className="agent-roster__row agent-roster__row--static">{content}</div>;
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (row.next) onOpen(row.next, event.currentTarget);
    else if (row.flyTo) onFlyTo(row.flyTo, row.agent.color, event.currentTarget);
  };
  return (
    <button type="button" className="agent-roster__row" data-group={row.group} title={row.tooltip}
      aria-label={row.ariaLabel} aria-describedby={needsYou && row.line ? lineId : undefined} onClick={click}>
      {content}
    </button>
  );
}
