import { useMemo } from 'react';
import { followingSwitch, refuseEditWhileFollowing, useFollowingSwitch, waitToOpenTooltip, type FollowingSwitch } from './canvasFollow';
import { isBackendOffline, refuseEditWhileOffline } from './backendConnection';
import { OFFLINE_MARK, useBackendOffline } from './useBackendOffline';
import { isCanvasKept, KEPT_LOCK_TITLES, refuseEditWhileKept, useKeptCanvas, type KeptAction } from './keptCanvas';

/**
 * Round 22 of PR #195 (GM - Design, blocker A): the one read-only state
 * every action surface of the canvas shares. The canvas is read-only while
 * the tab follows an agent's switch (lib/canvasFollow) and while Nebula is
 * offline (PR #114); each surface reads both from here, never one on its
 * own, so none can drift (tests/round22Surfaces walks the sources).
 *
 * GM's words: while following, every control that acts (the selection
 * toolbar's Run, Ask, Note, Duplicate and Delete; the Inspector's Run,
 * Duplicate and Delete in the panel and the popover; node card buttons,
 * context menus, anything else that acts) is disabled in the neutral
 * disabled look with the tooltip "Wait for “<project>” to open.". Settings
 * and Copy stay enabled (they change nothing). Offline plus following:
 * disabled too, with the following tooltip.
 */
export const FOLLOWING_MARK = 'data-following-disabled';
/** GM r16 on PR #199, 4: a control disabled because the canvas is kept in
 * this tab after a restore (lib/keptCanvas). The same disabled look; a
 * press pulses the kept line. */
export const KEPT_MARK = 'data-kept-disabled';

/** A control's own state for `act`: `busy` is the run's reason when one is
 * going ("Wait for the active run to finish"), `kept` which of GM's kept
 * tooltips it shows (r16, 4). */
export interface ActOwn {
  disabled?: boolean;
  title?: string;
  busy?: string | null;
  kept?: KeptAction;
}

export interface CanvasLock {
  /** Read-only: following an agent's switch, or offline. Fields stay
   * editable while the canvas is only kept: typing joins the kept edits. */
  locked: boolean;
  following: FollowingSwitch | null;
  offline: boolean;
  /** The canvas is kept in this tab after a restore (GM r15, Q11): every
   * control that writes or spends is disabled (`act`), typing isn't. */
  kept: boolean;
  /** The marks a control disabled by the lock carries: the not-allowed
   * cursor and the dimming (App.css), and a press pulses the project bar
   * (following) or the offline banner. Empty when unlocked. */
  mark: Record<string, ''>;
  /** A control that acts: `disabled` (its own reasons too), the marks, and
   * the first lock reason's tooltip in GM's order (r16, 4): kept, a run
   * going (`busy`), following, offline (offline has no tooltip of its own). */
  act(own?: ActOwn): ActProps;
  /** A control that stays live while following or offline (it changes
   * nothing there) but not while kept: GM r16, 4 lists Settings. */
  keptOnly(action: KeptAction, title?: string): ActProps;
}

export interface ActProps {
  disabled: boolean;
  title: string | undefined;
  'data-following-disabled'?: '';
  'data-offline-disabled'?: '';
  'data-kept-disabled'?: '';
}

/** The lock for a following, an offline and a kept state (the hook's own logic). */
export function canvasLockOf(following: FollowingSwitch | null, offline: boolean, kept = false): CanvasLock {
  const mark: Record<string, ''> = {};
  if (following) mark[FOLLOWING_MARK] = '';
  if (offline) mark[OFFLINE_MARK] = '';
  const locked = Boolean(following) || offline;
  const keptProps = (action: KeptAction = 'other'): ActProps => ({
    [KEPT_MARK]: '', disabled: true, title: KEPT_LOCK_TITLES[action],
  });
  return {
    locked, following, offline, kept, mark,
    // Kept first: its tooltip and its mark only (a press pulses the kept line).
    act: (own = {}) => (kept ? keptProps(own.kept) : {
      ...mark,
      disabled: locked || Boolean(own.disabled) || Boolean(own.busy),
      title: own.busy || (following ? waitToOpenTooltip(following.projectName) : own.title),
    }),
    keptOnly: (action, title) => (kept ? keptProps(action) : { disabled: false, title }),
  };
}

export function useCanvasLock(): CanvasLock {
  const following = useFollowingSwitch();
  const offline = useBackendOffline();
  const kept = useKeptCanvas();
  return useMemo(() => canvasLockOf(following, offline, kept), [following, offline, kept]);
}

/** The lock as it is now, outside React (a store's action, a handler). */
export function canvasLockNow(): CanvasLock {
  return canvasLockOf(followingSwitch(), isBackendOffline(), isCanvasKept());
}

/**
 * Round 23 (review 22, M-1): the gate a store action that edits the canvas
 * asks, the same two states useCanvasLock reads. True when it refused: the
 * project bar pulses while following (first: the canvas is about to go), the
 * offline banner while offline; the caller then changes nothing and sends
 * nothing.
 */
export function refuseCanvasEdit(): boolean {
  // And while the canvas is kept in this tab after a restore (GM r15 on PR
  // #199, Q11): only typing joins the kept edits (the store's gates).
  return refuseEditWhileFollowing() || refuseEditWhileKept() || refuseEditWhileOffline();
}
