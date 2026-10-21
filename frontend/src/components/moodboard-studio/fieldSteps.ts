import type { BoardFieldKey } from '../../lib/moodboardEdits';

/**
 * Board fields as undo steps in Moodboard Studio (Q83). Justin: "A field
 * becomes one step when you leave it, and Cmd+Z inside a text box still
 * undoes your typing first."
 *
 * A step opens on a field's first change and closes when the field loses
 * focus (a text field) or the change is done (a slider let go, a colour
 * added, a switch clicked). Saves still go 600 ms after the last key, so a
 * step can span several PUTs; each PUT carries only one step's fields, and
 * its answer's `undo` (the server's `restore`, contract 07 1.12) joins that
 * step, the later first, as a card step's batches do (lib/boardUndo).
 *
 * The tracker knows which step each changed board field belongs to until the
 * change is on the server. Leaving a field as it was when the step opened,
 * or a step none of whose change ever reached the server (an outside edit
 * set the same value), leaves no step.
 */
export type FieldStep = 'name' | 'notes' | 'mode' | 'strength' | 'direction' | 'avoid' | 'pinnedColors'
  | 'clashMode' | 'colorChoices' | 'sendNotes' | 'briefOverride';

/** What the undo toast calls each field: "Undid: Direction". */
export const FIELD_STEP_LABELS: Record<FieldStep, string> = {
  name: 'Name', notes: 'Board notes', mode: 'Mode', strength: 'Strength', direction: 'Direction', avoid: 'Avoid',
  pinnedColors: 'Pinned colors', clashMode: 'Clash mode', colorChoices: 'Color choices',
  sendNotes: 'Send notes to generators', briefOverride: 'Your brief',
};

/** The board fields a step's change sets: a pin can take a colour off Keep anyway. */
export function fieldStepKeys(field: FieldStep): BoardFieldKey[] {
  return field === 'pinnedColors' ? ['pinnedColors', 'colorChoices'] : [field];
}

interface Session { stepId: string; start: string }

export interface FieldStepDeps {
  /** A new step in the undo queue, or null when steps can't be kept (a new board). */
  record: (label: string, keys: BoardFieldKey[]) => string | null;
  forget: (stepId: string) => void;
}

export class FieldStepTracker {
  /** The open step of each field (focus still in it, a slider still held). */
  private sessions = new Map<FieldStep, Session>();
  /** Which step each changed board field is for, until it is on the server. */
  private owners = new Map<BoardFieldKey, string>();
  /** Every step this tracker made that is still in the queue. */
  private steps = new Set<string>();
  /** Steps a PUT answered for with an undo. */
  private landedSteps = new Set<string>();
  /** Steps a PUT went out for (it may still be on its way). */
  private sentSteps = new Set<string>();
  /** Each step's values when it opened (its keys, in order). */
  private starts = new Map<string, unknown[]>();
  private deps: FieldStepDeps;

  constructor(deps: FieldStepDeps) {
    this.deps = deps;
  }

  /** Before `field` changes: opens its step, unless one is open. `values`
   *  is the draft's value of each of its keys before the change. */
  begin(field: FieldStep, values: unknown[]): void {
    if (this.sessions.has(field)) return;
    const keys = fieldStepKeys(field);
    const stepId = this.deps.record(FIELD_STEP_LABELS[field], keys);
    if (!stepId) return;
    this.steps.add(stepId);
    for (const key of keys) this.owners.set(key, stepId);
    this.sessions.set(field, { stepId, start: JSON.stringify(values) });
    this.starts.set(stepId, values);
    // An earlier step whose change was never sent and that now owns nothing
    // goes: the draft holds one value, sent once, with this one. One whose
    // PUT is on its way stays, to take that PUT's undo.
    this.dropEmpty(false);
  }

  /** The field lost focus, or the control's change is done: its step is
   *  closed. Back where it started, it is no step at all. Whether a step was open. */
  end(field: FieldStep, values: unknown[]): boolean {
    const session = this.sessions.get(field);
    if (!session) return false;
    this.sessions.delete(field);
    if (JSON.stringify(values) === session.start) this.drop(session.stepId);
    return true;
  }

  /** Close every open step (an undo is about to run). `read` gives a field's values now. */
  endAll(read: (field: FieldStep) => unknown[]): void {
    for (const field of [...this.sessions.keys()]) this.end(field, read(field));
  }

  /** A step no PUT ever went out for: its keys' values when it opened, so
   *  undoing it is putting those back in the draft (nothing of it is on the
   *  server). Undefined once a PUT for it went out. */
  unsentStart(stepId: string): unknown[] | undefined {
    return this.sentSteps.has(stepId) ? undefined : this.starts.get(stepId);
  }

  /** The step a changed board field's PUT is for, if any. */
  owner(key: BoardFieldKey): string | undefined {
    return this.owners.get(key);
  }

  /** A PUT for `stepId` is going out. */
  sending(stepId: string): void {
    if (this.steps.has(stepId)) this.sentSteps.add(stepId);
  }

  /** A PUT for `stepId` landed with an undo. */
  landed(stepId: string): void {
    if (this.steps.has(stepId)) this.landedSteps.add(stepId);
  }

  /** After a save: a closed step's fields that are on the server are no
   *  longer its to send, and a closed step that never got an undo (nothing
   *  of it reached the server, say an outside edit set the same value) goes.
   *  `unsent` says whether a board field still differs from the board as
   *  last read. No PUT is out then, so a step whose PUT changed nothing goes too. */
  settle(unsent: (key: BoardFieldKey) => boolean): void {
    for (const [key, stepId] of [...this.owners]) {
      if (!this.isOpen(stepId) && !unsent(key)) this.owners.delete(key);
    }
    this.dropEmpty(true);
  }

  /** The undo queue let go of a step (undone and replaced, a cleared history). */
  release(stepId: string): void {
    for (const [key, owner] of [...this.owners]) if (owner === stepId) this.owners.delete(key);
    for (const [field, session] of [...this.sessions]) if (session.stepId === stepId) this.sessions.delete(field);
    this.steps.delete(stepId);
    this.landedSteps.delete(stepId);
    this.sentSteps.delete(stepId);
    this.starts.delete(stepId);
  }

  reset(): void {
    this.sessions.clear();
    this.owners.clear();
    this.steps.clear();
    this.landedSteps.clear();
    this.sentSteps.clear();
    this.starts.clear();
  }

  private isOpen(stepId: string): boolean {
    return [...this.sessions.values()].some((session) => session.stepId === stepId);
  }

  /** Drop closed steps that own no field and got no undo (`settled`: also
   *  those whose PUT went out, since it has answered by then). */
  private dropEmpty(settled: boolean): void {
    const owning = new Set(this.owners.values());
    for (const stepId of [...this.steps]) {
      if (this.landedSteps.has(stepId) || owning.has(stepId) || this.isOpen(stepId)) continue;
      if (settled || !this.sentSteps.has(stepId)) this.drop(stepId);
    }
  }

  private drop(stepId: string): void {
    this.release(stepId);
    this.deps.forget(stepId);
  }
}

/** A PUT body cut into one body per step (in the order the steps own them),
 *  so each PUT's `undo` is one step's. Fields no step owns go in the first
 *  body, and so does `analysis` (sent only as null; no undo brings it back). */
export function fieldGroups(fields: Record<string, unknown>,
  owner: (key: BoardFieldKey) => string | undefined): Array<{ stepId: string | undefined; fields: Record<string, unknown> }> {
  const groups: Array<{ stepId: string | undefined; fields: Record<string, unknown> }> = [];
  const loose: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const stepId = key === 'analysis' ? undefined : owner(key as BoardFieldKey);
    if (stepId === undefined) {
      loose[key] = value;
      continue;
    }
    const group = groups.find((candidate) => candidate.stepId === stepId);
    if (group) group.fields[key] = value;
    else groups.push({ stepId, fields: { [key]: value } });
  }
  // Unowned fields other than the analysis are nobody's step: their own PUT.
  const { analysis, ...rest }: Record<string, unknown> = loose;
  const out = Object.keys(rest).length ? [{ stepId: undefined, fields: rest }, ...groups] : groups;
  if ('analysis' in loose) {
    if (out.length) out[0].fields.analysis = analysis;
    else out.push({ stepId: undefined, fields: { analysis } });
  }
  return out;
}
