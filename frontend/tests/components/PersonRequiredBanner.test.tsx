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
    expect(screen.getByRole('status').textContent).toMatch(/isn't connected as you/);
    expect(screen.getByRole('status').textContent).toMatch(/link the backend printed/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => reportPersonRequired());
    expect(screen.getByRole('status')).toBeTruthy();
    act(() => { window.dispatchEvent(new CustomEvent('nebula:person-connected')); });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
