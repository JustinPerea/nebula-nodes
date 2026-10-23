import { REFUSED_FALLBACK_COPY } from './errorCopy';

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
 *   that line, and nothing else (the specific text is for agents);
 * - the backend's classifier named the failure (blocked, auth, quota, rate
 *   limit, timeout, network, invalid input): the heading over its line, the
 *   fact the person needs, with the raw text behind Details;
 * - any other run failure (category "unknown", or no line): the heading over
 *   GM's general line, the raw text behind Details;
 * - no category at all: a line Nebula wrote itself (a refused start, a
 *   pre-run check such as a missing key), shown as it is.
 */
export const RUN_NODE_HEADING = "Couldn't run the node.";

export interface NodeErrorFields {
  raw?: string;
  category?: string;
  friendly?: string;
  person?: string;
}

export interface NodeErrorCopy {
  heading: string;
  reason: string;
  /** The raw text for the collapsed Details toggle; null for none. */
  details: string | null;
}

export function nodeErrorCopy({ raw, category, friendly, person }: NodeErrorFields): NodeErrorCopy {
  const text = raw?.trim() ?? '';
  if (person?.trim()) return { heading: RUN_NODE_HEADING, reason: person.trim(), details: null };
  if (!category) return { heading: '', reason: text || REFUSED_FALLBACK_COPY, details: null };
  // A named failure whose stored line was dropped (node_errors keeps no
  // hint equal to the error, e.g. a capability guardrail) reads its own text
  // after a reload, as the live event's line said.
  const named = category !== 'unknown' ? (friendly?.trim() || text) : '';
  const reason = named || REFUSED_FALLBACK_COPY;
  return { heading: RUN_NODE_HEADING, reason, details: text && text !== reason ? text : null };
}
