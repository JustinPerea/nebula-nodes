import { useUIStore } from '../../store/uiStore';
import type { SaveState } from './CharacterStudioView';

interface CharacterStudioToolbarProps {
  saveState: SaveState;
  saveError: string | null;
  onRetry: () => void;
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
  saveError,
  onRetry,
}: CharacterStudioToolbarProps) {
  const exitCharacterEditor = useUIStore((s) => s.exitCharacterEditor);
  const label = SAVE_LABEL[saveState];

  return (
    <div className="character-studio-toolbar">
      <button
        type="button"
        className="character-studio-toolbar__back"
        onClick={exitCharacterEditor}
      >
        ← Canvas
      </button>
      <span className="character-studio-toolbar__crumb">Character Studio</span>
      <div className="character-studio-toolbar__spacer" />
      {label && (
        <span
          className={`character-studio-toolbar__state character-studio-toolbar__state--${saveState}`}
        >
          {label}
        </span>
      )}
      {saveState === 'error' && (
        <button
          type="button"
          className="character-studio-toolbar__retry"
          onClick={onRetry}
          title={saveError ?? 'Retry save'}
        >
          Retry
        </button>
      )}
    </div>
  );
}
