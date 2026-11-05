import { MessageSquare } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { usePersonThreadStore, terminalListening } from '../store/personThreadStore';

export function ChatLauncher() {
  const chatVisible = useUIStore((s) => s.panels.chat.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);
  // r50: this chat starts a separate Claude; while a terminal session listens
  // (the Message box's), it reads "Personal agent" so the two don't blur.
  const label = usePersonThreadStore(terminalListening) ? 'Personal agent' : 'Toggle chat panel';

  return (
    <button
      type="button"
      className={`panel-launcher panel-launcher--chat${chatVisible ? ' panel-launcher--active' : ''}`}
      data-onboarding-target="chat"
      onClick={() => togglePanel('chat')}
      title={label}
      aria-label={label}
      aria-pressed={chatVisible}
    >
      <MessageSquare className="panel-launcher__icon" size={18} strokeWidth={1.65} aria-hidden="true" focusable="false" />
    </button>
  );
}
