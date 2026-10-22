/**
 * Why the canvas keeps a node that holds World Labs state, in the words the
 * backend's delete refusal uses (backend/main.py _paid_state_person, GM -
 * Design, error copy round 3: "This node is still waiting on World Labs.
 * Check the job in Marble, then {the node's actual button label} before you
 * delete it."). The canvas refuses these deletes itself, without a request,
 * so it can't read the backend's line; these are the same words, pinned equal
 * by backend/tests/test_error_copy_round3b.py (round 3b). Each names the
 * control that clears the state: the status bar's "Checked Marble — unlock"
 * for a start Nebula couldn't confirm, Run History's "Checked Marble —
 * forget" for a recovery record. Several nodes take the canvas-wide line.
 */
export const NODE_WAITING_UNLOCK = "This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you delete it.";
export const NODE_WAITING_FORGET = "This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you delete it.";
export const SOME_NODE_WAITING_UNLOCK = "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you try again.";
export const SOME_NODE_WAITING_FORGET = "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you try again.";

/** The line for deleting `count` nodes when one holds an unconfirmed start (`unlock`) or only a recovery record. */
export function waitingOnWorldLabs(count: number, unlock: boolean): string {
  if (count === 1) return unlock ? NODE_WAITING_UNLOCK : NODE_WAITING_FORGET;
  return unlock ? SOME_NODE_WAITING_UNLOCK : SOME_NODE_WAITING_FORGET;
}

/**
 * The status bar's lines for World Labs work Nebula holds (error copy round
 * 3c, GM - Design: "People never see the word "start"; they ran a World Labs
 * job. Status bar: "Paid start needs review." → "A World Labs run needs your
 * check." In its warnings ..., write "World Labs run" wherever they now say
 * "paid start". Keep the rest of each line.").
 */
export const WORLD_LABS_RUN_NEEDS_CHECK = 'A World Labs run needs your check.';
export const WORLD_LABS_RUN_STATUS_UNKNOWN = 'World Labs run status unknown.';
/** "N more node(s) also need your check.", after the first hold's line. */
export function moreNodesNeedCheck(more: number): string {
  return more === 1 ? '1 more node also needs your check.' : `${more} more nodes also need your check.`;
}
/** The warning under WORLD_LABS_RUN_STATUS_UNKNOWN: Nebula lost track of a
 * World Labs run it started, so Run stays locked until someone checks Marble. */
export const WORLD_LABS_STATUS_UNCERTAIN_WARNING =
  'Nebula could not confirm whether this World Labs run was accepted. Run remains locked to prevent duplicate paid work. Check Marble before clearing or retrying.';
