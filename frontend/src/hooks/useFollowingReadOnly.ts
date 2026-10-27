import { useEffect } from 'react';
import { refuseEditWhileFollowing, useFollowingSwitch } from '../lib/canvasFollow';

/** Where the canvas's fields live: its nodes and the Inspector. */
const EDITABLE_AREA = '.react-flow, .panel--inspector';
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
    const types = ['beforeinput', 'paste', 'drop'] as const;
    for (const type of types) document.addEventListener(type, refuse, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.body.classList.remove('nebula-following');
      for (const type of types) document.removeEventListener(type, refuse, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [following]);
}
