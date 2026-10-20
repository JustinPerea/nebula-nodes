import type { NodeRect } from './nodePlacement';

type ToFlow = (point: { x: number; y: number }) => { x: number; y: number };

/** The canvas the person can see, in flow coordinates, or undefined before it
 *  has a size. Used by the main canvas (a paste lands in view) and the Board
 *  view (files added with the button land in its middle). */
export function visibleFlowRect(wrapper: HTMLElement | null, screenToFlowPosition: ToFlow): NodeRect | undefined {
  const box = wrapper?.getBoundingClientRect();
  if (!box || box.width <= 0 || box.height <= 0) return undefined;
  const topLeft = screenToFlowPosition({ x: box.left, y: box.top });
  const bottomRight = screenToFlowPosition({ x: box.right, y: box.bottom });
  return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
}

/** The middle of what the person can see, in flow coordinates. */
export function visibleFlowCenter(wrapper: HTMLElement | null, screenToFlowPosition: ToFlow): { x: number; y: number } | undefined {
  const view = visibleFlowRect(wrapper, screenToFlowPosition);
  return view ? { x: view.x + view.width / 2, y: view.y + view.height / 2 } : undefined;
}
