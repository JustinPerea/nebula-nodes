import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BOARD_TOAST_MS, BoardUndoToast } from './BoardUndoToast';

// The Studio's undo toast: it goes after a while, but not while the person
// is on it; Escape from inside it closes it; Undo runs once and closes it.

afterEach(() => { cleanup(); vi.useRealTimers(); });

const toast = (run = vi.fn()) => ({ id: 1, text: 'Removed #1', skipped: ['#2 changed since, left as is'],
  action: { label: 'Undo' as const, run } });

describe('the board undo toast', () => {
  it('says what happened and what was left, and Undo runs once', () => {
    const run = vi.fn();
    const onDismiss = vi.fn();
    render(<BoardUndoToast toast={toast(run)} onDismiss={onDismiss} />);
    const status = screen.getByRole('status', { name: 'Board undo' });
    expect(status.textContent).toContain('Removed #1');
    expect(status.textContent).toContain('#2 changed since, left as is');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('goes after a while, but waits while the pointer is on it', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<BoardUndoToast toast={toast()} onDismiss={onDismiss} />);
    fireEvent.pointerEnter(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(BOARD_TOAST_MS * 2); });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerLeave(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(BOARD_TOAST_MS); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape from inside it', () => {
    const onDismiss = vi.fn();
    render(<BoardUndoToast toast={toast()} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Undo' }), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
