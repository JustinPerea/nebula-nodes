import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceRail } from '../src/components/WorkspaceRail';
import { ChatLauncher } from '../src/components/ChatLauncher';
import { useUIStore } from '../src/store/uiStore';
import { ONBOARDING_HELP_SELECTOR, ONBOARDING_TOUR } from '../src/lib/onboarding';

describe('WorkspaceRail', () => {
  beforeEach(() => {
    useUIStore.getState().setLeftDock('library');
    useUIStore.setState({
      viewMode: 'canvas',
      commonsEnabled: false,
      onboardingActive: false,
      onboardingStep: 0,
    });
  });

  it('maps the supported workspace destinations into one accessible rail', () => {
    render(<WorkspaceRail />);

    expect(screen.getByRole('navigation', { name: 'Workspace navigation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add nodes' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Open Create studio' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open assets' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open run history' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search commands and nodes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open help and onboarding' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy();
  });

  it('provides one stable, live target for every onboarding step without taking an action', () => {
    const before = useUIStore.getState();
    render(<><WorkspaceRail /><ChatLauncher /></>);
    const names = ['Add nodes', 'Open settings', 'Open Create studio', 'Open run history', 'Toggle chat panel'];
    ONBOARDING_TOUR.forEach((step, index) => {
      const button = screen.getByRole('button', { name: names[index] });
      expect(document.querySelectorAll(step.selector)).toHaveLength(1);
      expect(document.querySelector(step.selector)).toBe(button);
    });
    expect(document.querySelector(ONBOARDING_HELP_SELECTOR)).toBe(screen.getByRole('button', { name: 'Open help and onboarding' }));
    expect(useUIStore.getState().leftDock).toBe(before.leftDock);
    expect(useUIStore.getState().viewMode).toBe(before.viewMode);
    expect(useUIStore.getState().onboardingStep).toBe(before.onboardingStep);
    expect(useUIStore.getState().panels.chat.visible).toBe(before.panels.chat.visible);
  });

  it('replaces the active drawer and closes it when selected again', () => {
    render(<WorkspaceRail />);

    fireEvent.click(screen.getByRole('button', { name: 'Open assets' }));
    expect(useUIStore.getState().leftDock).toBe('assets');
    expect(useUIStore.getState().panels.assets.visible).toBe(true);
    expect(useUIStore.getState().panels.library.visible).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Open assets' }));
    expect(useUIStore.getState().leftDock).toBeNull();
    expect(useUIStore.getState().panels.assets.visible).toBe(false);
  });

  it('stays expanded while its drawer is open and anchors the drawer to the button that opened it', () => {
    render(<WorkspaceRail />);
    const rail = screen.getByRole('navigation', { name: 'Workspace navigation' });
    const assets = screen.getByRole('button', { name: 'Open assets' });
    // The origin comes from layout (rail top + the button's offset in the
    // unscaled shell), so a shell still scaling open can't skew it.
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 8, y: 200, width: 52, height: 360 }));
    Object.defineProperty(assets, 'offsetTop', { configurable: true, value: 100 });
    Object.defineProperty(assets, 'offsetHeight', { configurable: true, value: 40 });
    expect(rail.classList.contains('workspace-rail--open')).toBe(true);

    fireEvent.click(assets);
    expect(document.documentElement.style.getPropertyValue('--workspace-dock-origin-y')).toBe('320px');

    fireEvent.click(assets);
    expect(rail.classList.contains('workspace-rail--open')).toBe(false);
  });

  it('opens search through the palette event and starts help in place', () => {
    const openPalette = vi.fn();
    window.addEventListener('nebula:command-palette-open', openPalette);
    render(<WorkspaceRail />);

    fireEvent.click(screen.getByRole('button', { name: 'Search commands and nodes' }));
    expect(openPalette).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open help and onboarding' }));
    expect(useUIStore.getState().onboardingActive).toBe(true);
    window.removeEventListener('nebula:command-palette-open', openPalette);
  });

  it('supports vertical keyboard movement and Escape drawer dismissal', () => {
    render(<WorkspaceRail />);
    const add = screen.getByRole('button', { name: 'Add nodes' });
    const create = screen.getByRole('button', { name: 'Open Create studio' });

    add.focus();
    fireEvent.keyDown(add, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(create);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useUIStore.getState().leftDock).toBeNull();
  });
});
