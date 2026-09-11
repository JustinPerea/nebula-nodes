import { MessageSquare } from 'lucide-react';
import { useUIStore } from '../store/uiStore';

export function ChatLauncher() {
  const chatVisible = useUIStore((s) => s.panels.chat.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);

  return (
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
  );
}
