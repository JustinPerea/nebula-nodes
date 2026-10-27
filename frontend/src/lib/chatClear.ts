/**
 * Chat `/clear` (ChatPanel). The session is the tab's own and always clears;
 * the canvas clear is the backend's (DELETE /api/graph?force=true) and can be
 * refused (a run going) or go unanswered. GM's lines, one per answer (round 12
 * of PR #114). Clear is all or nothing (backend clear_graph empties the live
 * graph in one step), so there's no "may not be fully cleared" line.
 */
export const CHAT_CLEARED_CANVAS = 'Session cleared. Next message starts a fresh conversation with an empty canvas.';
export const CHAT_CLEARED_CANVAS_KEPT = "Session cleared. Next message starts a fresh conversation. The canvas wasn't cleared.";
export const CHAT_CLEARED_CANVAS_UNCONFIRMED =
  "Session cleared. Next message starts a fresh conversation. Nebula didn't confirm the canvas was cleared.";

/** How long /clear waits for the canvas clear's answer before saying Nebula
 * didn't confirm it. No other graph write has a bound to share: this is the
 * first, and generous (a clear is one synchronous step plus its broadcast). */
export const CHAT_CLEAR_ANSWER_MS = 15_000;
