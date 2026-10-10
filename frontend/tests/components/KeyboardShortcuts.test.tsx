import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KeyboardShortcuts } from '../../src/components/KeyboardShortcuts';
import { displayKey, SHORTCUTS_OPEN_EVENT } from '../../src/lib/keyboardShortcuts';
import { useUIStore } from '../../src/store/uiStore';

const initialUI = useUIStore.getState();

describe('KeyboardShortcuts', () => {
  beforeEach(() => { useUIStore.setState({ viewMode: 'canvas' }); });
  afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); });

  it('opens with ? on the canvas, lists the shortcuts, and closes with Escape', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveTextContent('Fit the graph');
    expect(dialog).toHaveTextContent('Run graph');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens from the command palette event, but not while typing', () => {
    render(<KeyboardShortcuts />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: '?', shiftKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => { window.dispatchEvent(new CustomEvent(SHORTCUTS_OPEN_EVENT)); });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    field.remove();
  });

  it('shows platform modifier keys', () => {
    expect(displayKey('Mod', true)).toBe('⌘');
    expect(displayKey('Mod', false)).toBe('Ctrl');
    expect(displayKey('Shift', true)).toBe('⇧');
  });
});
