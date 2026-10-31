import { inDesktopShell } from './personSession';
import { runFinishesLine } from './useBackendOffline';
import { UNLOCK_LABEL } from './worldLabsWaiting';

/**
 * Why the person's reopen in place can't go yet, and the one table of lines
 * for it (review 19 item 1 and GM r32 on PR #199).
 *
 * The lock is Nebula's own verdict: the backend's replacement guard
 * (`_graph_replacement_hold`, read at GET /api/projects/open-hold and with
 * every listing) says which state would refuse the open. Its states are
 * listed once in backend/tests/data/replacement_hold_states.json, and a test
 * checks this table has a line for each. Two holds are the tab's own, which
 * Nebula can't see: this tab's run (uploads and Create's work among it,
 * `tabRun`) and a World Labs run whose status this tab lost (`uncertain`).
 */
export const OPEN_HOLD_STATES = ['active', 'ambiguity', 'recovery', 'params', 'bootstrap', 'run'] as const;
export type OpenHoldState = typeof OPEN_HOLD_STATES[number];

/** The backend's verdict (GET /api/projects/open-hold). `projectId` and
 * `projectName` are the project the held node belongs to, when Nebula
 * knows it (null when it can't tell). */
export interface OpenHold {
  state: OpenHoldState;
  nodeId: string | null;
  nodeName: string | null;
  projectId: string | null;
  projectName: string | null;
  count: number;
  fields: string[];
  detail?: string;
}

export type ReopenHold = OpenHold | { state: 'tabRun' } | { state: 'uncertain' };
export type ReopenHoldState = ReopenHold['state'];

/** Where the canvas line sits (GM r32, 2): by what clears it. The Marble
 * forms by the World Labs notice at the top (where "I've checked Marble" is),
 * the Forget ID form by Run History, the others by Stop. The `params` form
 * sits by the notice too: the node's settings can be off screen. */
export type ReopenHoldPlace = 'stop' | 'worldLabsNotice' | 'runHistory';
export const REOPEN_HOLD_PLACES: Record<ReopenHoldState, ReopenHoldPlace> = {
  active: 'stop', ambiguity: 'worldLabsNotice', recovery: 'runHistory', params: 'worldLabsNotice',
  bootstrap: 'stop', run: 'stop', tabRun: 'stop', uncertain: 'worldLabsNotice',
};

const quoted = (name: string) => `“${name}”`;
function fieldList(fields: string[]): string {
  const names = (fields.length > 0 ? fields : ['Resume Operation ID']).map(quoted);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** GM r32 (item 8): a node of the project being reopened is "its"; another
 * project's adds "from “Alpha”". `null` when Nebula couldn't tell whose it
 * is: then the line names the node only (the "for" form holds for any). */
function whose(hold: OpenHold, openId: string): 'its' | 'other' | 'unknown' {
  if (hold.projectId === openId) return 'its';
  return hold.projectId && hold.projectName ? 'other' : 'unknown';
}
/** " for “World” from “Alpha”", " for “World”", or "". */
function forNode(hold: OpenHold, openId: string): string {
  const node = hold.nodeName ? ` for ${quoted(hold.nodeName)}` : '';
  return whose(hold, openId) === 'other' ? `${node} from ${quoted(hold.projectName ?? '')}` : node;
}

/** The lock-shape line for each hold (GM r30 item 2, r31 item 1, r32 item 1),
 * under the card on Projects and on the canvas. `project` is the project's
 * name, `openId` its id. */
export function reopenHoldLine(project: string, openId: string, hold: ReopenHold,
  desktop: boolean = inDesktopShell()): string {
  const reopen = `You can reopen ${quoted(project)}`;
  switch (hold.state) {
    case 'run':
    case 'tabRun':
      return runFinishesLine(`reopen ${quoted(project)}`);
    case 'active':
      return `${reopen} when World Labs confirms the new run.`;
    case 'uncertain':
      return `${reopen} after you check its World Labs run in Marble and press “${UNLOCK_LABEL}”.`;
    case 'ambiguity':
      return whose(hold, openId) === 'its'
        ? `${reopen} after you check its World Labs run in Marble and press “${UNLOCK_LABEL}”.`
        : `${reopen} after you check the World Labs run${forNode(hold, openId)} in Marble and press “${UNLOCK_LABEL}”.`;
    case 'recovery':
      return hold.count >= 2
        ? `${reopen} after you forget ${hold.count} World Labs recovery IDs in Run History.`
        : `${reopen} after you forget the World Labs recovery ID${forNode(hold, openId)} in Run History.`;
    case 'params':
      return `${reopen} after you check the World Labs run${forNode(hold, openId)} in Marble and clear its ${fieldList(hold.fields)}.`;
    case 'bootstrap':
      return `Nebula couldn’t save its World Labs safeguards. ${reopen} after you ${desktop ? 'quit Nebula and open it again' : 'restart Nebula'}.`;
  }
}

/** A verdict from the wire, or null when it isn't one this tab can say. */
export function readOpenHold(raw: unknown): OpenHold | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!OPEN_HOLD_STATES.includes(value.state as OpenHoldState)) return null;
  const text = (key: string) => (typeof value[key] === 'string' && value[key] ? value[key] as string : null);
  return {
    state: value.state as OpenHoldState,
    nodeId: text('nodeId'), nodeName: text('nodeName'), projectId: text('projectId'), projectName: text('projectName'),
    count: typeof value.count === 'number' && Number.isFinite(value.count) ? value.count : 1,
    fields: Array.isArray(value.fields) ? value.fields.filter((field): field is string => typeof field === 'string' && field !== '') : [],
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
  };
}
