import { useUIStore } from '../store/uiStore';

/**
 * Whether this card is the UI's selected node, and whether the Inspector is
 * open on it. Booleans, so selecting another node re-renders only the card
 * that gains or loses the selection, not every card (a card subscribing to
 * `selectedNodeId` itself re-rendered on every selection change).
 */
export function useCardSelection(nodeId: string): { selectedInUi: boolean; inspectorOpen: boolean } {
  const selectedInUi = useUIStore((s) => s.selectedNodeId === nodeId);
  const inspectorOpen = useUIStore((s) => s.selectedNodeId === nodeId && s.panels.inspector.visible);
  return { selectedInUi, inspectorOpen };
}
