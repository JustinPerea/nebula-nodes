import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { isCanvasShortcutTarget } from '../lib/canvasShortcutScope';
import { displayKey, SHORTCUT_GROUPS, SHORTCUTS_OPEN_EVENT } from '../lib/keyboardShortcuts';
import '../styles/keyboard-shortcuts.css';

/** "?" on the canvas, or "Keyboard shortcuts" in the command palette. */
export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (!isCanvasShortcutTarget(event.target)) return;
      const ui = useUIStore.getState();
      if (ui.viewMode !== 'canvas' && !(ui.viewMode === 'commons' && !ui.commonsEnabled)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener(SHORTCUTS_OPEN_EVENT, show);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(SHORTCUTS_OPEN_EVENT, show);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="keyboard-shortcuts" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="keyboard-shortcuts__card" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === '?') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === 'Tab') {
            // The close button is the only control: keep focus inside.
            event.preventDefault();
            closeRef.current?.focus();
          }
        }}>
        <header className="keyboard-shortcuts__header">
          <h2 id={titleId}>Keyboard shortcuts</h2>
          <button ref={closeRef} type="button" className="keyboard-shortcuts__close" aria-label="Close" onClick={() => setOpen(false)}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="keyboard-shortcuts__groups">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="keyboard-shortcuts__group">
              <h3>{group.title}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={item.label} className="keyboard-shortcuts__row">
                    <dt>{item.label}</dt>
                    <dd>{item.keys.map((key) => <kbd key={key}>{displayKey(key)}</kbd>)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  );
}
