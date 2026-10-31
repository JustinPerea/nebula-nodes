import { useMemo } from 'react';
import { followingSwitch, refuseEditWhileFollowing, useFollowingSwitch, waitToOpenTooltip, type FollowingSwitch } from './canvasFollow';
import { isBackendOffline, refuseEditWhileOffline } from './backendConnection';
import { OFFLINE_MARK, OFFLINE_NEUTRAL, offlineReason, useBackendOffline, type OfflineVerb } from './useBackendOffline';
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
   * while following GM's tooltip in place of its own. `offline` (a verb, or
   * true for none): offline, GM's "You can <verb> when Nebula reconnects."
   * in place of its own (fix round 1 of PR #200, answer 1). `run` (PR #198):
   * the run lock holds it now (the caller reads isExecuting, or a wider
   * condition such as a run that is starting, so a card that draws no run
   * lock never re-renders when a run starts); its line then wins. */
  act(own?: LockOwn, options?: RunLock & LockShown): ActProps;
  /** The tooltip `act` gives, for a control that isn't disabled by it (a
   * read-only field). */
  title(own?: LockOwn): string | undefined;
}

export interface LockOwn {
  disabled?: boolean;
  title?: string;
  offline?: string | true;
}

/** The run lock's hold on one control (M2). A control the run can hold
 * names its own line with it (GM r39 item 2: "You can <verb> when the run
 * finishes.", lib/runLock's table, or a reason of its own such as a shot
 * that is rendering): there is no shared default, so a new lock can't fall
 * back to a generic line. */
export type RunLock = { run?: undefined; runTitle?: undefined } | { run: boolean; runTitle: string };

/**
 * GM, PR #205 round 1: when a control's lock reason is already on screen
 * beside it (the deferred run notice's line, Cinema's line under Generate),
 * a tooltip only repeats it and covers what is next to it. `shown` names that
 * line (its element's id and its text): when the reason a locked control
 * would give as its tooltip is that text, whichever lock gave it, the
 * control has no tooltip and points aria-describedby at the line, so the
 * reason still reaches the keyboard and a screen reader. Any other reason
 * (following, offline, a different line) keeps its tooltip.
 */
export interface LockShown {
  shown?: { id: string; text: string | undefined };
}

/** `shown`'s rule, applied in `act` (so lockedAction, which starts from it,
 * keeps it; offline, lockedAction's offline line is a different reason and
 * sets its tooltip again). */
export function tellOnce<P extends ActProps>(props: P, shown?: LockShown['shown']): P {
  if (!shown?.text || !props.disabled || props.title !== shown.text) return props;
  return { ...props, title: undefined, 'aria-describedby': shown.id };
}

export interface ActProps {
  disabled: boolean;
  title: string | undefined;
  /** Set by `shown` (GM PR #205 r1): the on-screen line that gives the reason. */
  'aria-describedby'?: string;
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
export function lockedAction(lock: CanvasLock, own: LockOwn = {},
  options: { verb?: OfflineVerb; neutral?: boolean; offlineTooltip?: boolean } & RunLock & LockShown = {}): ActProps & { 'data-offline-neutral'?: '' } {
  const props: ActProps & { 'data-offline-neutral'?: '' } = lock.act(own, options);
  if (!lock.offline || options.run) return props;
  if (options.neutral) props[OFFLINE_NEUTRAL] = '';
  // Create's and Remotion's actions keep their own title offline for now
  // (GM deferred their offline tooltips: `offlineTooltip: false`). A
  // control that names its own offline verb (PR #200's `own.offline`)
  // keeps the line act gave it.
  if (!lock.following && options.offlineTooltip !== false && !(own.offline && !options.verb)) props.title = offlineReason(options.verb);
  return props;
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
    act: (own = {}, options = {}) => tellOnce(options.run
      // The run's line first, alone (PR #198 M2, N1).
      ? { disabled: true, title: options.runTitle }
      : {
        ...mark,
        disabled: locked || Boolean(own.disabled),
        title: title(own),
      }, options.shown),
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
