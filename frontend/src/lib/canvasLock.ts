import { useMemo } from 'react';
import { followingSwitch, refuseEditWhileFollowing, useFollowingSwitch, waitToOpenTooltip, type FollowingSwitch } from './canvasFollow';
import { isBackendOffline, refuseEditWhileOffline } from './backendConnection';
import { OFFLINE_MARK, useBackendOffline } from './useBackendOffline';
import { offlineDisabledReason } from './errorCopy';

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

export interface CanvasLock {
  /** Read-only: following an agent's switch, or offline. */
  locked: boolean;
  following: FollowingSwitch | null;
  offline: boolean;
  /** The marks a control disabled by the lock carries: the not-allowed
   * cursor and the dimming (App.css), and a press pulses the project bar
   * (following) or the offline banner. Empty when unlocked. */
  mark: Record<string, ''>;
  /** A control that acts: `disabled` (its own reasons too), the marks, and
   * while following GM's tooltip in place of its own. `offline` (a verb, or
   * true for none): offline, GM's "You can <verb> when Nebula reconnects."
   * in place of its own (fix round 1 of PR #200, answer 1). */
  act(own?: LockOwn): ActProps;
  /** The tooltip `act` gives, for a control that isn't disabled by it (a
   * read-only field). */
  title(own?: LockOwn): string | undefined;
}

export interface LockOwn {
  disabled?: boolean;
  title?: string;
  offline?: string | true;
}

export interface ActProps {
  disabled: boolean;
  title: string | undefined;
  'data-following-disabled'?: '';
  'data-offline-disabled'?: '';
}

/** The lock for a following and an offline state (the hook's own logic). */
export function canvasLockOf(following: FollowingSwitch | null, offline: boolean): CanvasLock {
  const mark: Record<string, ''> = {};
  if (following) mark[FOLLOWING_MARK] = '';
  if (offline) mark[OFFLINE_MARK] = '';
  const locked = Boolean(following) || offline;
  const title = (own: LockOwn = {}) => (following ? waitToOpenTooltip(following.projectName)
    : offline && own.offline ? offlineDisabledReason(own.offline === true ? undefined : own.offline) : own.title);
  return {
    locked, following, offline, mark, title,
    act: (own = {}) => ({
      ...mark,
      disabled: locked || Boolean(own.disabled),
      title: title(own),
    }),
  };
}

export function useCanvasLock(): CanvasLock {
  const following = useFollowingSwitch();
  const offline = useBackendOffline();
  return useMemo(() => canvasLockOf(following, offline), [following, offline]);
}

/** The lock as it is now, outside React (a store's action, a handler). */
export function canvasLockNow(): CanvasLock {
  return canvasLockOf(followingSwitch(), isBackendOffline());
}

/**
 * Round 23 (review 22, M-1): the gate a store action that edits the canvas
 * asks, the same two states useCanvasLock reads. True when it refused: the
 * project bar pulses while following (first: the canvas is about to go), the
 * offline banner while offline; the caller then changes nothing and sends
 * nothing.
 */
export function refuseCanvasEdit(): boolean {
  return refuseEditWhileFollowing() || refuseEditWhileOffline();
}
