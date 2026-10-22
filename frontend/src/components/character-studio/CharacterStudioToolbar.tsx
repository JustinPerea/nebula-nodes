import type { ReactNode } from 'react';
import { useUIStore } from '../../store/uiStore';
import { WorkspaceHeader } from '../WorkspaceHeader';
import type { SaveState } from './CharacterStudioView';

interface CharacterStudioToolbarProps {
  saveState: SaveState;
  /** Retry redoes the failure: a save's own (round 3). Hidden for any other line. */
  canRetry?: boolean;
  saveError: string | null;
  onRetry: () => void;
  /** Shown for a saved Character: moves it to Recently deleted. */
  onDelete?: () => void;
  deleteDisabled?: boolean;
  /** The Move menu (AssetMoveMenu), shown before Delete for a saved Character. */
  move?: ReactNode;
}

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  draft: 'Draft — not yet saved',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
};

/** Top toolbar: breadcrumb back to the canvas + a live save-state indicator.
 *  Mirrors CinemaStudioToolbar's thin-band role. Persistence is autosave (the
 *  Studio debounces updateCharacter/createCharacter on every edit once valid),
 *  so there is no explicit Save button — only the state read-out and a Retry
 *  affordance when a write fails. */
export function CharacterStudioToolbar({
  saveState,
  canRetry = saveState === 'error',
  saveError,
  onRetry,
  onDelete,
  deleteDisabled = false,
  move,
}: CharacterStudioToolbarProps) {
  const exitCharacterEditor = useUIStore((s) => s.exitCharacterEditor);
  const label = SAVE_LABEL[saveState];

  return (
    <WorkspaceHeader title="Character" onBack={exitCharacterEditor}
      className="character-studio-toolbar character-studio-view__header">
      {label && (
        <span
          className={`character-studio-toolbar__state character-studio-toolbar__state--${saveState}`}
        >
          {label}
        </span>
      )}
      {saveState === 'error' && canRetry && (
        <button
          type="button"
          className="character-studio-toolbar__retry"
          onClick={onRetry}
          title={saveError ?? 'Retry save'}
        >
          Retry
        </button>
      )}
      {move}
      {onDelete && (
        <button
          type="button"
          className="character-studio-toolbar__retry"
          title="Move to Recently deleted"
          disabled={deleteDisabled}
          onClick={onDelete}
        >
          Delete
        </button>
      )}
    </WorkspaceHeader>
  );
}
