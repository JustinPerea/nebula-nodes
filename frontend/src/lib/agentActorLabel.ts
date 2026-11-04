import { cursorLabel } from './agentCursorLabel';
import { useAgentPresenceStore } from '../store/agentPresenceStore';

/** Who wrote an edit, as a board write's `edit.actor` says (backend canvas_events.actor_for_headers). */
export interface EditActor {
  kind?: string;
  /** The agent's id (its runner, `ext:<slug>` or `app:<id>`): the one its cursor and Agent log rows carry. */
  id?: string;
  name?: string;
}

/**
 * The label a person line names an agent's edit by (#210 round 6q, GM r95.3):
 * the Agent log's and its cursor's, from the same source (cursorLabel over
 * the agent's name and session), so a line never names an agent another
 * way than the log does: "Claude Code", "Claude Code · 2". Never a raw name
 * and never "Claude (agent)".
 *
 * A board write carries the agent but not its session (sessions go only to
 * the person's tabs, in presence events). When the agent has one live cursor
 * here, that session made the edit, and its number is used as its log rows
 * show it; with none, or with several (which one wrote can't be told), the
 * agent's name alone, as the log names a session-less action.
 *
 * Null for anyone but a named agent: the person, an unnamed client, Nebula.
 */
export function agentActorLabel(actor: EditActor | null | undefined): string | null {
  if (actor?.kind !== 'agent') return null;
  const name = typeof actor.name === 'string' ? actor.name.trim() : '';
  if (!name) return null;
  const live = typeof actor.id === 'string'
    ? Object.values(useAgentPresenceStore.getState().agents).filter((cursor) => cursor.id === actor.id)
    : [];
  return live.length === 1 ? cursorLabel(live[0].name.trim() || name, live[0].session) : cursorLabel(name, null);
}
