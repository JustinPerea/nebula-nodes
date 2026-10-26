import type { ExecutionValidationError } from './api';

/**
 * What a node's card says when the pre-run check stopped its run (error copy
 * round 3e, GM - Design). Each check's `message` is the specific text agents
 * keep word for word ("Missing API key: OPENAI_API_KEY"); `person` is the
 * line the card shows ("Add your OpenAI API key in Settings, then run the
 * node again."), written by the backend (ValidationErrorDetail.person).
 *
 * Several checks on one node read together, in order, each once: the
 * messages joined with "; " and the lines with a space, the way the
 * backend's node_errors keeps them, so the card reads the same after a
 * reload. A check with no line (only an agent or a damaged saved graph
 * reaches it) makes the node read GM's general line with every message
 * behind Details (category "unknown", as node_errors stores it).
 */
export interface ValidationReading {
  error: string;
  errorPerson?: string;
  errorCategory?: 'unknown';
}

/** A node in the run with nothing wrong of its own, while another has. */
export const OTHER_NODE_LINE = 'Nothing ran. Another node in this run needs a fix first.';
/** The refusal named no node (an older answer, or a replay with no errors). */
// Round 3f, GM's rule 8: "run again" → "then run the node again."
export const NOTHING_RAN_LINE = 'Nothing ran. Check the inputs and API keys, then run the node again.';

function reading(errors: Pick<ExecutionValidationError, 'message' | 'person'>[]): ValidationReading {
  const messages: string[] = [];
  const lines: string[] = [];
  let unlined = false;
  for (const error of errors) {
    if (messages.includes(error.message)) continue;
    messages.push(error.message);
    const line = typeof error.person === 'string' ? error.person.trim() : '';
    if (!line) unlined = true;
    else if (!lines.includes(line)) lines.push(line);
  }
  const error = messages.join('; ');
  return unlined || !lines.length ? { error, errorCategory: 'unknown' } : { error, errorPerson: lines.join(' ') };
}

/** A Cinema shot whose run the check refused, with no node named. */
export const SHOT_NOT_STARTED_LINE = "Nothing ran. Check the scene's inputs and API keys, then generate the shot again.";

/** A written line Nebula's canvas says itself: the heading over it, no Details. */
export function writtenReading(line: string): ValidationReading {
  return { error: line, errorPerson: line };
}

/** Each named node's reading, and the reading of the checks that name no node. */
export function validationReadings(errors: readonly ExecutionValidationError[] | undefined): {
  byNode: Map<string, ValidationReading>;
  global: ValidationReading | null;
} {
  const grouped = new Map<string, ExecutionValidationError[]>();
  for (const error of errors ?? []) {
    const key = error.nodeId ?? '';
    grouped.set(key, [...(grouped.get(key) ?? []), error]);
  }
  const byNode = new Map<string, ValidationReading>();
  let global: ValidationReading | null = null;
  for (const [nodeId, list] of grouped) {
    if (nodeId) byNode.set(nodeId, reading(list));
    else global = reading(list);
  }
  return { byNode, global };
}
