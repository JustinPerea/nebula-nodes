/**
 * The canvas kept in this tab after Nebula restored its project list (or an
 * agent's write closed the project the tab showed) before the tab's latest
 * edits were saved (GM r15 on PR #199, Q11; review 11, HIGH-1). The tab's
 * project and revision are gone from the backend, so every write would be
 * refused and a refused param save was put back: the typing was lost.
 *
 * While kept, nothing is sent and nothing is put back: the person can keep
 * typing (param edits stay on the canvas only), every other edit is refused
 * with a pulse of the kept line, and [Save as a project] files everything
 * typed up to the click (projectStore.saveKeptEdits). While that save is on
 * its way, typing is refused too, so nothing typed after the click is lost
 * when the saved project opens.
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

/** GM r16 on PR #199, 4: what a control disabled while the canvas is kept
 * says unlocks it. `other`: a control GM's list doesn't name (builder's). */
export type KeptAction = 'run' | 'duplicate' | 'delete' | 'note' | 'ask' | 'settings' | 'arrange' | 'other';
export const KEPT_LOCK_TITLES: Record<KeptAction, string> = {
  run: 'You can run this after you save it as a project.',
  duplicate: 'You can duplicate this after you save it as a project.',
  delete: 'You can delete this after you save it as a project.',
  note: 'You can add a note after you save it as a project.',
  ask: 'You can ask an agent about this after you save it as a project.',
  settings: 'You can change its settings after you save it as a project.',
  arrange: 'You can arrange this after you save it as a project.',
  other: 'You can do this after you save it as a project.',
};

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
