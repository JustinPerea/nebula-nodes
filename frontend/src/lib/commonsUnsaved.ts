import type { StateCreator } from 'zustand';
import { writtenLine } from './errorCopy';

/**
 * Whether the Commons holds unsaved work: Blind labeling or Agent review has
 * unsaved labels, or is saving them, or Agent review is grading (the panels'
 * onWork, components/commons/commonsLeave.ts). CommonsView publishes it here
 * so nothing takes the person out of the Commons without asking. A plain
 * module, not a store field: nothing renders from it.
 *
 * The stores read it where a view would be left (commons-exits, 2026-10-22):
 * App unmounts CommonsView, and its labels with it, as soon as uiStore's
 * viewMode leaves 'commons', the capability goes off, or projectStore's
 * screen goes to Projects, whoever writes it (an agent's open_project, a
 * second tab, the hash route, Settings in another tab). So both stores' set
 * goes through holdCommonsExits, and no caller has to remember to ask.
 */
let unsaved = false;
let whenClean: (() => void)[] = [];

const COMMONS_UNSAVED_REASON = 'The Commons has unsaved changes: save or discard them first.';

export function setCommonsUnsaved(value: boolean): void {
  unsaved = value;
  if (value) return;
  // What waited for a clean Commons (an exit a store held, a leave the
  // person chose) goes now.
  const held = whenClean;
  whenClean = [];
  for (const exit of held) exit();
}

/** Runs `exit` now if the Commons is clean, else once it is. Returns a cancel. */
export function whenCommonsClean(exit: () => void): () => void {
  if (!unsaved) {
    exit();
    return () => {};
  }
  whenClean.push(exit);
  return () => { whenClean = whenClean.filter((queued) => queued !== exit); };
}

/**
 * How the Commons asks before the person leaves it (commons-leave, GM -
 * Design): its popover, anchored to what they clicked. `leave` runs once they
 * chose Save and leave, Discard and leave or Stop and leave and the Commons is
 * clean; never on Stay. `busy` marks the clicked control while a save already
 * in progress is awaited. CommonsView registers it while it shows.
 */
export type CommonsLeaveAsk = (anchor: HTMLElement | null, leave: () => void, busy?: (on: boolean) => void) => void;
let ask: CommonsLeaveAsk | null = null;

export function setCommonsLeaveAsk(next: CommonsLeaveAsk | null): void {
  ask = next;
}

/**
 * The person's own way out of the Commons from elsewhere (the Updates corner's
 * Show, See all, Review): false when nothing is unsaved (go now); true when
 * the Commons asks instead, and `leave` then runs only if they leave.
 */
export function askBeforeLeavingCommons(anchor: HTMLElement | null, leave: () => void, busy?: (on: boolean) => void): boolean {
  if (!unsaved || !ask) return false;
  ask(anchor, leave, busy);
  return true;
}

export function commonsUnsaved(): boolean {
  return unsaved;
}

/**
 * Throws while the Commons holds unsaved work: the net under the person's
 * exits that didn't ask first (askBeforeLeavingCommons).
 */
export function refuseWhileCommonsUnsaved(): void {
  if (unsaved) throw writtenLine(COMMONS_UNSAVED_REASON);
}

type Write<T> = Partial<T> | ((state: T) => Partial<T>);
/** A rule for one store: `next` without what would leave the Commons. */
export type CommonsHold<T> = (state: T, next: Partial<T>, later: (exit: () => void) => void,
  set: (partial: Write<T>) => void) => Partial<T>;

/**
 * Store middleware: while the Commons holds unsaved work, every write (the
 * store's own set and setState from outside alike) goes through `hold`
 * first, which returns it without the part that would leave the Commons. An
 * exit `hold` passes to `later` runs once the Commons is clean. A replacing
 * write (tests resetting a store) is let through.
 */
export function holdCommonsExits<T>(hold: CommonsHold<T>, config: StateCreator<T>): StateCreator<T> {
  return (set, get, api) => {
    const raw = set as (partial: T | Write<T>, replace?: boolean) => void;
    const guarded = (partial: T | Write<T>, replace?: boolean): void => {
      if (!unsaved || replace) return raw(partial, replace);
      raw((state: T) => hold(state, typeof partial === 'function' ? (partial as (state: T) => Partial<T>)(state) : partial,
        (exit) => { whenClean.push(exit); }, guarded));
    };
    api.setState = guarded as typeof set;
    return config(guarded as typeof set, get, api);
  };
}

let projectsHeld = false;
/**
 * projectStore's rule: Projects waits until the Commons is clean (a second
 * tab's open, a lost switch, a params stop), unless a later write shows the
 * workspace again. goHome, the person's own way there, refuses instead.
 */
export function holdProjects<T extends { screen: 'home' | 'workspace' }>(state: T, next: Partial<T>,
  later: (exit: () => void) => void, set: (partial: Partial<T>) => void): Partial<T> {
  if (!next.screen) return next;
  projectsHeld = next.screen === 'home' && state.screen !== 'home';
  if (!projectsHeld) return next;
  later(() => { if (projectsHeld) { projectsHeld = false; set({ screen: 'home' } as Partial<T>); } });
  const { screen: _held, ...rest } = next;
  void _held;
  return rest as Partial<T>;
}
