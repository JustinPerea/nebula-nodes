/**
 * The cursor's default say lines (GM - Design's cursor spec, §2), every one
 * in this module: the line a cursor shows when the agent sends no say of
 * its own. The agent's own say always wins.
 *
 * Person copy, approved by GM in r54 (2026-11-03): short labels, sentence
 * case, no period, curly quotes around names, names through the shared
 * name-list helper (errorCopy nodeNameList), cut in the middle when the line
 * would pass the say cap. Display only: they never reach the Agent log or
 * the cursor's accessible name (the action is logged already).
 */
import type { AgentCursorAction } from './agentPresenceActions';
import { nodeNameList } from './errorCopy';
import { AGENT_CURSOR_ERROR_CAUSE_MS, AGENT_CURSOR_SAY_HOLD } from './agentCursorTuning';

/** A say's longest line (the backend's MAX_SAY_CHARS, agent_presence.py). */
export const AGENT_SAY_MAX_CHARS = 140;

/** What failed, for an error's line (GM r54 item 2). */
export type ErrorCause = 'run' | 'change' | null;

/** What the line can name. */
export interface SayContext {
  /** The node the cursor points at, by its card title; null for a spot. */
  node: string | null;
  /** drag: the node the wire starts from (null for a port-less spot or none). */
  from?: string | null;
  /** drag: whether the event has a start at all, so a wire is pulled. */
  pulled?: boolean;
  /**
   * type: what is being typed into. `text`, the card's free-text field (a
   * prompt); a `param` row, by its label as the card shows it; or null when
   * the card shows neither.
   */
  field?: { kind: 'text' } | { kind: 'param'; label: string } | null;
  /** error: what failed, when known (errorCause). */
  cause?: ErrorCause;
}

/** Cuts a name in the middle to `max` characters (whole code points). */
export function middleCut(name: string, max: number): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const room = Math.max(1, max - 1);
  const tail = Math.floor(room / 3);
  return `${chars.slice(0, room - tail).join('')}…${tail ? chars.slice(chars.length - tail).join('') : ''}`;
}

/** The line, with its names quoted by nodeNameList and cut in the middle,
 *  evenly, so the whole line fits AGENT_SAY_MAX_CHARS. */
function line(parts: TemplateStringsArray, ...names: string[]): string {
  const fixed = parts.reduce((n, p) => n + Array.from(p).length, 0) + names.length * 2; // two quotes each
  const each = Math.max(4, Math.floor((AGENT_SAY_MAX_CHARS - fixed) / Math.max(1, names.length)));
  return parts.reduce((out, p, i) => out + p + (i < names.length ? nodeNameList([middleCut(names[i], each)]) : ''), '');
}

/**
 * The default line for an action, or '' for none (move, click, a drag that
 * pulls no wire, and an action this tab doesn't know: a click's words are
 * the agent's).
 */
export function defaultSay(action: AgentCursorAction, { node, from = null, pulled = false, field = null, cause = null }: SayContext): string {
  switch (action) {
    case 'look':
      return node ? line`Looking at ${node}` : 'Looking here';
    case 'think':
      return 'Thinking';
    case 'type':
      if (field?.kind === 'param' && node) return line`Changing ${field.label} on ${node}`;
      if (field?.kind === 'param') return line`Changing ${field.label}`;
      return node ? line`Writing the prompt for ${node}` : 'Writing';
    case 'drag':
      if (from && node) return line`Connecting ${from} to ${node}`;
      if (node) return line`Connecting to ${node}`;
      // A drag to a spot is a wire only with a start (GM r54 item 3);
      // without one the cursor only moves there, so no line.
      return pulled ? 'Connecting' : '';
    case 'run':
      return node ? line`Started ${node}` : 'Started a run';
    case 'propose':
      return 'Waiting for your OK';
    case 'wait':
      return 'Waiting for your answer';
    case 'error':
      if (node && cause === 'run') return line`Couldn’t run ${node}`;
      if (node && cause === 'change') return line`Couldn’t change ${node}`;
      return 'Couldn’t do that';
    default:
      return '';
  }
}

/** The agent's last action verbs (backend main._did), by what an error after
 *  them failed at. */
const RUN_VERBS = new Set(['Ran', 'Tried to run']);
const CHANGE_VERBS = new Set(['Changed', 'Renamed', 'Added', 'Connected', 'Disconnected', 'Moved', 'Removed']);

/**
 * What an error failed at (GM r54 item 2), from the agent's last action as
 * the event carries it (`did`): a run or a change, when that action was on
 * the error's own node within AGENT_CURSOR_ERROR_CAUSE_MS; else unknown.
 */
export function errorCause(
  did: { verb: string; nodeId: string | null; at: number } | null,
  nodeId: string | null,
  at: number,
): ErrorCause {
  if (!did || !nodeId || did.nodeId !== nodeId || at - did.at > AGENT_CURSOR_ERROR_CAUSE_MS) return null;
  if (RUN_VERBS.has(did.verb)) return 'run';
  if (CHANGE_VERBS.has(did.verb)) return 'change';
  return null;
}

/** How long a say shows before its exit (GM r54): max(3 s, 60 ms ×
 *  characters), at most 8 s. */
export function sayHoldMs(say: string): number {
  const { minMs, perCharMs, maxMs } = AGENT_CURSOR_SAY_HOLD;
  return Math.min(maxMs, Math.max(minMs, perCharMs * Array.from(say).length));
}

/** A default line that holds as long as its state (GM r54): think while
 *  held, propose and wait until resolved. They have no timer of their own;
 *  the next event (or, for think, idle) ends them. look's sweep ends inside
 *  the normal hold, so look takes the normal hold. */
export function heldDefault(action: AgentCursorAction): boolean {
  return action === 'think' || action === 'propose' || action === 'wait';
}

/** Every template, with an example, for GM's review and the docs. */
export const DEFAULT_SAY_EXAMPLES: readonly { action: AgentCursorAction; when: string; line: string }[] = [
  { action: 'look', when: 'at a node', line: defaultSay('look', { node: 'Brief' }) },
  { action: 'look', when: 'at a spot', line: defaultSay('look', { node: null }) },
  { action: 'think', when: 'always', line: defaultSay('think', { node: null }) },
  { action: 'type', when: 'a free-text field, or no field known', line: defaultSay('type', { node: 'FLUX.2', field: { kind: 'text' } }) },
  { action: 'type', when: 'a param row (a port given)', line: defaultSay('type', { node: 'FLUX.2', field: { kind: 'param', label: 'Resolution' } }) },
  { action: 'type', when: 'at a spot', line: defaultSay('type', { node: null }) },
  { action: 'drag', when: 'node to node', line: defaultSay('drag', { node: 'FLUX.2', from: 'Brief', pulled: true }) },
  { action: 'drag', when: 'no source node', line: defaultSay('drag', { node: 'FLUX.2' }) },
  { action: 'drag', when: 'to a spot, pulling a wire', line: defaultSay('drag', { node: null, pulled: true }) },
  { action: 'run', when: 'at a node', line: defaultSay('run', { node: 'FLUX.2' }) },
  { action: 'run', when: 'at a spot', line: defaultSay('run', { node: null }) },
  { action: 'propose', when: 'always', line: defaultSay('propose', { node: null }) },
  { action: 'wait', when: 'always', line: defaultSay('wait', { node: null }) },
  { action: 'error', when: 'after a run', line: defaultSay('error', { node: 'FLUX.2', cause: 'run' }) },
  { action: 'error', when: 'after an edit or a connect', line: defaultSay('error', { node: 'FLUX.2', cause: 'change' }) },
  { action: 'error', when: 'unknown, or at a spot', line: defaultSay('error', { node: 'FLUX.2' }) },
];
