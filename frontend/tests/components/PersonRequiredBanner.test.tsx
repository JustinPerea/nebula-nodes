import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PersonRequiredBanner } from '../../src/components/PersonRequiredBanner';
import { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } from '../../src/lib/personSession';

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).nebulaDesktop;
  resetPersonSessionForTests();
});

// Round 8 (review 6 NIT-3): the visible notice is no longer a live region; one polite region,
// mounted and empty, says its words. So the notice is found by its class, and what is said by
// the region.
const notice = () => document.querySelector('.person-required');
const said = () => screen.getByRole('status').textContent;

describe('PersonRequiredBanner', () => {
  it('stays hidden until a person-only action is refused, then explains and dismisses', () => {
    render(<PersonRequiredBanner />);
    expect(notice()).toBeNull();
    expect(said()).toBe('');
    act(() => reportPersonRequired());
    // GM - Design, 2026-10-23 (round 4), verbatim.
    expect(notice()!.textContent).toBe(
      "This tab isn’t connected as you. Open the link Nebula printed when it started.×");
    expect(said()).toBe("This tab isn’t connected as you. Open the link Nebula printed when it started.");
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(notice()).toBeNull();
    act(() => reportPersonRequired());
    expect(notice()).toBeTruthy();
    // GM r29 item 3 (PR #200 fix round 19): a link taken in isn't proof; the
    // server promoting this tab (a verified hello) hides it.
    act(() => { window.dispatchEvent(new CustomEvent('nebula:person-connected')); });
    expect(notice()).toBeTruthy();
    act(() => notePersonPromoted());
    expect(notice()).toBeNull();
    expect(said()).toBe('');
  });

  it("in the desktop app, says GM's app banner (round 4), chosen by the preload bridge", () => {
    // The flag the preload sets (desktop/preload.cjs, read by inDesktopShell()).
    Object.defineProperty(window, 'nebulaDesktop', {
      value: { apiBaseUrl: 'http://127.0.0.1:56789', wsBaseUrl: 'ws://127.0.0.1:56789' }, configurable: true, writable: true,
    });
    render(<PersonRequiredBanner />);
    act(() => reportPersonRequired());
    // GM - Design, 2026-10-23 (round 4), verbatim.
    expect(notice()!.textContent).toBe("This window isn’t connected as you. Quit Nebula and open it again.×");
    expect(said()).toBe("This window isn’t connected as you. Quit Nebula and open it again.");
  });
});
