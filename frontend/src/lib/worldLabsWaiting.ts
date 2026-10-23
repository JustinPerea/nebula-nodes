/**
 * The backend's words when it refuses a delete or a run because a node holds
 * World Labs state (backend/main.py _paid_state_person, GM - Design, error
 * copy round 3: "This node is still waiting on World Labs. Check the job in
 * Marble, then {the node's actual button label} before you delete it."),
 * pinned equal by backend/tests/test_error_copy_round3b.py (round 3b). The
 * backend says them to the person (agents get the specific text), and they
 * stay word for word: the project screen still shows the canvas-wide unlock
 * line (projectStore worldLabsHold), and the canvas reads the two delete lines
 * to know a refusal is one GM trimmed (deleteRefusalText).
 */
export const NODE_WAITING_UNLOCK = "This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you delete it.";
export const NODE_WAITING_FORGET = "This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you delete it.";
export const SOME_NODE_WAITING_UNLOCK = "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you try again.";
export const SOME_NODE_WAITING_FORGET = "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you try again.";

/**
 * What the canvas notice says when it keeps nodes because one holds World
 * Labs state (GM - Design, round 4, "TRIMS to one line at 560 px"):
 * "Couldn't delete the node. It's waiting on World Labs. Check Marble, then
 * unlock it." The forget form: "Couldn't delete the node. It's waiting on
 * World Labs. Check Marble, then forget it in Run History." If that still
 * wraps, use "Couldn't delete it." as the heading. "Couldn't delete {n}
 * nodes. One is waiting on World Labs. Check Marble, then unlock it." (and
 * the same forget form).
 *
 * Measured live in the canvas notice's 12 px font at 560 px (round 4 notes):
 * the forget form wraps with "Couldn't delete the node." (543 px of text in
 * 504 px), so it takes GM's short heading (500 px). The forget form for
 * several nodes wraps too (557 px for 3 nodes), so it takes the same pattern,
 * "Couldn't delete them."; that one still wraps (540 px) and is listed for
 * GM. `unlock`: one held node has an unconfirmed start (the status bar's
 * "Checked Marble — unlock"); else a recovery record (Run History's
 * "Checked Marble — forget").
 *
 * `held` is how many of the `count` nodes hold World Labs state. GM's copy
 * covers one; with more held, "One is waiting" would be wrong, so the line
 * says "They're waiting" (every one held) or "{held} are waiting", then
 * "unlock them" / "forget them" (round 4 review; listed for GM). Measured at
 * 560 px, the counted heading wraps with "They're waiting … unlock them."
 * (507 px of text in 504 px for 2 nodes) and with "{held} are" at 3-digit
 * counts, so with more than one held every form takes the short heading,
 * "Couldn't delete them." (the same wrap rule; the unlock forms fit, at most
 * 490 px; the forget forms still wrap, like the one above).
 */
export function heldDeleteText(count: number, unlock: boolean, held = 1): string {
  if (count === 1) {
    return unlock ? "Couldn't delete the node. It's waiting on World Labs. Check Marble, then unlock it."
      : "Couldn't delete it. It's waiting on World Labs. Check Marble, then forget it in Run History.";
  }
  const heading = unlock && held <= 1 ? `Couldn't delete ${count} nodes.` : "Couldn't delete them.";
  return `${heading} ${heldSentence(count, unlock, held)}`;
}

/** GM's sentence for the held nodes, after the heading: "It's waiting …" for
 * one node, "One is waiting …" for one of several, and with more than one
 * held, "They're waiting …" (all of them) or "{held} are waiting …". */
function heldSentence(count: number, unlock: boolean, held: number): string {
  const one = count === 1 || held <= 1;
  const waiting = count === 1 ? "It's" : held <= 1 ? 'One is' : held >= count ? "They're" : `${held} are`;
  const it = one ? 'it' : 'them';
  return `${waiting} waiting on World Labs. Check Marble, then ${unlock ? `unlock ${it}.` : `forget ${it} in Run History.`}`;
}

const isHeldReason = (reason: string) => reason === NODE_WAITING_UNLOCK || reason === NODE_WAITING_FORGET;

/**
 * The canvas notice for deletes the backend refused, from the reasons it gave
 * (one per refused node) under `heading` ("Couldn't delete the node." /
 * "Couldn't delete {n} nodes."). The backend's two World Labs lines are the
 * ones GM trimmed: when every reason is one, the person reads GM's line
 * (heldDeleteText); among other reasons, GM's sentence takes their place and
 * the others are kept. Every other reason is the backend's, word for word,
 * each once. An unconfirmed start wins over a recovery record, as on the
 * canvas. The held nodes are counted before duplicates go (two held nodes
 * give the same line twice), so two of them read "They're waiting".
 */
export function deleteRefusalText(heading: string, count: number, reasons: readonly string[]): string {
  const heldCount = reasons.filter(isHeldReason).length;
  const unique = [...new Set(reasons)];
  const held = unique.filter(isHeldReason);
  if (held.length === 0) return `${heading} ${unique.join(' ')}`;
  const unlock = held.includes(NODE_WAITING_UNLOCK);
  if (held.length === unique.length) return heldDeleteText(count, unlock, heldCount);
  const others = unique.filter((reason) => !isHeldReason(reason));
  return `${heading} ${[heldSentence(count, unlock, heldCount), ...others].join(' ')}`;
}

/**
 * The status bar's lines for World Labs work Nebula holds (error copy round
 * 3c, GM - Design: "People never see the word "start"; they ran a World Labs
 * job. Status bar: "Paid start needs review." → "A World Labs run needs your
 * check." In its warnings ..., write "World Labs run" wherever they now say
 * "paid start". Keep the rest of each line.").
 */
export const WORLD_LABS_RUN_NEEDS_CHECK = 'A World Labs run needs your check.';
export const WORLD_LABS_RUN_STATUS_UNKNOWN = "Nebula can't tell if this World Labs run started.";
/** "N more node(s) also need your check.", after the first hold's line. */
export function moreNodesNeedCheck(more: number): string {
  return more === 1 ? '1 more node also needs your check.' : `${more} more nodes also need your check.`;
}
/** The warning under WORLD_LABS_RUN_STATUS_UNKNOWN: Nebula lost track of a
 * World Labs run it started, so Run stays locked until someone checks Marble. */
export const WORLD_LABS_STATUS_UNCERTAIN_WARNING =
  "Nebula couldn't confirm whether World Labs accepted this run, so the node stays locked to avoid paying twice. Check the job in Marble before you unlock it or run it again.";
