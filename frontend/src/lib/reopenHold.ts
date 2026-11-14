/**
 * Why the person's reopen in place can't go yet, and the one table of lines
 * for it (review 19 item 1 and GM r32 on PR #199). This file is what the
 * entry chunk needs to read a verdict and place its line; the table of lines
 * itself is lib/reopenHoldLines.ts, loaded when a hold first arrives (review
 * 21 LOW-1, the entry chunk's budget).
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
 * forms inside the World Labs notice at the top, as its second line (GM r33,
 * 6; the notice holds "I’ve checked Marble"), the Forget ID form by Run
 * History, the others by Stop. The `params` form sits in the notice's box
 * too (alone, when nothing else holds): the node's settings can be off
 * screen. */
export type ReopenHoldPlace = 'stop' | 'worldLabsNotice' | 'runHistory';
export const REOPEN_HOLD_PLACES: Record<ReopenHoldState, ReopenHoldPlace> = {
  active: 'stop', ambiguity: 'worldLabsNotice', recovery: 'runHistory', params: 'worldLabsNotice',
  bootstrap: 'stop', run: 'stop', tabRun: 'stop', uncertain: 'worldLabsNotice',
};

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
