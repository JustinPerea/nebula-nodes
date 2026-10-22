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
