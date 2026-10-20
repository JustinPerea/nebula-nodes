import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AgentLog } from './AgentLog';
import { AGENT_LOG_HIDDEN_NOTICE_MS, keepClearOfRect } from './agentLogLayout';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';

function setChatVisible(visible: boolean) {
  useUIStore.setState((state) => ({
    panels: { ...state.panels, chat: { ...state.panels.chat, visible } },
  }));
}

describe('AgentLog visibility (Q38)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUIStore.setState({ agentLogEnabled: true });
    useAgentLogStore.getState().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows with the chat closed', () => {
    setChatVisible(false);
    render(<AgentLog />);
    expect(screen.getByRole('button', { name: /agent log/i, expanded: false })).not.toBeNull();
    expect(document.body.classList.contains('agent-log-enabled')).toBe(true);
  });

  it('shows with the chat open too', () => {
    setChatVisible(true);
    render(<AgentLog />);
    expect(screen.getByRole('button', { name: /agent log/i, expanded: false })).not.toBeNull();
  });

  it('renders nothing while the preference is off', () => {
    useUIStore.setState({ agentLogEnabled: false });
    const { container } = render(<AgentLog />);
    expect(container.innerHTML).toBe('');
    expect(document.body.classList.contains('agent-log-enabled')).toBe(false);
  });

  it('hides from its own control, sets the same preference, and offers Show again', () => {
    vi.useFakeTimers();
    setChatVisible(false);
    render(<AgentLog />);

    // detail 0: activated from the keyboard (Enter or Space).
    fireEvent.click(screen.getByRole('button', { name: 'Hide agent log' }), { detail: 0 });

    expect(useUIStore.getState().agentLogEnabled).toBe(false);
    expect(window.localStorage.getItem('nebula:agentLog:enabled')).toBe('0');
    expect(screen.queryByRole('button', { name: /agent log/i, expanded: false })).toBeNull();
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('Agent log hidden');
    // The docked chat keeps its room above the notice until the notice goes.
    expect(document.body.classList.contains('agent-log-reserved')).toBe(true);
    const showAgain = screen.getByRole('button', { name: 'Show again' });
    // Focus lands on the way back, so a keyboard user is not dropped on <body>.
    expect(document.activeElement).toBe(showAgain);

    fireEvent.click(showAgain);
    // ...and returns to the log's header once it is back.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /agent log/i, expanded: false }));
    expect(useUIStore.getState().agentLogEnabled).toBe(true);
    expect(window.localStorage.getItem('nebula:agentLog:enabled')).toBe('1');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: /agent log/i, expanded: false })).not.toBeNull();
  });

  it('lets the notice go after a few seconds; Settings stays the way back', () => {
    vi.useFakeTimers();
    render(<AgentLog />);
    // detail 1: a mouse click, so focus is not moved into the notice.
    fireEvent.click(screen.getByRole('button', { name: 'Hide agent log' }), { detail: 1 });
    expect(screen.getByRole('status')).not.toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Show again' }));
    act(() => { vi.advanceTimersByTime(AGENT_LOG_HIDDEN_NOTICE_MS + 300); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.classList.contains('agent-log-reserved')).toBe(false);
    expect(useUIStore.getState().agentLogEnabled).toBe(false);
  });

  it('keeps the notice while it holds keyboard focus; Escape lets it go', () => {
    vi.useFakeTimers();
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide agent log' }), { detail: 0 });
    act(() => { vi.advanceTimersByTime(AGENT_LOG_HIDDEN_NOTICE_MS * 2); });
    const showAgain = screen.getByRole('button', { name: 'Show again' });
    expect(document.activeElement).toBe(showAgain);
    fireEvent.keyDown(showAgain, { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(useUIStore.getState().agentLogEnabled).toBe(false);
  });

  it('moves focus to the chat launcher on Escape instead of dropping it to <body>', () => {
    vi.useFakeTimers();
    const launcher = document.createElement('button');
    launcher.className = 'panel-launcher--chat';
    document.body.appendChild(launcher);
    try {
      render(<AgentLog />);
      fireEvent.click(screen.getByRole('button', { name: 'Hide agent log' }), { detail: 0 });
      fireEvent.keyDown(screen.getByRole('button', { name: 'Show again' }), { key: 'Escape' });
      expect(document.activeElement).toBe(launcher);
    } finally {
      launcher.remove();
    }
  });

  it('hides from the keyboard without starting a drag or toggling the list', () => {
    render(<AgentLog />);
    const hide = screen.getByRole('button', { name: 'Hide agent log' });
    hide.focus();
    fireEvent.keyDown(hide, { key: 'Enter' });
    fireEvent.click(hide);
    expect(useUIStore.getState().agentLogEnabled).toBe(false);
  });

  it('drops the notice when Settings turns the log back on, and does not bring it back later', () => {
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide agent log' }), { detail: 1 });
    expect(screen.queryByRole('status')).not.toBeNull();
    act(() => { useUIStore.getState().setAgentLogEnabled(true); });
    expect(screen.queryByRole('status')).toBeNull();
    act(() => { useUIStore.getState().setAgentLogEnabled(false); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not show a notice when Settings turns it off', () => {
    render(<AgentLog />);
    act(() => { useUIStore.getState().setAgentLogEnabled(false); });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('keepClearOfRect (stored drag position vs the chat launcher)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  });

  const launcher = { left: 1382, top: 842, right: 1424, bottom: 884 };

  it('lifts a log that would cover the launcher to sit above it', () => {
    const pos = { left: 1000, top: 830, anchorX: 'right' as const, anchorY: 'bottom' as const };
    const next = keepClearOfRect(pos, 424, 44, launcher, 8);
    expect(next.top).toBe(842 - 8 - 44);
    expect(next.left).toBe(1000);
    expect(next.anchorY).toBe('bottom');
  });

  it('leaves a log that does not overlap the launcher alone', () => {
    const pos = { left: 200, top: 830, anchorX: 'left' as const, anchorY: 'bottom' as const };
    expect(keepClearOfRect(pos, 424, 44, launcher, 8)).toBe(pos);
  });

  it('leaves the position alone with no launcher on screen', () => {
    const pos = { left: 1000, top: 830 };
    expect(keepClearOfRect(pos, 424, 44, null, 8)).toBe(pos);
  });
});

// Review (2026-10-20): a dragged log near the bottom grew downward when
// expanded, off screen and under the chat launcher; and "hidden" showed in
// the docked spot, not where the dragged log was.
describe('a dragged log (stored position)', () => {
  // jsdom has no layout: the log is 374 x 44 collapsed, 374 x 198 open.
  function stubLogSize() {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('agent-log') ? 374 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('agent-log')) return 0;
      return this.classList.contains('agent-log--open') ? 198 : 44;
    });
  }

  // Dragged left along the bottom: right edge 366 px in, bottom edge 78 px up.
  const stored = { left: 700, top: 778, anchorX: 'right', anchorY: 'bottom', offsetX: 366, offsetY: 78 };

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('nebula:agentLog:pos', JSON.stringify(stored));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    useUIStore.setState({ agentLogEnabled: true });
    useAgentLogStore.getState().clear();
    stubLogSize();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps its bottom edge when expanded, so it grows up and stays on screen', () => {
    const { container } = render(<AgentLog />);
    const log = container.querySelector('.agent-log') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: /^agent log/i }));
    // Pinned by its bottom edge (78 px up), so the taller list grows upward
    // instead of past the window's foot and under the chat launcher.
    expect(log.style.bottom).toBe('78px');
    expect(log.style.top).toBe('auto');
    expect(log.style.left).toBe('700px');
    fireEvent.click(screen.getByRole('button', { name: /^agent log/i }));
    expect(log.style.bottom).toBe('78px');
  });

  it('shows "Agent log hidden" where the dragged log was', () => {
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide agent log' }), { detail: 1 });
    const notice = screen.getByRole('status');
    expect(notice.style.right).toBe('366px');
    expect(notice.style.bottom).toBe('78px');
    expect(notice.style.left).toBe('auto');
    expect(notice.style.top).toBe('auto');
  });
});
