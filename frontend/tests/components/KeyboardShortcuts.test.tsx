import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KeyboardShortcuts } from '../../src/components/KeyboardShortcuts';
import { displayKey, SHORTCUTS_OPEN_EVENT } from '../../src/lib/keyboardShortcuts';
import { useUIStore } from '../../src/store/uiStore';
import { usePersonThreadStore } from '../../src/store/personThreadStore';

const initialUI = useUIStore.getState();
const initialThread = usePersonThreadStore.getState();

describe('KeyboardShortcuts', () => {
  beforeEach(() => { useUIStore.setState({ viewMode: 'canvas' }); });
  afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); usePersonThreadStore.setState(initialThread, true); });

  it('opens with ? on the canvas, lists the shortcuts, and closes with Escape', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveTextContent('Fit view');
    expect(dialog).toHaveTextContent('Run canvas');
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

  it('GM r94.2: "/" names the agent as the Message box does', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    const row = () => screen.getByText((_, el) => el?.tagName === 'DT' && /^Message /.test(el.textContent ?? ''));
    // Nothing connected: the product's name.
    expect(row().textContent).toBe('Message Claude Code');
    // A second session listening: its cursor label, as the field's placeholder reads.
    act(() => usePersonThreadStore.setState({ listeners: [{
      listenerId: 'ch_2', sessionKey: '0123456789ab', agent: { id: 'app:1', name: 'Claude Code', color: '#E8825A', verified: true },
      state: 'listening', reason: null, projectId: 'p1', since: 100, seenAt: 100,
      session: { key: '0123456789ab', ordinal: 2 } }] }));
    expect(row().textContent).toBe('Message Claude Code · 2');
  });

  it('shows platform modifier keys', () => {
    expect(displayKey('Mod', true)).toBe('⌘');
    expect(displayKey('Mod', false)).toBe('Ctrl');
    expect(displayKey('Shift', true)).toBe('⇧');
  });
});
