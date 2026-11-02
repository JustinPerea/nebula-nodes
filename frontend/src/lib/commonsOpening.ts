/**
 * PR #204 round 18f (GM r35 5): the Commons-off view opening into the Commons after a reconnect.
 * The capability hook marks where focus goes (the way back when it was there, else the heading),
 * and the Commons view reads the mark as it renders and clears it once it has shown (a render
 * React drops, as when part of the view is still loading, must not lose it): it moves focus there
 * and springs its sections in. A module mark, not state: the first view that shows takes it.
 */
export type CommonsOpeningFocus = 'back' | 'heading';

let pending: CommonsOpeningFocus | null = null;

export function markCommonsOpening(focus: CommonsOpeningFocus): void { pending = focus; }

export function peekCommonsOpening(): CommonsOpeningFocus | null { return pending; }

export function clearCommonsOpening(): void { pending = null; }
