import { useEffect } from 'react';
import { refuseEditWhileFollowing, useFollowingSwitch } from '../lib/canvasFollow';
import { FOLLOWING_MARK } from '../lib/canvasLock';

/** Where the canvas's fields live: its nodes and the Inspector, docked or
 * the popover the canvas opens over a node (portaled into the body; round
 * 21, review 20 L-2). Kept in step with styles/canvas-follow.css. */
export const EDITABLE_AREA = '.react-flow, .panel--inspector, .node-inspector-popover';
/** Keys that edit a field (navigation, selection and shortcuts with a
 * modifier pass; the store's own gate refuses any edit they reach). */
const EDITING_KEY = /^(?:.|Backspace|Delete|Enter)$/u;

/**
 * Round 20 (review 19, M1): while the tab follows an agent's switch the
 * canvas's fields show disabled (`nebula-following` on the body, styled in
 * styles/canvas-follow.css) and an attempt to type into one, paste into it
 * or drop on the canvas changes nothing and pulses the project bar
 * (refuseEditWhileFollowing). graphStore's edit gate is what guarantees it;
 * this only keeps the field from showing a keystroke the store refuses.
 */
export function useFollowingReadOnly(): void {
  const following = useFollowingSwitch();
  useEffect(() => {
    if (!following) return undefined;
    document.body.classList.add('nebula-following');
    const inside = (target: EventTarget | null) => target instanceof Element && target.closest(EDITABLE_AREA) !== null;
    const refuse = (event: Event) => {
      if (!inside(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      refuseEditWhileFollowing();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || !EDITING_KEY.test(event.key)) return;
      const field = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]');
      if (field) refuse(event);
    };
    // Round 22 (GM A): a press on a control the follow disabled
    // (lib/canvasLock's mark), or on a wire handle, pulses the bar, as
    // offline pulses its banner (BackendConnectionStatus).
    const pressed = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(`[${FOLLOWING_MARK}], .canvas--read-only .react-flow__handle`)) refuseEditWhileFollowing();
    };
    const types = ['beforeinput', 'paste', 'drop'] as const;
    for (const type of types) document.addEventListener(type, refuse, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', pressed, true);
    return () => {
      document.body.classList.remove('nebula-following');
      for (const type of types) document.removeEventListener(type, refuse, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', pressed, true);
    };
  }, [following]);
}
