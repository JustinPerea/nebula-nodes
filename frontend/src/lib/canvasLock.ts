import { useMemo } from 'react';
import { followingSwitch, refuseEditWhileFollowing, useFollowingSwitch, waitToOpenTooltip, type FollowingSwitch } from './canvasFollow';
import { isBackendOffline, refuseEditWhileOffline } from './backendConnection';
import { OFFLINE_MARK, OFFLINE_NEUTRAL, offlineReason, useBackendOffline, type OfflineVerb } from './useBackendOffline';
import { RUN_LOCK_REASON } from './cinemaScene';
import { offlineDisabledReason } from './errorCopy';
import { isCanvasKept, keptCanvasTakesTyping, keptLockTitle, refuseEditWhileKept, useKeptCanvas, type KeptAction } from './keptCanvas';

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
 *
 * PR #199 (GM r16-r18): the canvas kept in this tab after a restore is the
 * fourth reason, after the run, following and offline. A control that only
 * changes this tab's canvas (`kept: 'live'`) stays on.
 */
export const FOLLOWING_MARK = 'data-following-disabled';
/** GM r16 on PR #199, 4: a control disabled because the canvas is kept in
 * this tab after a restore (lib/keptCanvas). The same disabled look; a
 * press pulses the kept line. */
export const KEPT_MARK = 'data-kept-disabled';


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
   * while following GM's tooltip in place of its own. `offline` (a verb, or
   * true for none): offline, GM's "You can <verb> when Nebula reconnects."
   * in place of its own (fix round 1 of PR #200, answer 1). `run` (PR #198):
   * the run lock holds it now (the caller reads isExecuting, or a wider
   * condition such as a run that is starting, so a card that draws no run
   * lock never re-renders when a run starts); its line then wins. Kept
   * (PR #199) comes after the run, following and offline: GM's kept line
   * for the control's `kept` action, unless it is 'live'. */
  act(own: LockOwn, options?: RunLock): ActProps;
  /** The tooltip `act` gives, for a control that isn't disabled by it (a
   * read-only field). */
  title(own?: LockTitleOwn): string | undefined;
}

/** A control's own state for `title`. */
export interface LockTitleOwn {
  disabled?: boolean;
  title?: string;
  offline?: string | true;
}

/** A control's own state for `act`: `kept` names which of GM's kept lines
 * it shows (PR #199, r16, 4; r17, Q2: every control names its own, so the
 * field is required), or 'live' for a control that only changes this tab's
 * canvas (r17, r18: typing, Duplicate, Delete, Arrange, Undo), which the
 * kept state leaves on. */
export interface LockOwn extends LockTitleOwn {
  kept: KeptAction | 'live';
}

/** The run lock's hold on one control (M2): `runTitle` when a run holds it
 * for a reason of its own (a shot that is rendering), else GM's run line. */
export interface RunLock { run?: boolean; runTitle?: string }

export interface ActProps {
  disabled: boolean;
  title: string | undefined;
  'data-following-disabled'?: '';
  'data-offline-disabled'?: '';
  'data-kept-disabled'?: '';
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
export function lockedAction(lock: CanvasLock, own: LockOwn,
  options: { verb?: OfflineVerb; neutral?: boolean; offlineTooltip?: boolean } & RunLock = {}): ActProps & { 'data-offline-neutral'?: '' } {
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

/** The lock for a following, an offline and a kept state (the hook's own logic). */
export function canvasLockOf(following: FollowingSwitch | null, offline: boolean, kept = false): CanvasLock {
  const mark: Record<string, ''> = {};
  if (following) mark[FOLLOWING_MARK] = '';
  if (offline) mark[OFFLINE_MARK] = '';
  const locked = Boolean(following) || offline;
  const title = (own: LockTitleOwn = {}) => (following ? waitToOpenTooltip(following.projectName)
    : offline && own.offline ? offlineDisabledReason(own.offline === true ? undefined : own.offline) : own.title);
  return {
    locked, following, offline, kept, mark, title,
    act: (own, options = {}) => {
      // The run's line first, alone (PR #198 M2, N1).
      if (options.run) return { disabled: true, title: options.runTitle ?? RUN_LOCK_REASON };
      // Then following and offline (their marks and lines), then kept: its
      // own line and its mark only (a press pulses the kept line). A control
      // that only changes this tab's canvas stays on.
      if (!locked && kept && own.kept !== 'live') return { [KEPT_MARK]: '', disabled: true, title: keptLockTitle(own.kept) };
      return { ...mark, disabled: locked || Boolean(own.disabled), title: title(own) };
    },
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
  // #199, Q11), after following and offline (the order `act` gives): only
  // the tab-only edits join the kept edits (the store's gates).
  return refuseEditWhileFollowing() || refuseEditWhileOffline() || refuseEditWhileKept();
}

/**
 * PR #199 (GM r18, Q3): the gate for an edit that only changes this tab's
 * canvas, as typing does (a param written with updateNodeData: an applied
 * rewrite, a mask). Refused while following or offline, as refuseCanvasEdit;
 * while the canvas is kept it goes through (the store's KEPT_TAB_ONLY gate
 * keeps it on this tab), except while [Save as a project] is on its way.
 */
export function refuseTabOnlyEdit(): boolean {
  if (refuseEditWhileFollowing() || refuseEditWhileOffline()) return true;
  if (isCanvasKept() && !keptCanvasTakesTyping()) return refuseEditWhileKept();
  return false;
}
