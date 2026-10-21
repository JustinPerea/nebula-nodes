import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { MoveChoice } from '../../lib/assetMove';
import '../../styles/asset-move.css';

/**
 * A Studio toolbar's Move button and its menu (Move to Global / Move to
 * <project>). The menu is fixed under the button in a portal: the toolbar
 * scrolls (workspace-header.css overflow), which would clip it. Arrow keys,
 * Home and End move between choices; Escape or Tab closes and returns focus;
 * a press outside closes.
 */
export function AssetMoveMenu({ choices, onChoose, busy = false, disabled = false, buttonClassName, noun }: {
  choices: MoveChoice[];
  onChoose: (choice: MoveChoice) => void;
  busy?: boolean;
  disabled?: boolean;
  /** The toolbar's own button class, so Move looks like Delete beside it. */
  buttonClassName: string;
  /** "board" or "Character", for the button's label. */
  noun: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);
  if (choices.length === 0) return null;
  return (
    <>
      <button ref={triggerRef} type="button" className={`${buttonClassName} asset-move__trigger`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        title={`Move this ${noun} to Global or to a project`}
        disabled={disabled || busy} onClick={() => setOpen((value) => !value)}>
        {busy ? 'Moving…' : 'Move'}
        <span className="asset-move__caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ToolbarMenuPopover anchorRef={triggerRef} id={menuId} onClose={close} label={`Move this ${noun}`}
          choices={choices} onChoose={(choice) => { close(true); onChoose(choice); }} />
      )}
    </>
  );
}

const ITEM = '[role="menuitem"], [role="menuitemradio"]';

/** One choice in a toolbar menu; with `checked` it is one of a radio group. */
export interface ToolbarMenuChoice {
  id: string;
  label: string;
  disabled?: boolean;
  /** Why it's off, for its tooltip. */
  reason?: string;
  checked?: boolean;
}

/**
 * The toolbar menu itself, also the Commons toolbar's More (CommonsView):
 * fixed under its button in a portal, keyboard as described above.
 */
export function ToolbarMenuPopover<C extends ToolbarMenuChoice>({ anchorRef, id, label, choices, onChoose, onClose }: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  id: string;
  label: string;
  choices: C[];
  onChoose: (choice: C) => void;
  onClose: (returnFocus: boolean) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = menu?.width ?? 220;
    // Right-aligned under the button (it sits at the toolbar's right end), kept on screen.
    const left = Math.min(Math.max(8, anchor.right - width), Math.max(8, window.innerWidth - width - 8));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement: the menu's place depends on its own rendered size
    setPosition({ left, top: anchor.bottom + 6 });
  }, [anchorRef]);

  useEffect(() => {
    if (!position) return;
    const menu = menuRef.current;
    (menu?.querySelector<HTMLElement>(`${ITEM}:not([aria-disabled="true"])`)
      ?? menu?.querySelector<HTMLElement>(ITEM))?.focus();
  }, [position]);

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      onClose(false);
    };
    const resize = () => onClose(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', resize);
    };
  }, [anchorRef, onClose]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const focus = (index: number) => { event.preventDefault(); items[(index + items.length) % items.length]?.focus(); };
    if (event.key === 'ArrowDown') focus(at + 1);
    else if (event.key === 'ArrowUp') focus(at - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(items.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(true); }
  };

  return createPortal(
    <div ref={menuRef} id={id} role="menu" aria-label={label} onKeyDown={onKeyDown}
      className={`asset-move__menu${position ? ' asset-move__menu--open' : ''}`}
      style={position ? { left: position.left, top: position.top } : undefined}>
      {choices.map((choice) => (
        <button key={choice.id} type="button" role={choice.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={choice.checked} tabIndex={-1} className="asset-move__item"
          aria-disabled={choice.disabled || undefined} title={choice.reason}
          onClick={() => { if (!choice.disabled) onChoose(choice); }}>
          <span className="asset-move__label">{choice.label}</span>
          {choice.disabled && choice.reason && <span className="asset-move__reason">{choice.reason}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
