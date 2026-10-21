import { createPortal } from 'react-dom';
import { SlidersHorizontal } from 'lucide-react';
import { useSelectionActionSlot } from '../../lib/selectionActionSlot';
import { useUIStore } from '../../store/uiStore';
import { useCardSelection } from '../../hooks/useCardSelection';

/**
 * "Settings" in the selection toolbar for a card node that has no pill of its
 * own (Moodboard, Character): opens the Inspector, where the node's asset
 * picker lives. Same control and toggle as ModelNode's toolbar Settings.
 */
export function NodeSettingsAction({ id }: { id: string }) {
  const slot = useSelectionActionSlot(id);
  const { inspectorOpen: open } = useCardSelection(id);
  const selectNode = useUIStore((s) => s.selectNode);
  const setInspectorVisible = useUIStore((s) => s.setInspectorVisible);
  if (!slot) return null;
  return createPortal(
    <button
      type="button"
      className="selection-toolbar__button nodrag"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="Show node settings"
      title="Show node settings"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        selectNode(id);
        setInspectorVisible(!open);
      }}
    >
      <SlidersHorizontal size={17} aria-hidden="true" />
      <span className="selection-toolbar__label--compact">Settings</span>
    </button>,
    slot,
  );
}
