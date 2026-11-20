import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommonsLeavePopover } from '../src/components/commons/CommonsLeavePopover';
import type { LeaveAsking } from '../src/components/commons/commonsLeave';

afterEach(cleanup);

const asking = (failure: string | null): LeaveAsking => ({ anchor: null, failure, panel: null, retry: true, pending: false, slow: false, seq: 1 });
const show = (failure: string | null) => render(
  <CommonsLeavePopover asking={asking(failure)} unsaved running={false} onChoose={vi.fn()} onStay={vi.fn()} />);

describe('the leave popover’s line after a failed save', () => {
  it('is an alert when the failure says why', () => {
    show('Nebula couldn’t save your labels because the server isn’t answering. Check that Nebula is running, then try again.');
    expect(within(screen.getByRole('alertdialog')).getByRole('alert'))
      .toHaveTextContent('Nebula couldn’t save your labels because the server isn’t answering. Check that Nebula is running, then try again.');
  });

  it('raises no alert for a failure that says nothing (the offline banner says it), as before', () => {
    show('');
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByText('Nebula couldn’t save your labels.')).toBeInTheDocument();
  });

  it('asks plainly before any failure', () => {
    show(null);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByText('Your labels aren’t saved.')).toBeInTheDocument();
  });
});
