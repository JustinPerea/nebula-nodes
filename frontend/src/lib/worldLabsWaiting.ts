/**
 * The backend's words when it refuses because a node holds World Labs state
 * (backend/main.py _paid_state_person), GM - Design's wording for round 13
 * of PR #114, verbatim, each under the screen's own "Couldn't <action>."
 * heading. Pinned equal to the backend by
 * backend/tests/test_error_copy_round3b.py. The canvas reads the
 * needs-check line and the recovery line's tail to know a delete refusal is
 * one GM trimmed (deleteRefusalText).
 */
/** A start still in flight. */
export const WORLD_LABS_STARTING = "A World Labs run is still starting. Try again in a moment.";
/** An unconfirmed start, or a run this tab couldn't confirm: the status
 * bar's "I've checked Marble". The Projects screen's own check says it too
 * (projectStore worldLabsHold). */
export const WORLD_LABS_NEEDS_CHECK = "A World Labs run needs your check first. Use the notice at the top of the screen.";
/** A saved recovery ID: "“<node>”" and then this (Run History's "Forget ID"). */
export const RECOVERY_ID_SAVED_TAIL = " has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History.";

/** The status bar's button and Run History's (GM, round 13 of PR #114). */
export const UNLOCK_LABEL = "I've checked Marble";
export const FORGET_LABEL = 'Forget ID';
/** The status bar button's accessible name for a held node. */
export function unlockAriaLabel(node: string): string {
  return `I've checked Marble. Unlock \u201c${node}\u201d.`;
}
/** "Forget ID"'s confirm, in the app's own dialog (GM, round 13). */
export function forgetHeading(node: string): string {
  return `Forget the recovery ID for \u201c${node}\u201d?`;
}
export const FORGET_BODY = "Only do this after you've checked the run in Marble. Without the ID, Nebula can't stop you from paying for the same run twice.";

/** A node's card title, as the canvas shows it (its label), for GM's lines;
 * its id when it isn't on the canvas. */
export function cardTitle(nodes: readonly { id: string; data?: { label?: unknown } }[], nodeId: string): string {
  const label = nodes.find((node) => node.id === nodeId)?.data?.label;
  return typeof label === 'string' && label.trim() ? label : nodeId;
}

/**
 * What the canvas notice says when it keeps nodes because one holds World
 * Labs state (GM - Design, round 4, "TRIMS to one line at 560 px", and round
 * 4b, its answers on #181).
 *
 * One node (round 4; round 4b: "The one-node fallback is fine as measured"):
 * - unlock: "Couldn't delete the node. It's waiting on World Labs. Check
 *   Marble, then unlock it."
 * - forget: "Couldn't delete it. It's waiting on World Labs. Check Marble,
 *   then forget it in Run History." (GM's fallback heading: the full one
 *   wraps at 560 px.)
 *
 * Several nodes (round 4b), every line headed "Couldn't delete them.":
 * - every one held: "They're waiting on World Labs. Check Marble, then unlock
 *   them."
 * - some held, {held} ≥ 2: "{held} are waiting on World Labs. Check Marble,
 *   then unlock them."
 * - one of them held: "One is waiting on World Labs. Check Marble, then
 *   unlock it." (GM's newest line; it replaces round 4's counted "Couldn't
 *   delete {n} nodes. One is waiting …").
 * - the forget forms with some held end "Check Marble, then use Run
 *   History." (GM: "Use the same tail on every forget form that wraps, so
 *   the single-node one stays as it is.").
 * - every one held, forget (GM, 2026-10-24): "Couldn't delete them. They're
 *   waiting on World Labs. Check Marble and Run History."
 *
 * `unlock`: a held node has an unconfirmed start (the status bar's "I've
 * checked Marble"); else a recovery record (Run History's "Forget ID"). `held` is how many of the `count` nodes hold World Labs state.
 */
export function heldDeleteText(count: number, unlock: boolean, held = 1): string {
  if (count === 1) {
    return unlock ? "Couldn't delete the node. It's waiting on World Labs. Check Marble, then unlock it."
      : "Couldn't delete it. It's waiting on World Labs. Check Marble, then forget it in Run History.";
  }
  if (!unlock && held >= count) {
    return "Couldn't delete them. They're waiting on World Labs. Check Marble and Run History.";
  }
  const waiting = held <= 1 ? 'One is' : held >= count ? "They're" : `${held} are`;
  const then = unlock ? `unlock ${held <= 1 ? 'it' : 'them'}.` : 'use Run History.';
  return `Couldn't delete them. ${waiting} waiting on World Labs. Check Marble, then ${then}`;
}

const isUnlockReason = (reason: string) => reason === WORLD_LABS_NEEDS_CHECK;
const isForgetReason = (reason: string) => reason.startsWith('\u201c') && reason.endsWith(RECOVERY_ID_SAVED_TAIL);
const isHeldReason = (reason: string) => isUnlockReason(reason) || isForgetReason(reason);

/**
 * The canvas notice for deletes the backend refused, from the reasons it gave
 * (one per refused node) under `heading` ("Couldn't delete the node." /
 * "Couldn't delete {n} nodes."). The backend's two World Labs lines are the
 * ones GM trimmed: when any reason is one, the person reads GM's line
 * (heldDeleteText), the same words the canvas's own refusal uses, and any
 * other reasons follow it, each once, word for word. So a held node among
 * other reasons also reads "Couldn't delete them. One is waiting …" (round
 * 4b: GM's lines for several nodes all drop the count; one heading for the
 * held sentence wherever it shows). With no held node, `heading` and the
 * backend's reasons as given. An unconfirmed start wins over a recovery
 * record, as on the canvas. The held nodes are counted before duplicates go
 * (two held nodes give the same line twice), so two of them read "They're
 * waiting".
 */
export function deleteRefusalText(heading: string, count: number, reasons: readonly string[]): string {
  const heldCount = reasons.filter(isHeldReason).length;
  const unique = [...new Set(reasons)];
  const held = unique.filter(isHeldReason);
  if (held.length === 0) return `${heading} ${unique.join(' ')}`;
  const unlock = held.some(isUnlockReason);
  const others = unique.filter((reason) => !isHeldReason(reason));
  return [heldDeleteText(count, unlock, heldCount), ...others].join(' ');
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
