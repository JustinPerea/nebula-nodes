import { useEffect, useId, useRef, type RefObject } from 'react';
import { X } from 'lucide-react';
import { returnFocusOnSlip } from '../lib/modalFocus';
import { displayKey, MESSAGE_SHORTCUT_KEY, SHORTCUT_GROUPS } from '../lib/keyboardShortcuts';
import { availabilityLabel } from '../lib/personThread';
import { useMessageAvailability } from '../store/personThreadStore';
import '../styles/keyboard-shortcuts.css';
import { ModalPortal } from './ModalPortal';

/** The dialog itself, in its own chunk (components/KeyboardShortcuts.tsx keeps the keys). */
export function KeyboardShortcutsDialog({ cardRef, onClose }: {
  cardRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  // GM r94.2: "/" names the agent as the Message box's field does.
  const messageLabel = `Message ${availabilityLabel(useMessageAvailability())}`;

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  return (
    <ModalPortal>
    <div className="keyboard-shortcuts" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={cardRef} className="keyboard-shortcuts__card" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onBlur={(event) => returnFocusOnSlip(event, () => closeRef.current)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === '?') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Tab') {
            // The close button is the only control: keep focus inside.
            event.preventDefault();
            closeRef.current?.focus();
          }
        }}>
        <header className="keyboard-shortcuts__header">
          <h2 id={titleId}>Keyboard shortcuts</h2>
          <button ref={closeRef} type="button" className="keyboard-shortcuts__close" aria-label="Close" onClick={() => onClose()}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="keyboard-shortcuts__groups">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="keyboard-shortcuts__group">
              <h3>{group.title}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={item.keys.join('+')} className="keyboard-shortcuts__row">
                    <dt>{item.keys.length === 1 && item.keys[0] === MESSAGE_SHORTCUT_KEY ? messageLabel : item.label}</dt>
                    <dd>{item.keys.map((key) => <kbd key={key}>{displayKey(key)}</kbd>)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>
    </div>
    </ModalPortal>
  );
}
