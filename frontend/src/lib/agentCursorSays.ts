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
function compose(parts: readonly string[], names: readonly string[]): string {
  const fixed = parts.reduce((n, p) => n + Array.from(p).length, 0) + names.length * 2; // two quotes each
  const each = Math.max(4, Math.floor((AGENT_SAY_MAX_CHARS - fixed) / Math.max(1, names.length)));
  return parts.reduce((out, p, i) => out + p + (i < names.length ? nodeNameList([middleCut(names[i], each)]) : ''), '');
}

function line(parts: TemplateStringsArray, ...names: string[]): string {
  return compose(parts, names);
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

/** The words a moodboard control goes by in a line: the labels the Studio
 *  shows for it (a test pins each against the Studio's own source), in the
 *  backend's words too (cursor_actions.PART_LABELS). Phase 3, GM - Design
 *  r4 item 4. */
export const AGENT_SURFACE_PART_LABELS = {
  name: 'Name', direction: 'Direction', avoid: 'Avoid', colors: 'Colors', note: 'Note', weight: 'Weight',
} as const;

/** What a surface anchor's line can name. `board` is the board's name,
 *  `image` the image's number on it (both `anchorNames`, beside the anchor);
 *  `hasImage` says the item is an image (its id is in the anchor). */
export interface SurfaceSayContext {
  board: string | null;
  image?: number | null;
  hasImage: boolean;
  part?: string | null;
}

/**
 * The default line for a cursor on a moodboard item (GM - Design r4 item 4),
 * or null for none: the line a cursor shows when the agent sends no say of
 * its own (the agent's always wins; a board write's is the backend's "Added
 * …"). Display only, like every default here. Only `look`, `type` and
 * `click` have lines on a surface; every other action keeps its own
 * (`Thinking`, `Waiting for your OK`, ...: defaultSay with no node).
 */
export function surfaceSay(action: AgentCursorAction, { board, image = null, hasImage, part = null }: SurfaceSayContext): string | null {
  if (!board || (action !== 'look' && action !== 'type' && action !== 'click')) return null;
  const onImage = image !== null ? `image ${image}` : 'an image';
  const names = AGENT_SURFACE_PART_LABELS;
  if (action === 'look') {
    if (part === 'colors') return compose(['Looking at the colors of ', ''], [board]);
    return hasImage ? compose([`Looking at ${onImage} on `, ''], [board]) : compose(['Looking at ', ''], [board]);
  }
  switch (part) {
    case 'direction': return compose(['Writing the direction for ', ''], [board]);
    case 'avoid': return compose(['Changing ', ' on ', ''], [names.avoid, board]);
    case 'name': return compose(['Renaming ', ''], [board]);
    case 'colors': return compose(['Changing ', ' on ', ''], [names.colors, board]);
    case 'note': return `Writing a note on ${onImage}`;
    case 'weight': return `Changing \u201c${names.weight}\u201d on ${onImage}`;
    default: return compose(['Changing ', ''], [board]);
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

/** Every moodboard line, with its case, for GM's review and the docs
 *  (Phase 3, r4 item 4). */
export const SURFACE_SAY_EXAMPLES: readonly { action: AgentCursorAction; when: string; line: string }[] = ([
  ['look', 'a board', { board: 'Desert light', hasImage: false }],
  ['look', 'an image', { board: 'Desert light', image: 12, hasImage: true }],
  ['look', 'a board\u2019s colors (Analyze)', { board: 'Desert light', hasImage: false, part: 'colors' }],
  ['type', 'a board\u2019s Direction', { board: 'Desert light', hasImage: false, part: 'direction' }],
  ['type', 'a board\u2019s Avoid list', { board: 'Desert light', hasImage: false, part: 'avoid' }],
  ['type', 'a board\u2019s name', { board: 'Desert light', hasImage: false, part: 'name' }],
  ['click', 'a board\u2019s pinned colors', { board: 'Desert light', hasImage: false, part: 'colors' }],
  ['type', 'an image\u2019s note', { board: 'Desert light', image: 12, hasImage: true, part: 'note' }],
  ['click', 'an image\u2019s weight', { board: 'Desert light', image: 12, hasImage: true, part: 'weight' }],
  ['type', 'a board, no control known', { board: 'Desert light', hasImage: false }],
] as const).map(([action, when, context]) => ({ action, when, line: surfaceSay(action, context) ?? '' }));
