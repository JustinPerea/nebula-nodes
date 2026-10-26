/**
 * Placeholders: nodes an agent is still setting up (Q125 item 3; backend
 * services/pending_nodes.py). The backend keeps the flag on the node with
 * its owner and sends it as `data.pending`; only it changes one (an agent's
 * edit, its run, the idle rule, the person's edit or direct run). The canvas
 * draws it: a dashed outline in the agent's colour
 * (components/canvas/AgentNodeMarkLayer.tsx) and a line in the preview area.
 *
 * Copy is GM - Design's, 2026-10-25, verbatim.
 */

export interface PendingAgent {
  id: string;
  name: string;
  color: string;
  verified: boolean;
}

export interface PendingFlag {
  agent: PendingAgent;
  /** When it was marked (epoch ms). */
  at: number;
}

/** What a canvas run's reply says it skipped (backend pending_nodes.skip_summary). */
export interface PendingSkipSummary {
  count: number;
  agents: string[];
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;

/** A well-formed flag, or null: a malformed one draws a normal node. */
export function cleanPending(raw: unknown): PendingFlag | null {
  if (!raw || typeof raw !== 'object') return null;
  const flag = raw as Record<string, unknown>;
  const agent = flag.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent !== 'object') return null;
  if (typeof agent.id !== 'string' || !agent.id || typeof agent.name !== 'string' || !agent.name.trim()) return null;
  if (typeof agent.color !== 'string' || !SAFE_COLOR.test(agent.color)) return null;
  const at = typeof flag.at === 'number' && Number.isFinite(flag.at) && flag.at >= 0 ? flag.at : 0;
  return { agent: { id: agent.id, name: agent.name, color: agent.color, verified: agent.verified === true }, at };
}

/** A card root's `data-pending`: "true" for a well-formed placeholder flag, else absent. */
export function pendingAttr(pending: unknown): 'true' | undefined {
  return cleanPending(pending) ? 'true' : undefined;
}

/** The line in a placeholder's preview area (GM: "Codex is setting this up."). */
export function placeholderLine(agentName: string): string {
  return `${agentName} is setting this up.`;
}

/**
 * "{prefix} N node(s) {agent} is still setting up.": GM - Design's naming
 * rule, 2026-10-25: name the agent when every node belongs to one agent
 * (downstream nodes count toward the agent whose pending node blocked
 * them), "agents" only when they come from more than one.
 */
function placeholderCountLine(prefix: string, summary: PendingSkipSummary | null | undefined): string | null {
  if (!summary || !Number.isFinite(summary.count) || summary.count < 1) return null;
  const nodes = `${summary.count} ${summary.count === 1 ? 'node' : 'nodes'}`;
  const who = summary.agents.length === 1 && summary.agents[0] ? `${summary.agents[0]} is` : 'agents are';
  return `${prefix} ${nodes} ${who} still setting up.`;
}

/**
 * The line after Run when it skipped placeholders (GM, verbatim: "Skipped 1
 * node Codex is still setting up.", "Skipped 3 nodes Codex is still setting
 * up.", "Skipped 3 nodes agents are still setting up.", counting the nodes
 * downstream too).
 */
export function pendingSkipLine(summary: PendingSkipSummary | null | undefined): string | null {
  return placeholderCountLine('Skipped', summary);
}

/**
 * The line under the cost before the person's direct run of placeholders
 * (GM, verbatim: "Includes 2 nodes Codex is still setting up.", "Includes 3
 * nodes agents are still setting up."), counting the nodes downstream of
 * them that the run also makes run.
 */
export function pendingIncludedLine(summary: PendingSkipSummary | null | undefined): string | null {
  return placeholderCountLine('Includes', summary);
}

/** A node a run skips for a placeholder: whose, and which placeholder blocked it. */
export interface RunSkip {
  agent: PendingAgent;
  root: string;
}

/**
 * The nodes a run skips (backend pending_nodes.run_skips, mirrored so the
 * cost shown before Run prices what will run): each placeholder in `scope`
 * and every node in scope downstream of one, by wires inside the scope.
 * `ready` are placeholders the run turns normal (the person's direct run):
 * they count as normal. A downstream node counts toward the agent whose
 * placeholder reached it first, in scope order, as the backend's does.
 */
export function runSkips(
  scope: readonly string[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  pendingOf: (nodeId: string) => PendingFlag | null,
  ready: Iterable<string> = [],
): Map<string, RunSkip> {
  const ids = [...new Set(scope)];
  const allowed = new Set(ids);
  const madeReady = new Set(ready);
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    if (allowed.has(edge.source) && allowed.has(edge.target)) {
      out.set(edge.source, [...(out.get(edge.source) ?? []), edge.target]);
    }
  }
  const skips = new Map<string, RunSkip>();
  const queue: string[] = [];
  for (const id of ids) {
    const flag = madeReady.has(id) ? null : pendingOf(id);
    if (!flag) continue;
    skips.set(id, { agent: flag.agent, root: id });
    queue.push(id);
  }
  while (queue.length) {
    const current = queue.shift()!;
    const { agent, root } = skips.get(current)!;
    for (const child of out.get(current) ?? []) {
      if (skips.has(child)) continue;
      skips.set(child, { agent, root });
      queue.push(child);
    }
  }
  return skips;
}

/** How many nodes and whose (backend pending_nodes.skip_summary); null for none. */
export function skipSummaryOf(skips: ReadonlyMap<string, RunSkip>): PendingSkipSummary | null {
  if (skips.size === 0) return null;
  const agents: string[] = [];
  for (const { agent } of skips.values()) if (agent.name && !agents.includes(agent.name)) agents.push(agent.name);
  return { count: skips.size, agents };
}
