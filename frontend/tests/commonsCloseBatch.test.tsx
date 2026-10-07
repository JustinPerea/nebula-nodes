import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommonsCloseBatch } from '../src/components/commons/CommonsCloseBatch';

const api = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({ commonsEvaluationApi: api }));

beforeEach(() => { vi.clearAllMocks(); api.close.mockResolvedValue({ state: 'closed' }); });
afterEach(() => cleanup());

it('asks for confirmation before closing and cancel makes no call', () => {
  render(<CommonsCloseBatch revision={4} assisted reviewed={2} total={15} disabled={false} onClosed={vi.fn()} />);
  fireEvent.click(screen.getByText('Close review & resume library analysis…'));
  expect(api.close).not.toHaveBeenCalled();
  const dialog = screen.getByRole('alertdialog');
  expect(dialog.textContent).toContain('not blind ground truth');
  expect(dialog.textContent).toContain('2 / 15 reviewed');
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
  expect(api.close).toHaveBeenCalledWith(4);
});

it('shows the server refusal and stays open', async () => {
  api.close.mockRejectedValue(new Error('A grading attempt is still running. Close after it finishes.'));
  render(<CommonsCloseBatch revision={1} assisted={false} disabled={false} onClosed={vi.fn()} />);
  fireEvent.click(screen.getByText('Close without sealing…'));
  fireEvent.click(screen.getByText('Close without sealing'));
  expect((await screen.findByRole('alert')).textContent).toContain('still running');
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});

it('cannot be opened while disabled', () => {
  render(<CommonsCloseBatch revision={1} assisted disabled onClosed={vi.fn()} />);
  expect((screen.getByText('Close review & resume library analysis…') as HTMLButtonElement).disabled).toBe(true);
});

it('cannot confirm once the parent disables it mid-dialog', () => {
  const { rerender } = render(<CommonsCloseBatch revision={1} assisted disabled={false} onClosed={vi.fn()} />);
  fireEvent.click(screen.getByText('Close review & resume library analysis…'));
  rerender(<CommonsCloseBatch revision={1} assisted disabled onClosed={vi.fn()} />);
  expect((screen.getByText('Close as assisted review') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByText('Cancel') as HTMLButtonElement).disabled).toBe(false);
});
