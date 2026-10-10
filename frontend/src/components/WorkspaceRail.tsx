import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  CircleHelp,
  FolderHeart,
  History,
  LibraryBig,
  Plus,
  Search,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { useUIStore, type LeftDock } from '../store/uiStore';
import type { OnboardingTarget } from '../lib/onboarding';
import '../styles/workspace-rail.css';

interface RailItemProps {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  active?: boolean;
  primary?: boolean;
  shortcut?: string;
  onboardingTarget?: OnboardingTarget;
}

function RailItem({ label, icon: Icon, onClick, active = false, primary = false, shortcut, onboardingTarget }: RailItemProps) {
  const tooltip = shortcut ? `${label} · ${shortcut}` : label;
  return (
    <button
      type="button"
      className={`workspace-rail__item${primary ? ' workspace-rail__item--primary' : ''}${active ? ' workspace-rail__item--active' : ''}`}
      data-rail-item
      data-onboarding-target={onboardingTarget}
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
  const commonsEnabled = useUIStore((s) => s.commonsEnabled);
  const enterCommons = useUIStore((s) => s.enterCommons);
  const startOnboarding = useUIStore((s) => s.startOnboarding);

  const toggleDock = (dock: LeftDock) => {
    setLeftDock(leftDock === dock ? null : dock);
  };

  // Drawers grow out of the button that opened them. Publish that button's
  // center before the drawer mounts so its transform-origin points at the rail.
  useLayoutEffect(() => {
    if (!leftDock) return;
    // Measured from layout, not the button's on-screen box: the shell may still be
    // scaling open, and the drawer should point at where the button settles.
    const nav = navRef.current;
    const shell = nav?.querySelector<HTMLElement>('.workspace-rail__shell');
    const button = shell?.querySelector<HTMLElement>('.workspace-rail__item--active');
    if (!nav || !shell || !button) return;
    const publish = () => {
      const center = nav.getBoundingClientRect().top + shell.offsetTop + shell.clientTop + button.offsetTop + button.offsetHeight / 2;
      document.documentElement.style.setProperty('--workspace-dock-origin-y', `${Math.round(center)}px`);
    };
    publish();
    // The rail is centered in the window, so a resize moves the button.
    window.addEventListener('resize', publish);
    return () => window.removeEventListener('resize', publish);
  }, [leftDock]);

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
      className={`workspace-rail${leftDock ? ' workspace-rail--open' : ''}`}
      aria-label="Workspace navigation"
      onKeyDown={onRailKeyDown}
    >
      <div className="workspace-rail__shell">
        <div className="workspace-rail__group workspace-rail__group--top">
          <RailItem
            label="Add nodes"
            onboardingTarget="nodes"
            icon={Plus}
            primary
            active={leftDock === 'library'}
            onClick={() => toggleDock('library')}
          />
          {commonsEnabled && <RailItem label="Open Commons" icon={LibraryBig} onClick={enterCommons} />}
          <div className="workspace-rail__divider" aria-hidden="true" />
          <RailItem
            label="Open assets"
            icon={FolderHeart}
            active={leftDock === 'assets'}
            onClick={() => toggleDock('assets')}
          />
          <RailItem
            label="Open run history"
            onboardingTarget="history"
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
          <RailItem label="Open help and onboarding" onboardingTarget="help" icon={CircleHelp} onClick={startOnboarding} />
          <RailItem
            label="Open settings"
            onboardingTarget="settings"
            icon={Settings}
            active={leftDock === 'settings'}
            onClick={() => toggleDock('settings')}
          />
        </div>
      </div>
    </nav>
  );
}
