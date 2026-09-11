import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  CircleHelp,
  FolderHeart,
  History,
  Plus,
  Search,
  Settings,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useUIStore, type LeftDock } from '../store/uiStore';
import '../styles/workspace-rail.css';

interface RailItemProps {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  active?: boolean;
  primary?: boolean;
  shortcut?: string;
}

function RailItem({ label, icon: Icon, onClick, active = false, primary = false, shortcut }: RailItemProps) {
  const tooltip = shortcut ? `${label} · ${shortcut}` : label;
  return (
    <button
      type="button"
      className={`workspace-rail__item${primary ? ' workspace-rail__item--primary' : ''}${active ? ' workspace-rail__item--active' : ''}`}
      data-rail-item
      data-tooltip={tooltip}
      aria-label={label}
      aria-pressed={active || undefined}
      title={tooltip}
      onClick={onClick}
    >
      <Icon className="workspace-rail__icon" size={primary ? 24 : 20} strokeWidth={primary ? 1.8 : 1.65} aria-hidden="true" />
    </button>
  );
}

export function WorkspaceRail() {
  const navRef = useRef<HTMLElement | null>(null);
  const leftDock = useUIStore((s) => s.leftDock);
  const setLeftDock = useUIStore((s) => s.setLeftDock);
  const enterCreateView = useUIStore((s) => s.enterCreateView);
  const startOnboarding = useUIStore((s) => s.startOnboarding);

  const toggleDock = (dock: LeftDock) => {
    setLeftDock(leftDock === dock ? null : dock);
  };

  useEffect(() => {
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || !useUIStore.getState().leftDock) return;
      if (document.querySelector('[role="dialog"], .command-palette, .context-menu, .connection-popup')) return;
      useUIStore.getState().setLeftDock(null);
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, []);

  const onRailKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('[data-rail-item]') ?? []);
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % buttons.length;
    else next = current <= 0 ? buttons.length - 1 : current - 1;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <nav
      ref={navRef}
      className="workspace-rail"
      aria-label="Workspace navigation"
      onKeyDown={onRailKeyDown}
    >
      <div className="workspace-rail__group workspace-rail__group--top">
        <RailItem
          label="Add nodes"
          icon={Plus}
          primary
          active={leftDock === 'library'}
          onClick={() => toggleDock('library')}
        />
        <RailItem label="Open Create studio" icon={Sparkles} onClick={enterCreateView} />
        <div className="workspace-rail__divider" aria-hidden="true" />
        <RailItem
          label="Open assets"
          icon={FolderHeart}
          active={leftDock === 'assets'}
          onClick={() => toggleDock('assets')}
        />
        <RailItem
          label="Open run history"
          icon={History}
          active={leftDock === 'history'}
          onClick={() => toggleDock('history')}
        />
        <RailItem
          label="Search commands and nodes"
          icon={Search}
          shortcut="⌘K"
          onClick={() => window.dispatchEvent(new CustomEvent('nebula:command-palette-open'))}
        />
      </div>

      <div className="workspace-rail__group workspace-rail__group--bottom">
        <div className="workspace-rail__divider" aria-hidden="true" />
        <RailItem label="Open help and onboarding" icon={CircleHelp} onClick={startOnboarding} />
        <RailItem
          label="Open settings"
          icon={Settings}
          active={leftDock === 'settings'}
          onClick={() => toggleDock('settings')}
        />
      </div>
    </nav>
  );
}
