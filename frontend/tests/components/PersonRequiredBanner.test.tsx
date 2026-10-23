import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PersonRequiredBanner } from '../../src/components/PersonRequiredBanner';
import { reportPersonRequired } from '../../src/lib/personSession';

afterEach(() => cleanup());

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
});
