import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withFocusFixup } from './helpers/focusFixup';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommonsCloseBatch } from '../src/components/commons/CommonsCloseBatch';
import { RequestFailedError } from '../src/lib/errorCopy';

const api = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({ commonsEvaluationApi: api, commonsReviewApi: { get: vi.fn(async () => null) } }));

// Round 18l: Chrome's focus fixup, so focus asserted here is where Chrome would leave it.
const fixup = withFocusFixup();
beforeEach(() => { vi.clearAllMocks(); api.close.mockResolvedValue({ state: 'closed' }); });
afterEach(() => cleanup());

it('asks for confirmation before closing and cancel makes no call', () => {
  render(<CommonsCloseBatch revision={4} assisted reviewed={2} total={15} disabled={false} onClosed={vi.fn()} />);
  fireEvent.click(screen.getByText('Close review & resume library analysis…'));
  expect(api.close).not.toHaveBeenCalled();
  const dialog = screen.getByRole('alertdialog');
  expect(dialog.textContent).toContain('not blind ground truth');
  expect(dialog.textContent).toContain('You can keep agreeing with or correcting grades after closing. You’ve reviewed 2 of 15 so far. No new grades will be requested.');
  expect(dialog.textContent).toContain('This can’t be undone.');
  expect(document.activeElement?.textContent).toBe('Cancel');
  fireEvent.click(screen.getByText('Cancel'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(api.close).not.toHaveBeenCalled();
});

it('closes once with the current revision after confirmation', async () => {
  const onClosed = vi.fn();
  render(<CommonsCloseBatch revision={4} assisted reviewed={0} total={15} disabled={false} onClosed={onClosed} />);
  fireEvent.click(screen.getByText('Close review & resume library analysis…'));
  fireEvent.click(screen.getByText('Close as assisted review'));
  await waitFor(() => expect(onClosed).toHaveBeenCalledWith({ state: 'closed' }));
  expect(api.close).toHaveBeenCalledTimes(1);
  expect(api.close).toHaveBeenCalledWith(4, expect.any(AbortSignal));
});

it('shows the server refusal and stays open', async () => {
  // Round 3e: the API's typed refusal, as commonsApi throws it (the backend's words in `detail`).
  // Round 18j (GM r40): said in the because form, never the backend's own words.
  api.close.mockRejectedValue(new RequestFailedError("Couldn't close the batch.", 409, { detail: 'A grading attempt is still running. Close after it finishes.' }));
  render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
  fireEvent.click(screen.getByText('Close without sealing…'));
  fireEvent.click(screen.getByText('Close without sealing'));
  expect((await screen.findByRole('alert')).textContent).toBe('Nebula couldn’t close the batch because a grade is still running. Close the batch again when it finishes.');
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});

it('cannot be opened while disabled', () => {
  render(<CommonsCloseBatch revision={1} assisted disabled onClosed={vi.fn()} />);
  expect((screen.getByText('Close review & resume library analysis…') as HTMLButtonElement).disabled).toBe(true);
});

it('cannot confirm once the parent disables it mid-dialog: an aria lock, never native (review 17 MEDIUM-2)', () => {
  const { rerender } = render(<CommonsCloseBatch revision={1} assisted disabled={false} onClosed={vi.fn()} />);
  fireEvent.click(screen.getByText('Close review & resume library analysis…'));
  const close = screen.getByText('Close as assisted review') as HTMLButtonElement;
  close.focus();
  rerender(<CommonsCloseBatch revision={1} assisted disabled onClosed={vi.fn()} />);
  fixup.current().flush();
  expect(close.disabled).toBe(false);
  expect(close.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(close);
  fireEvent.click(close);
  expect(api.close).not.toHaveBeenCalled();
  expect((screen.getByText('Cancel') as HTMLButtonElement).disabled).toBe(false);
});
