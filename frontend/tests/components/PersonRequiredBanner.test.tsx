import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PersonRequiredBanner } from '../../src/components/PersonRequiredBanner';
import { reportPersonRequired, resetPersonSessionForTests } from '../../src/lib/personSession';

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).nebulaDesktop;
  resetPersonSessionForTests();
});

describe('PersonRequiredBanner', () => {
  it('stays hidden until a person-only action is refused, then explains and dismisses', () => {
    render(<PersonRequiredBanner />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => reportPersonRequired());
    // GM - Design, 2026-10-23, verbatim.
    expect(screen.getByRole('status').textContent).toBe("This tab isn't connected as you, so Settings, proposals and "
      + 'chats are locked. Open the link Nebula printed when it started, or restart Nebula with --open.×');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => reportPersonRequired());
    expect(screen.getByRole('status')).toBeTruthy();
    act(() => { window.dispatchEvent(new CustomEvent('nebula:person-connected')); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("in the desktop app, says GM's app banner (round 2), chosen by the preload bridge", () => {
    // The flag the preload sets (desktop/preload.cjs, read by inDesktopShell()).
    Object.defineProperty(window, 'nebulaDesktop', {
      value: { apiBaseUrl: 'http://127.0.0.1:56789', wsBaseUrl: 'ws://127.0.0.1:56789' }, configurable: true, writable: true,
    });
    render(<PersonRequiredBanner />);
    act(() => reportPersonRequired());
    // GM - Design, 2026-10-23 (round 2), verbatim.
    expect(screen.getByRole('status').textContent).toBe("This window isn't connected as you, so Settings, proposals and "
      + 'chats are locked. Quit Nebula and open it again.×');
  });
});
