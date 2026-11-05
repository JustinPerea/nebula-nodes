import { useRef } from 'react';
import type { BoardPanelTab } from '../../store/boardReadingStore';

/**
 * The Board view's side panel switch (GM's board reading design section 1):
 * "Settings" (everything the panel had) and "Reading". While a read runs and
 * Settings shows, Reading carries the small activity dot. The thumb slides on
 * the Board / List switch's spring.
 */
export function BoardPanelSwitch({ tab, onChange, running }: {
  tab: BoardPanelTab;
  onChange: (tab: BoardPanelTab) => void;
  running: boolean;
}) {
  const options: Array<{ id: BoardPanelTab; label: string }> = [{ id: 'settings', label: 'Settings' }, { id: 'reading', label: 'Reading' }];
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const index = options.findIndex((option) => option.id === tab);
  return (
    <div className="moodboard-view-switch moodboard-panel-switch" role="tablist" aria-label="Board panel"
      style={{ ['--mb-view-index' as string]: index }}>
      <span className="moodboard-view-switch__thumb" aria-hidden="true" />
      {options.map((option) => {
        const dot = option.id === 'reading' && running && tab !== 'reading';
        return (
          <button key={option.id} ref={(node) => { refs.current[option.id] = node; }} type="button" role="tab"
            aria-selected={tab === option.id} tabIndex={tab === option.id ? 0 : -1}
            aria-label={dot ? `${option.label}, a read is running` : undefined}
            className="moodboard-view-switch__option" onClick={() => onChange(option.id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
              event.preventDefault();
              const next = options[(options.findIndex((candidate) => candidate.id === option.id) + 1) % options.length];
              onChange(next.id);
              refs.current[next.id]?.focus();
            }}>
            {option.label}
            {dot && <span className="moodboard-panel-switch__dot" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
