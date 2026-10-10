import { useSyncExternalStore } from 'react';

/**
 * When exactly one node is selected, the selection toolbar leaves a slot for
 * that node's own actions (Add next step, Edit video, Settings). The node
 * portals them in, so they keep the node's local state (which batch result is
 * showing) while living in one bar instead of a second pill above the node.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setSelectionActionSlot(element: HTMLElement | null) {
  if (slot === element) return;
  slot = element;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The slot, if it is reserved for this node. */
export function useSelectionActionSlot(nodeId: string): HTMLElement | null {
  const element = useSyncExternalStore(subscribe, () => slot, () => null);
  return element?.dataset.nodeId === nodeId ? element : null;
}
