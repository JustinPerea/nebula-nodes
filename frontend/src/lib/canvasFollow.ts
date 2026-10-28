import { useSyncExternalStore } from 'react';

/**
 * Round 20 of PR #195 (review 19, M1; GM - Design's follow-up of 2026-10-27).
 * From the moment the tab sees an agent's project switch until the new
 * canvas is loaded, the canvas is read-only, as offline is in PR #114: every
 * edit is refused before it changes anything (graphStore's edit gate, a
 * file drop, Clear, Load graph), fields show disabled, and an attempt pulses
 * the project bar, at most once a second. Nothing is typed into a canvas
 * that's about to go away (probe A1); what the person had typed before the
 * switch goes into the handoff save (H1).
 *
 * GM's words, verbatim:
 * - The project bar: "Opening “<project>”…" (ellipsis character, no
 *   period), in place of the "Unsaved changes"/"Saved" state, without the
 *   bar changing width.
 * - Run is disabled, with the tooltip "Wait for “<project>” to open."
 * - A run press that gets through anyway (a keyboard shortcut, a race):
 *   "Couldn't run “<node>”. <agent> is opening “<project>”." No next step.
 */
export interface FollowingSwitch {
  /** The project the agent opened (or made). */
  projectName: string;
  /** The agent's name as presence shows it; null when it isn't known. */
  agent: string | null;
}

let following: FollowingSwitch | null = null;
const listeners = new Set<() => void>();

export function followingSwitch(): FollowingSwitch | null {
  return following;
}

export function setFollowingSwitch(next: FollowingSwitch | null): void {
  if (following === next) return;
  following = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeFollowingSwitch(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFollowingSwitch(): FollowingSwitch | null {
  return useSyncExternalStore(subscribeFollowingSwitch, followingSwitch, followingSwitch);
}

export const FOLLOW_PULSE_MS = 1_000;
const pulseListeners = new Set<() => void>();
let lastPulseAt = Number.NEGATIVE_INFINITY;

/** The project bar's nudge for a refused edit: at most once a second. */
export function pulseFollowing(now: number = Date.now()): boolean {
  if (now - lastPulseAt < FOLLOW_PULSE_MS) return false;
  lastPulseAt = now;
  for (const listener of [...pulseListeners]) listener();
  return true;
}

export function subscribeFollowPulse(listener: () => void): () => void {
  pulseListeners.add(listener);
  return () => { pulseListeners.delete(listener); };
}

/** The gate every edit asks: true (and the bar pulses) while the tab
 * follows an agent's switch, so the caller changes nothing and sends nothing. */
export function refuseEditWhileFollowing(): boolean {
  if (!following) return false;
  pulseFollowing();
  return true;
}

export function openingLine(project: string): string {
  return `Opening “${project}”…`;
}

/** The project bar's name while following (fix round 1 of PR #200, GM bug
 * 1): in full up to OPENING_NAME_MAX characters; a longer one is cut to
 * fit with "…" (the bar's title and label keep all of it). */
export const OPENING_NAME_MAX = 24;
export function openingName(project: string): string {
  const characters = [...project];
  return characters.length <= OPENING_NAME_MAX ? project : `${characters.slice(0, OPENING_NAME_MAX - 1).join('').trimEnd()}…`;
}

export function waitToOpenTooltip(project: string): string {
  return `Wait for “${project}” to open.`;
}

/** Who is opening what, after the action's own heading (GM round 21, G1:
 * "An agent is opening “<project>”." is fine; with no project known,
 * "Another project is opening.", never "Nebula is opening another project."
 * on its own). */
export function followingReason(switching: FollowingSwitch | null): string {
  if (!switching) return 'Another project is opening.';
  return `${switching.agent || 'An agent'} is opening “${switching.projectName}”.`;
}

/** GM's derived lines (round 21, confirmed): `node` names a one-node run;
 * `count` (2 or more) a run of several nodes ("Couldn't run <N> nodes.");
 * neither: a run of the whole canvas ("Couldn't run the canvas."). */
export function runWhileFollowingLine(node: string | null, agent: string | null, project: string, count?: number): string {
  const what = count !== undefined && count >= 2 ? `${count} nodes` : node === null ? 'the canvas' : `“${node}”`;
  return `Couldn't run ${what}. ${followingReason({ agent, projectName: project })}`;
}

/** Create's line while following (G1), in its normal error style: its own
 * heading (graphStore's GENERATE_HEADING) over followingReason. */
export const CREATE_WHILE_FOLLOWING_HEADING = "Couldn't start the generation.";
export function createWhileFollowingLine(switching: FollowingSwitch | null): string {
  return `${CREATE_WHILE_FOLLOWING_HEADING} ${followingReason(switching)}`;
}

/** Tests share one module: each starts from here. */
export function resetCanvasFollowForTests(): void {
  following = null;
  lastPulseAt = Number.NEGATIVE_INFINITY;
}
