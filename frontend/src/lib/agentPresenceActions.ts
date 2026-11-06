/** What an agent is doing at its cursor (GM - Design's cursor spec, §2), in
 * the backend's order (backend/services/cursor_actions.py). Its own module,
 * with no imports, so the presence store can read it in tests that mock
 * wsClient; wsClient re-exports both. */
export type AgentCursorAction =
  'move' | 'look' | 'think' | 'type' | 'click' | 'drag' | 'run' | 'propose' | 'wait' | 'error';

export const AGENT_CURSOR_ACTIONS: readonly AgentCursorAction[] =
  ['move', 'look', 'think', 'type', 'click', 'drag', 'run', 'propose', 'wait', 'error'];
