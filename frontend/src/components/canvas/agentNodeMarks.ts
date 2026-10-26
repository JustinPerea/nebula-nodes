import type { RosterAgent, RosterRun, RosterStatus } from '../agent-notes/agentRosterModel';

/**
 * The agent's mark on a node (Q125 item 3), worked out from what the roster
 * store holds: each agent's status line (when it names a node) and the nodes
 * its runs are running now. Pure, so the rules are tested apart from the
 * layer that draws them (AgentNodeMarkLayer.tsx).
 *
 * GM - Design, 2026-10-25, verbatim: "For runs: “Running FLUX.2 [pro] ·
 * 0:41” (provider's model name; m:ss elapsed)." "Two or more agents on one
 * node: one full pill for the most recent agent, then a “+1” chip." "Below
 * 60%, collapse to the dot alone."
 */

export const LOW_ZOOM = 0.6;

/**
 * Below 60% only (GM, 2026-10-25: "at exactly 60% the full pill shows"),
 * read at the whole percent the toolbar shows (Toolbar.tsx rounds), so a
 * zoom React Flow holds as 0.5999… still counts as 60%.
 */
export function isLowZoom(zoom: number): boolean {
  return Math.round(zoom * 100) < LOW_ZOOM * 100;
}

/** A run's pill shows only once it has been going this long (GM: instant local runs never flash a pill). */
export const RUN_MARK_DELAY_MS = 1000;

/** m:ss, from milliseconds. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The chip after the most recent agent's pill: "+1", "+2". */
export function moreLabel(count: number): string {
  return `+${count}`;
}

export interface NodeMark {
  agent: RosterAgent;
  /** The status as the pill reads it, after the name. */
  text: string;
  kind: 'run' | 'status';
  /** When this began (the run's start, the status's set time), in this tab's clock. */
  since: number;
}

export interface MarksInput {
  projectId: string | null;
  now: number;
  statuses: RosterStatus[];
  runs: RosterRun[];
}

/**
 * Per node id, its marks, most recent first: one per agent, its run over
 * its status line (the run says more, and it ticks). Only the open
 * project's, and only marks on a node.
 */
export function marksByNode({ projectId, now, statuses, runs }: MarksInput): Map<string, NodeMark[]> {
  const byNode = new Map<string, Map<string, NodeMark>>();
  const put = (nodeId: string, mark: NodeMark) => {
    const marks = byNode.get(nodeId) ?? new Map<string, NodeMark>();
    byNode.set(nodeId, marks);
    const current = marks.get(mark.agent.id);
    if (current?.kind === 'run' && mark.kind === 'status') return;
    if (current?.kind === 'run' && mark.kind === 'run' && current.since <= mark.since) return;
    marks.set(mark.agent.id, mark);
  };
  for (const run of runs) {
    if (run.projectId !== projectId || now - run.at < RUN_MARK_DELAY_MS) continue;
    put(run.nodeId, {
      agent: run.agent, kind: 'run', since: run.at,
      text: `${run.model ? `Running ${run.model}` : 'Running'} · ${formatElapsed(now - run.at)}`,
    });
  }
  for (const status of statuses) {
    if (!status.nodeId || status.projectId !== projectId) continue;
    put(status.nodeId, { agent: status.agent, kind: 'status', since: status.at, text: status.text });
  }
  const result = new Map<string, NodeMark[]>();
  for (const [nodeId, marks] of byNode) {
    result.set(nodeId, [...marks.values()].sort((a, b) => b.since - a.since || a.agent.name.localeCompare(b.agent.name)));
  }
  return result;
}

/** The pill's tooltip, full text: "Codex · Running FLUX.2 [pro] · 0:41". */
export function markTitle(mark: Pick<NodeMark, 'agent' | 'text'>): string {
  return `${mark.agent.name} · ${mark.text}`;
}

/**
 * The pill's accessible name, in the Agents panel's "{agent}, {status}" form
 * (GM - Design, 2026-10-25, verbatim: "Codex, Writing the hero prompt";
 * an agent that named itself: "Codex, unverified, Writing the hero prompt").
 */
export function markLabel(mark: Pick<NodeMark, 'agent' | 'text'>): string {
  return `${mark.agent.name}, ${mark.agent.verified ? '' : 'unverified, '}${mark.text}`;
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * The "+N" chip's accessible name: the count, then each other agent as its
 * own sentence (GM, verbatim: "2 more agents. Codex, Writing the hero
 * prompt. Claude Code, Checking the crop."; "1 more agent." for one).
 */
export function othersLabel(marks: Array<Pick<NodeMark, 'agent' | 'text'>>): string {
  const count = `${marks.length} more ${marks.length === 1 ? 'agent' : 'agents'}.`;
  return [count, ...marks.map((mark) => sentence(markLabel(mark)))].join(' ');
}
