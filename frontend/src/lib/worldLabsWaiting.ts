import { headedLine, isNamedLine } from './errorCopy';
import { lastNodeLabel } from './lastNodeLabels';

/**
 * The backend's words when it refuses because a node holds World Labs state
 * (backend/main.py _paid_state_person), GM - Design's wording for round 13
 * of PR #114, verbatim, each under the screen's own "Couldn't <action>."
 * heading. Pinned equal to the backend by
 * backend/tests/test_error_copy_round3b.py. The canvas reads the
 * needs-check line and the recovery line's tail to know a delete refusal is
 * one GM worded for the canvas (deleteRefusalText).
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
/**
 * How a held node is named in the World Labs controls (GM - Design, round 14
 * of PR #114): its card title in quotes; for a record whose node left the
 * canvas, "“<last label>”, no longer on the canvas"; with no label known, "A
 * removed World Labs node" ("a ..." inside a sentence, `inSentence`).
 */
export const REMOVED_WORLD_LABS_NODE = 'A removed World Labs node';
export function recordNodeName(nodes: readonly { id: string; data?: { label?: unknown } }[], nodeId: string,
  inSentence = false): string {
  const label = nodes.find((node) => node.id === nodeId)?.data?.label;
  if (typeof label === 'string' && label.trim()) return `\u201c${label}\u201d`;
  const last = lastNodeLabel(nodeId);
  if (last) return `\u201c${last}\u201d, no longer on the canvas`;
  return inSentence ? 'a removed World Labs node' : REMOVED_WORLD_LABS_NODE;
}

/** The status bar button's accessible name for a held node; `name` from recordNodeName. */
export function unlockAriaLabel(name: string): string {
  return `I've checked Marble. Unlock ${name}.`;
}
/** The same button for a run Nebula couldn't confirm: there is no node to name (GM, round 14). */
export const UNLOCK_RUN_ARIA = "I've checked Marble. Unlock this World Labs run.";
/** "Forget ID"'s confirm, in the app's own dialog (GM, round 13). */
export function forgetHeading(name: string): string {
  return `Forget the recovery ID for ${name}?`;
}
/** Run History's "Forget ID" button's accessible name (GM, round 14); the row stays its description. */
export function forgetAriaLabel(name: string): string {
  return `Forget the recovery ID for ${name}`;
}
/** A Run History safeguard row: "“<node>” · Operation ID" or "· World ID", then the ID in mono (GM, round 14). */
export function recoveryIdLabel(existingWorldId: string | null): string {
  return existingWorldId ? 'World ID' : 'Operation ID';
}
export const FORGET_BODY = "Only do this after you've checked the run in Marble. Without the ID, Nebula can't stop you from paying for the same run twice.";

/** A node's card title, as the canvas shows it (its label), for GM's lines;
 * its id when it isn't on the canvas. */
export function cardTitle(nodes: readonly { id: string; data?: { label?: unknown } }[], nodeId: string): string {
  const label = nodes.find((node) => node.id === nodeId)?.data?.label;
  return typeof label === 'string' && label.trim() ? label : nodeId;
}

/** The recovery line as the canvas's held-delete notice says it (GM, round
 * 15 of PR #114: "Name the button if the line points to one (e.g. 'Forget
 * ID')"). The backend's own line (RECOVERY_ID_SAVED_TAIL) is unchanged. */
export const RECOVERY_ID_FORGET_TAIL = " has a saved World Labs recovery ID. Check the run in Marble, then use \u201cForget ID\u201d in Run History.";

/**
 * What the canvas notice says when it keeps nodes because one holds World
 * Labs state.
 *
 * One node (GM - Design, round 15 of PR #114, restoring what round 4's trim
 * dropped): "Couldn't delete “<node>”. <reason line>", the reason being the
 * shared World Labs line:
 * - unlock: "Couldn't delete “<node>”. A World Labs run needs your check
 *   first. Use the notice at the top of the screen."
 * - forget (GM, round 16: "It" when the node holding the ID is the one
 *   being deleted, its name when it's another; curly quotes on the button):
 *   "Couldn't delete “<node>”. It has a saved World Labs recovery ID. Check
 *   the run in Marble, then use “Forget ID” in Run History."
 * With no name known it reads "Couldn't delete the node." and "It has a
 * saved …".
 *
 * Several nodes (round 4b, unchanged), every line headed "Couldn't delete
 * them.":
 * - every one held: "They're waiting on World Labs. Check Marble, then unlock
 *   them."
 * - some held, {held} ≥ 2: "{held} are waiting on World Labs. Check Marble,
 *   then unlock them."
 * - one of them held: "One is waiting on World Labs. Check Marble, then
 *   unlock it."
 * - the forget forms with some held end "Check Marble, then use Run
 *   History."
 * - every one held, forget (GM, 2026-10-24): "Couldn't delete them. They're
 *   waiting on World Labs. Check Marble and Run History."
 *
 * `unlock`: a held node has an unconfirmed start (the status bar's "I've
 * checked Marble"); else a recovery record (Run History's "Forget ID"). `held`
 * is how many of the `count` nodes hold World Labs state; `name` the one
 * node's card title in quotes (recordNodeName).
 */
export function heldDeleteText(count: number, unlock: boolean, held = 1, name?: string): string {
  if (count === 1) {
    const heading = name ? `Couldn't delete ${name}.` : "Couldn't delete the node.";
    // GM, round 16: the reason says "It": a single node's delete is only ever
    // refused for that node's own World Labs state (round 17 removed the
    // never-passed parameter for naming another node).
    return unlock ? `${heading} ${WORLD_LABS_NEEDS_CHECK}` : `${heading} It${RECOVERY_ID_FORGET_TAIL}`;
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
export function deleteRefusalText(heading: string, count: number, reasons: readonly string[], name?: string): string {
  const heldCount = reasons.filter(isHeldReason).length;
  const unique = [...new Set(reasons)];
  const held = unique.filter(isHeldReason);
  if (held.length === 0) {
    // A reason that is a line of its own shows alone (GM, PR #198 r5 item 3).
    const named = unique.filter(isNamedLine);
    const plain = unique.filter((reason) => !isNamedLine(reason));
    return [...named, ...(plain.length > 0 || named.length === 0 ? [headedLine(heading, plain.join(' '))] : [])].join(' ');
  }
  const unlock = held.some(isUnlockReason);
  const others = unique.filter((reason) => !isHeldReason(reason));
  // One node: its name, from the caller or from the backend's recovery line.
  const forget = held.find(isForgetReason);
  // A node's delete is refused for that node's own state, so its line says
  // "It" (GM, round 16), whatever name the backend's line used (a renamed
  // card, or the definition's name).
  const named = name ?? (forget ? forget.slice(0, -RECOVERY_ID_SAVED_TAIL.length) : undefined);
  return [heldDeleteText(count, unlock, heldCount, named), ...others].join(' ');
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

/** GM, round 15 of PR #114: the status bar unlock's tooltip, and Forget ID's. */
export const UNLOCK_TITLE = "Only unlock after you've checked the run in Marble.";
export const FORGET_TITLE = "Check the run in Marble first. Once the ID is gone, Nebula won't block a new paid run.";
