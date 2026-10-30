/**
 * The canvas kept in this tab after Nebula restored its project list (or an
 * agent's write closed the project the tab showed) before the tab's latest
 * edits were saved (GM r15 on PR #199, Q11; review 11, HIGH-1). The tab's
 * project and revision are gone from the backend, so every write would be
 * refused and a refused param save was put back: the typing was lost.
 *
 * While kept, nothing is sent and nothing is put back: the person can keep
 * typing (param edits stay on the canvas only) and, GM r18 (Q3), use the tab
 * as a scratch canvas: move, delete, duplicate, Arrange, Clear canvas, and
 * Undo and Redo over those steps only (graphStore's KeptStep). Every edit
 * that needs Nebula (a run, an add, a connection, agents) is refused with a
 * pulse of the kept line, and [Save as a project] files the canvas as it is
 * at the click (projectStore.saveKeptEdits). While that save is on its way,
 * every edit is refused too, so nothing done after the click is lost when
 * the saved project opens.
 */

import { useSyncExternalStore } from 'react';

let kept = false;
let saving = false;
const pulseListeners = new Set<() => void>();
const keptListeners = new Set<() => void>();
let lastPulseAt = 0;
const KEPT_PULSE_MS = 1000;

export function isCanvasKept(): boolean {
  return kept;
}

/** Typing joins the kept edits; refused only while their save is on its way. */
export function keptCanvasTakesTyping(): boolean {
  return kept && !saving;
}

export function setCanvasKept(value: boolean): void {
  const changed = kept !== value;
  kept = value;
  if (!value) saving = false;
  if (changed) for (const listener of [...keptListeners]) listener();
}

export function subscribeKeptCanvas(listener: () => void): () => void {
  keptListeners.add(listener);
  return () => { keptListeners.delete(listener); };
}

/** Whether the canvas is kept, for a component (GM r16 on PR #199, 4: the
 * controls that write or spend show disabled while it is). */
export function useKeptCanvas(): boolean {
  return useSyncExternalStore(subscribeKeptCanvas, isCanvasKept, isCanvasKept);
}

/** GM r16 and r17 on PR #199: what a control disabled while the canvas is
 * kept says unlocks it, one line per control. `other` is only a safety net
 * nobody should see: every control names its own (canvasLock's `act` takes
 * a `kept` for each, and a test walks the sources). */
// GM r18 (Q3): delete, arrange, clear and undo are the kept tab's own now
// (live, no line), as duplicate and settings became in r17.
// GM r19 (2): Forget ID has its own verb. GM r20: the routes that replace
// the canvas (Projects, another project, a new one, Load, Import) name both
// ways out, since discarding the kept edits unlocks them too.
export type KeptAction = 'run' | 'note' | 'ask' | 'settings'
  | 'add-node' | 'next-step' | 'rewrite' | 'load' | 'import' | 'proposal' | 'unlock' | 'forget'
  | 'home' | 'open' | 'create'
  | 'edit-video' | 'generate' | 'scene' | 'other';
const KEPT_LINES: Record<Exclude<KeptAction, 'ask'>, string> = {
  run: 'You can run this after you save it as a project.',
  // GM r17, Q2, verbatim.
  note: 'You can add notes after you save it as a project.',
  settings: 'You can change settings after you save it as a project.',
  // The builder's, in GM's form (GM r18, Q1: the pattern stays).
  'add-node': 'You can add nodes after you save it as a project.',
  'next-step': 'You can add a next step after you save it as a project.',
  rewrite: 'You can rewrite the prompt after you save it as a project.',
  // GM r20: a route that replaces the canvas names both ways out, each
  // in its control's own verb.
  load: 'You can load a graph after you save it as a project or discard the kept edits.',
  import: 'You can import a graph after you save it as a project or discard the kept edits.',
  home: 'You can go to Projects after you save it as a project or discard the kept edits.',
  open: 'You can open another project after you save it as a project or discard the kept edits.',
  create: 'You can create a project after you save it as a project or discard the kept edits.',
  proposal: 'You can answer proposals after you save it as a project.',
  // GM r18, Q1, verbatim.
  unlock: 'You can unlock nodes after you save it as a project.',
  // GM r19, 2, verbatim: Forget ID's own verb (it writes the node's recovery).
  forget: 'You can forget the ID after you save it as a project.',
  'edit-video': 'You can edit the video after you save it as a project.',
  // The verb of the buttons it covers ("Generate", "Generate all"): GM r18, Q1.
  generate: 'You can generate after you save it as a project.',
  scene: 'You can change the scene after you save it as a project.',
  other: 'You can do this after you save it as a project.',
};

/** The agent the chat talks to (ChatPanel's saved choice): Ask's line names
 * it, unquoted (GM r18, Q2: product names). "your agent" when none is
 * picked, or for a personal agent. */
export function keptAskAgentName(): string {
  try {
    const saved = JSON.parse(window.localStorage.getItem('nebula:chat-selection') || 'null') as { agent?: unknown } | null;
    if (saved?.agent === 'codex') return 'Codex';
    if (saved?.agent === 'claude') return 'Claude';
  } catch { /* none picked */ }
  return 'your agent';
}

/** A kept control's tooltip (GM r17, Q2). */
export function keptLockTitle(action: KeptAction): string {
  if (action === 'ask') return `You can ask ${keptAskAgentName()} after you save it as a project.`;
  return KEPT_LINES[action];
}

/** The generic line, for the test that no visible control shows it. */
export const KEPT_GENERIC_LINE = KEPT_LINES.other;

/** How the kept tab clears its canvas (graphStore's clearKeptCanvas, which
 * registers itself here, as setReplacedCanvasKeeper does), so the bottom
 * bar's Clear reaches it without importing the store's kept history. */
let keptClearer: (() => boolean) | null = null;
export function setKeptCanvasClearer(clear: () => boolean): void { keptClearer = clear; }
/** Clear canvas while kept (GM r18 on PR #199, Q3): one step on this tab
 * that Undo brings back; nothing is sent. False when nothing was cleared. */
export function clearKeptTab(): boolean { return keptClearer ? keptClearer() : false; }

export function setKeptCanvasSaving(value: boolean): void {
  saving = kept && value;
}

/** The kept line's nudge for a refused edit: at most once a second. */
export function pulseKeptCanvas(now: number = Date.now()): boolean {
  if (now - lastPulseAt < KEPT_PULSE_MS) return false;
  lastPulseAt = now;
  for (const listener of [...pulseListeners]) listener();
  return true;
}

export function subscribeKeptPulse(listener: () => void): () => void {
  pulseListeners.add(listener);
  return () => { pulseListeners.delete(listener); };
}

/** The gate an edit asks while the canvas is kept: true (and the line
 * pulses) when the edit can't be taken. */
export function refuseEditWhileKept(): boolean {
  if (!kept) return false;
  pulseKeptCanvas();
  return true;
}

export function resetKeptCanvasForTests(): void {
  if (kept) setCanvasKept(false);
  kept = false;
  saving = false;
  lastPulseAt = 0;
}
