import { becauseLine, curlApostrophes, failedWhat } from './errorCopy';


/**
 * What a node's card says when its run failed (error copy round 3c, GM -
 * Design). GM: "the person reads these on the node, so their lines shouldn't
 * carry ids or record names. ... The node's error stores the specific text
 * for agents (and the run record and MCP keep it), and the canvas shows the
 * written line." And the guard for the rest: "provider run errors often carry
 * the one fact the person needs ("prompt was flagged", "out of credits",
 * "image too small"). Don't let the general fallback hide them. On a node
 * with no written line yet, show "Couldn’t run the node." with the general
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
 * Round 3f (GM): ""Couldn’t run the node." followed by "That didn't work."
 * says the same thing twice, and reloading doesn't fix a provider failure.
 * On node cards and the Cinema shot panel → "Run the node again. If it keeps
 * failing, Details shows what {Provider} said." With no provider: "Run the
 * node again. If it keeps failing, open Details."" The provider is the one
 * the run called (the ErrorEvent's `provider`, node data `errorProvider`,
 * from the route the backend took), never read from the error's text.
 */
export const RUN_NODE_HEADING = "Couldn’t run the node.";
/** The one heading over a run Nebula refused at its pre-call check (node
 * data `errorNotStarted`): the card's, as the Agent log's (GM, PR #203 r32:
 * "the card, bar and log share one heading"). A run that started and failed
 * keeps RUN_NODE_HEADING, and so does a start the backend answered with
 * another status (busy, say): markNodesErrored leaves `errorNotStarted` unset
 * there, and its toast keeps its own heading. */
export const RUN_NOT_STARTED_HEADING = 'Nebula couldn’t start the run.';
/** An agent's run stopped at a node only the person may run (the run's error
 * category "waiting": Idol's Hugging Face call with the person's token set).
 * A stop by design, not a failure: its own heading, in the notice style
 * (GM, PR #203 r39 item 1, verbatim). */
export const WAITING_HEADING = 'Waiting for you to run it';
/** The run's error category for that stop (backend engine, ProposalNeeded). */
export const WAITING_CATEGORY = 'waiting';
/** The Cinema shot panel's heading (GM, round 3f); the scene's card keeps RUN_NODE_HEADING. */
export const GENERATE_SHOT_HEADING = "Couldn’t generate the shot.";

/** Where a run error shows: a node's card, or the Cinema shot panel. */
export type NodeErrorSurface = 'node' | 'shot';

/** GM's general line on a card, by what is behind Details. Round 3g (GM):
 * the shot panel says "Generate it again." where a card says "Run it again.",
 * with the same provider (the shot output's errorProvider, only when that
 * provider answered). Error-copy round 5 (design): this follows "Nebula
 * couldn’t run the node." with no reason (none is known), so "it" is the node
 * and "Details" is the button's name. */
export function cardGeneralLine(provider: string | undefined, hasDetails: boolean, surface: NodeErrorSurface = 'node'): string {
  const again = surface === 'shot' ? 'Generate it again.' : 'Run it again.';
  if (!hasDetails) return again;
  const name = provider?.trim();
  return name
    ? `${again} If it keeps failing, “Details” shows what ${name} said.`
    : `${again} If it keeps failing, open “Details”.`;
}

/**
 * The classifier's categories as the clause after "because" (design, error-copy round 5: "Name the provider
 * wherever it's known. "The provider" is only the fallback."). The frontend has the provider's name where the line
 * is built (the ErrorEvent's `provider`, node data `errorProvider`), and the backend's `friendly` line says only
 * "the provider", so the line is made here from the category, never read from the classifier's text.
 */
export function categoryClause(category: string, provider: string | undefined): string | null {
  const name = provider?.trim();
  const who = name || 'the provider';
  const possessive = name ? `${name}’s` : 'the provider’s';
  switch (category) {
    case 'blocked': return `${possessive} safety filter blocked the request. Try rephrasing your prompt or removing flagged content.`;
    case 'auth': return name ? `${name} rejected the API key. Check your ${name} API key in Settings.`
      : 'the provider rejected the API key. Check your key for this provider in Settings.';
    case 'quota': return `${possessive} quota or credits are used up. Check your plan or billing with ${who}.`;
    case 'rate_limit': return `${who} is limiting requests. Wait a moment, then run it again.`;
    case 'timeout': return `${who} took too long to respond. Try again.`;
    case 'network': return `${who} isn’t answering. Check your connection, then try again.`;
    case 'invalid_input': return `${who} rejected the request as invalid. Check the node’s inputs and settings.`;
    default: return null;
  }
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
  /** Only a notice that isn't a failure has one ("Waiting for you to run it"); a failure is one sentence in `reason`. */
  heading: string;
  /** The line: "Nebula couldn’t run the node because OpenAI rejected the API key. Check your OpenAI API key in Settings." */
  reason: string;
  /** The raw text for the collapsed Details toggle; null for none. */
  details: string | null;
}

/** A failure to run as one line: the category's clause with the provider named, or the written line under the heading. */
function runLine(heading: string, reason: string, category: string | undefined, provider: string | undefined): string {
  const clause = category ? categoryClause(category, provider) : null;
  const what = failedWhat(heading);
  if (clause !== null && what !== null) return `Nebula couldn’t ${what} because ${clause}`;
  return becauseLine({ heading, reason });
}

export function nodeErrorCopy({ raw, category, friendly, person, providerText, provider, surface = 'node', notStarted = false,
  heading = category === WAITING_CATEGORY ? WAITING_HEADING
    : surface === 'shot' ? GENERATE_SHOT_HEADING : notStarted ? RUN_NOT_STARTED_HEADING : RUN_NODE_HEADING }: NodeErrorFields): NodeErrorCopy {
  const text = raw?.trim() ?? '';
  const line = person?.trim();
  // A stop that waits for the person is a notice, not a failure: its heading stays over its line.
  const waiting = category === WAITING_CATEGORY;
  const failure = (reason: string, details: string | null): NodeErrorCopy => (waiting
    ? { heading, reason, details }
    : { heading: '', reason: becauseLine({ heading, reason }), details });
  if (line) return failure(line, providerText && text && text !== line ? text : null);
  if (!category) return { heading: '', reason: becauseLine({ heading: '', reason: text || cardGeneralLine(provider, false, surface) }), details: null };
  // A named failure whose stored line was dropped (node_errors keeps no
  // hint equal to the error, e.g. a capability guardrail) reads its own text
  // after a reload, as the live event's line said.
  const named = category !== 'unknown' ? (friendly?.trim() || text) : '';
  if (named) {
    const details = text && text !== named ? text : null;
    // The category's clause stands in for the classifier's own generic line; a specific text (a capability
    // guardrail, whose line is the raw text itself) keeps its words.
    const classified = Boolean(friendly?.trim()) && friendly!.trim() !== text;
    if (waiting) return failure(named, details);
    // Such a text is the provider's or the check's own words, not a clause: it follows the action as its own sentence.
    const what = failedWhat(heading);
    if (!classified && what !== null) return { heading: '', reason: `Nebula couldn’t ${what}. ${curlApostrophes(named)}`, details };
    return { heading: '', reason: runLine(heading, named, classified ? category : undefined, provider), details };
  }
  return failure(cardGeneralLine(provider, Boolean(text), surface), text || null);
}
