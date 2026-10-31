
/**
 * What a node's card says when its run failed (error copy round 3c, GM -
 * Design). GM: "the person reads these on the node, so their lines shouldn't
 * carry ids or record names. ... The node's error stores the specific text
 * for agents (and the run record and MCP keep it), and the canvas shows the
 * written line." And the guard for the rest: "provider run errors often carry
 * the one fact the person needs ("prompt was flagged", "out of credits",
 * "image too small"). Don't let the general fallback hide them. On a node
 * with no written line yet, show "Couldn't run the node." with the general
 * line, and put the raw provider text behind the same collapsed "Details"
 * toggle used for Commons analysis."
 *
 * In order:
 * - the handler wrote the person's line (`errorPerson`): the heading over
 *   that line, and nothing else (the specific text is for agents), unless
 *   the line was written for a provider's answer (`providerText`, round 3d:
 *   "Meshy is busy. ...", Krea's refused input). GM: "Raw provider text
 *   stays behind Details in every case.", so that text goes behind Details;
 * - the backend's classifier named the failure (blocked, auth, quota, rate
 *   limit, timeout, network, invalid input): the heading over its line, the
 *   fact the person needs, with the raw text behind Details;
 * - any other run failure (category "unknown", or no line): the heading over
 *   GM's general line for a card, the raw text behind Details;
 * - no category at all: a line Nebula wrote itself (a refused start, a
 *   pre-run check such as a missing key), shown as it is.
 *
 * Round 3f (GM): ""Couldn't run the node." followed by "That didn't work."
 * says the same thing twice, and reloading doesn't fix a provider failure.
 * On node cards and the Cinema shot panel → "Run the node again. If it keeps
 * failing, Details shows what {Provider} said." With no provider: "Run the
 * node again. If it keeps failing, open Details."" The provider is the one
 * the run called (the ErrorEvent's `provider`, node data `errorProvider`,
 * from the route the backend took), never read from the error's text.
 */
export const RUN_NODE_HEADING = "Couldn't run the node.";
/** The one heading over a run Nebula refused before it started (the
 * pre-call check, or a start the backend answered with another status): the
 * card's, as the Agent log's (GM, PR #203 r32: "the card, bar and log share
 * one heading"). A run that started and failed keeps RUN_NODE_HEADING. */
export const RUN_NOT_STARTED_HEADING = 'Nebula couldn’t start the run.';
/** The Cinema shot panel's heading (GM, round 3f); the scene's card keeps RUN_NODE_HEADING. */
export const GENERATE_SHOT_HEADING = "Couldn't generate the shot.";

/** Where a run error shows: a node's card, or the Cinema shot panel. */
export type NodeErrorSurface = 'node' | 'shot';

/** GM's general line on a card, by what is behind Details. Round 3g (GM):
 * the shot panel says "Generate the shot again." where a card says "Run the
 * node again.", with the same provider (the shot output's errorProvider,
 * only when that provider answered). */
export function cardGeneralLine(provider: string | undefined, hasDetails: boolean, surface: NodeErrorSurface = 'node'): string {
  const again = surface === 'shot' ? 'Generate the shot again.' : 'Run the node again.';
  if (!hasDetails) return again;
  const name = provider?.trim();
  return name
    ? `${again} If it keeps failing, Details shows what ${name} said.`
    : `${again} If it keeps failing, open Details.`;
}

export interface NodeErrorFields {
  raw?: string;
  category?: string;
  friendly?: string;
  person?: string;
  /** The person's line was written for a provider's answer, whose own words
   * are in `raw` (round 3d). */
  providerText?: boolean;
  /** The provider the run called (round 3f): GM's general line names it. */
  provider?: string;
  /** Where it shows (round 3g): the shot panel's heading is GENERATE_SHOT_HEADING
   * and its general line says "Generate the shot again." */
  surface?: NodeErrorSurface;
  /** A heading other than the surface's own. */
  heading?: string;
  /** Nebula refused the run before it started (node data `errorNotStarted`):
   * a card's heading is RUN_NOT_STARTED_HEADING. */
  notStarted?: boolean;
}

export interface NodeErrorCopy {
  heading: string;
  reason: string;
  /** The raw text for the collapsed Details toggle; null for none. */
  details: string | null;
}

export function nodeErrorCopy({ raw, category, friendly, person, providerText, provider, surface = 'node', notStarted = false,
  heading = surface === 'shot' ? GENERATE_SHOT_HEADING : notStarted ? RUN_NOT_STARTED_HEADING : RUN_NODE_HEADING }: NodeErrorFields): NodeErrorCopy {
  const text = raw?.trim() ?? '';
  const line = person?.trim();
  if (line) {
    return { heading, reason: line, details: providerText && text && text !== line ? text : null };
  }
  if (!category) return { heading: '', reason: text || cardGeneralLine(provider, false, surface), details: null };
  // A named failure whose stored line was dropped (node_errors keeps no
  // hint equal to the error, e.g. a capability guardrail) reads its own text
  // after a reload, as the live event's line said.
  const named = category !== 'unknown' ? (friendly?.trim() || text) : '';
  if (named) return { heading, reason: named, details: text && text !== named ? text : null };
  return { heading, reason: cardGeneralLine(provider, Boolean(text), surface), details: text || null };
}
