import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceRail } from '../src/components/WorkspaceRail';
import { useUIStore } from '../src/store/uiStore';

describe('WorkspaceRail', () => {
  beforeEach(() => {
    useUIStore.getState().setLeftDock('library');
    useUIStore.setState({
      viewMode: 'canvas',
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
