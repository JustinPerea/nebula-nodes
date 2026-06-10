import { Blocks, Images, MessageSquare, Sparkles, Users } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import '../../styles/panels.css';

export function PanelLaunchers() {
  const libraryVisible = useUIStore((s) => s.panels.library.visible);
  const chatVisible = useUIStore((s) => s.panels.chat.visible);
  const moodboardVisible = useUIStore((s) => s.panels.moodboard.visible);
  const characterVisible = useUIStore((s) => s.panels.character.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const enterCreateView = useUIStore((s) => s.enterCreateView);

  return (
    <>
      <button
        type="button"
        className="panel-launcher panel-launcher--create"
        onClick={enterCreateView}
        title="Open Create view"
        aria-label="Open Create view"
      >
        <Sparkles
          className="panel-launcher__icon"
          size={18}
          strokeWidth={1.65}
          aria-hidden="true"
          focusable="false"
        />
      </button>

      <button
        type="button"
        className={`panel-launcher panel-launcher--moodboard${moodboardVisible ? ' panel-launcher--active' : ''}`}
        onClick={() => togglePanel('moodboard')}
        title="Toggle moodboard library"
        aria-label="Toggle moodboard library"
        aria-pressed={moodboardVisible}
      >
        <Images className="panel-launcher__icon" size={18} strokeWidth={1.65} aria-hidden="true" focusable="false" />
      </button>

      <button
        type="button"
        className={`panel-launcher panel-launcher--character${characterVisible ? ' panel-launcher--active' : ''}`}
        onClick={() => togglePanel('character')}
        title="Toggle character library"
        aria-label="Toggle character library"
        aria-pressed={characterVisible}
      >
        <Users className="panel-launcher__icon" size={18} strokeWidth={1.65} aria-hidden="true" focusable="false" />
      </button>

      <button
        type="button"
        className={`panel-launcher panel-launcher--nodes${libraryVisible ? ' panel-launcher--active' : ''}`}
        onClick={() => togglePanel('library')}
        title="Toggle node library"
        aria-label="Toggle node library"
        aria-pressed={libraryVisible}
      >
        <Blocks className="panel-launcher__icon" size={18} strokeWidth={1.65} aria-hidden="true" focusable="false" />
      </button>

      <button
        type="button"
        className={`panel-launcher panel-launcher--chat${chatVisible ? ' panel-launcher--active' : ''}`}
        onClick={() => togglePanel('chat')}
        title="Toggle chat panel"
        aria-label="Toggle chat panel"
        aria-pressed={chatVisible}
      >
        <MessageSquare className="panel-launcher__icon" size={18} strokeWidth={1.65} aria-hidden="true" focusable="false" />
      </button>
    </>
  );
}
