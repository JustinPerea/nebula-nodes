import { useEffect, useState } from 'react';

/**
 * Keeps a component mounted for `duration` ms after `visible` flips false,
 * so an exit animation can play before React removes the DOM. Returns:
 *   - shouldRender: include the component in the tree
 *   - exiting: true during the post-hide animation window (apply your
 *     exit-state class while this is true)
 *
 * Usage:
 *   const visible = useStore(s => s.panel.visible);
 *   const { shouldRender, exiting } = useDelayedUnmount(visible, 500);
 *   if (!shouldRender) return null;
 *   return <div className={`panel ${exiting ? 'panel--exiting' : ''}`}>…</div>;
 *
 * The duration MUST match the longest CSS transition/animation that runs
 * during exit — otherwise the component unmounts mid-animation.
 */
export function useDelayedUnmount(visible: boolean, duration = 500) {
  const [shouldRender, setShouldRender] = useState(visible);

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
      return;
    }
    const t = setTimeout(() => setShouldRender(false), duration);
    return () => clearTimeout(t);
  }, [visible, duration]);

  return { shouldRender, exiting: shouldRender && !visible };
}
