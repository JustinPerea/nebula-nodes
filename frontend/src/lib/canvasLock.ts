import { useMemo } from 'react';
import { followingSwitch, refuseEditWhileFollowing, useFollowingSwitch, waitToOpenTooltip, type FollowingSwitch } from './canvasFollow';
import { isBackendOffline, refuseEditWhileOffline } from './backendConnection';
import { OFFLINE_MARK, OFFLINE_NEUTRAL, offlineReason, useBackendOffline, type OfflineVerb } from './useBackendOffline';
import { RUN_LOCK_REASON } from './cinemaScene';

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
 *
 * PR #198 review 6, M2 (GM r9 answer 3): this tab's own run is a third
 * reason, for the controls it locks too (a run, a delete, a duplicate, an
 * undo). One order everywhere: the run, then following, then offline, then
 * the control's own title. A control the run lock wins on says only the
 * run's line and carries neither mark, so a press never pulses the project
 * bar or the banner for a reason its tooltip doesn't give.
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
   * while following GM's tooltip in place of its own. `run`: the run lock
   * holds it now (the caller reads isExecuting, or a wider condition such as
   * a run that is starting, so a card that draws no run lock never
   * re-renders when a run starts); its line then wins. */
  act(own?: { disabled?: boolean; title?: string }, options?: RunLock): ActProps;
}

/** The run lock's hold on one control (M2): `runTitle` when a run holds it
 * for a reason of its own (a shot that is rendering), else GM's run line. */
export interface RunLock { run?: boolean; runTitle?: string }

export interface ActProps {
  disabled: boolean;
  title: string | undefined;
  'data-following-disabled'?: '';
  'data-offline-disabled'?: '';
}

/**
 * An acting control that also reads PR #198's offline look (the Cinema studio
 * and the other studios' paid or saving actions): the lock (`act`: disabled,
 * the marks, GM's wait line while following) and, offline and not following,
 * GM's offline line for its verb ("You can generate when Nebula
 * reconnects.", lib/useBackendOffline offlineReason; the generic line with
 * none) in place of its own title. `neutral` drops its accent offline
 * (OFFLINE_NEUTRAL: an orange Generate, an Export), as offlineAction does.
 * Following plus offline keeps the following tooltip (GM round 22, A).
 */
export function lockedAction(lock: CanvasLock, own: { disabled?: boolean; title?: string } = {},
  options: { verb?: OfflineVerb; neutral?: boolean; offlineTooltip?: boolean } & RunLock = {}): ActProps & { 'data-offline-neutral'?: '' } {
  const props: ActProps & { 'data-offline-neutral'?: '' } = lock.act(own, options);
  if (!lock.offline || options.run) return props;
  if (options.neutral) props[OFFLINE_NEUTRAL] = '';
  // Create's and Remotion's actions keep their own title offline for now
  // (GM deferred their offline tooltips: `offlineTooltip: false`).
  if (!lock.following && options.offlineTooltip !== false) props.title = offlineReason(options.verb);
  return props;
}

/** The lock for a following and an offline state (the hook's own logic). */
export function canvasLockOf(following: FollowingSwitch | null, offline: boolean): CanvasLock {
  const mark: Record<string, ''> = {};
  if (following) mark[FOLLOWING_MARK] = '';
  if (offline) mark[OFFLINE_MARK] = '';
  const locked = Boolean(following) || offline;
  return {
    locked, following, offline, mark,
    act: (own = {}, options = {}) => (options.run
      // The run's line first, alone (M2, N1).
      ? { disabled: true, title: options.runTitle ?? RUN_LOCK_REASON }
      : {
        ...mark,
        disabled: locked || Boolean(own.disabled),
        title: following ? waitToOpenTooltip(following.projectName) : own.title,
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
