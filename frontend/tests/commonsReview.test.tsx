import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommonsReview } from '../src/components/commons/CommonsReview';
import type { ReviewBatch } from '../src/lib/commonsReviewTypes';

const api = vi.hoisted(() => ({ get: vi.fn(), propose: vi.fn(), accept: vi.fn(), image: vi.fn(), close: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({ commonsReviewApi: api, commonsEvaluationApi: { image: api.image, close: api.close } }));
const batch = (): ReviewBatch => ({ mode: 'assisted_review', independent_ground_truth: false, manifest_hash: 'fixture',
  state: 'open', batch_revision: 7, closed_at: null, close_hash: null,
  model: 'fixture-model', fields: { type_style: ['none', 'serif'] }, axes: ['quiet_loud'], roles: ['accent'], keywords: ['geometric_type'], call_budget: 0, attempts: 1,
  items: [{ position: 0, image_sha256: 'fixture', width: 40, height: 32, status: 'ready', revision: 1,
    palette: [{ index: 0, hex: '#ff0000', share: 1 }], reviewed_labels: null, reviewer: null, reviewed_at: null, error: null,
    proposal: { model: 'fixture-model', prompt_version: 'fixture-prompt',
      labels: { tags: { type_style: 'none' }, axes: { quiet_loud: 0.25 }, palette_roles: { '0': 'accent' }, keywords: [], no_keywords: true, flagged: false },
      fields: { summary: { value: 'An agent proposal', why: 'A visible feature' }, composition_notes: { value: 'Open space', why: 'A margin' },
        type_style: { value: 'none', why: 'No text is visible.' }, axes: { quiet_loud: { value: 0.25, why: 'A bright focal point.' } } } } }] });

beforeEach(() => {
  vi.clearAllMocks(); api.get.mockResolvedValue(batch()); api.image.mockResolvedValue(new Blob(['fixture']));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows proposals immediately and accepts only after the human clicks', async () => {
  const value = batch(); const item = value.items[0]; item.reviewed_at = '2026-09-26'; item.reviewed_labels = item.proposal!.labels; item.revision++;
  api.accept.mockResolvedValue(value);
  render(<CommonsReview />);
  await screen.findByText('An agent proposal');
  expect(screen.getByText('Agent: No text is visible.')).toBeTruthy();
  expect(screen.queryByText('What catches your eye?')).toBeNull();
  expect(api.accept).not.toHaveBeenCalled(); expect(api.propose).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByText('Agree & next')[0]);
  await screen.findByText('1 / 1 reviewed');
  expect(api.accept).toHaveBeenCalledWith(0, 1, batch().items[0].proposal!.labels);
});

it('preserves corrections and navigation guard if a stale save fails', async () => {
  api.accept.mockRejectedValue(new Error('This review changed in another window. Reload before saving.'));
  render(<CommonsReview />);
  await screen.findByText('Edit grades'); fireEvent.click(screen.getByText('Edit grades'));
  fireEvent.change(screen.getByLabelText('type style'), { target: { value: 'serif' } });
  expect((screen.getByRole('button', { name: /Reference 01/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getAllByText('Save corrections & next')[0]);
  await screen.findByRole('alert');
  expect((screen.getByLabelText('type style') as HTMLSelectElement).value).toBe('serif');
  expect(batch().items[0].proposal!.labels.tags.type_style).toBe('none');
  fireEvent.click(screen.getByText('Discard changes'));
  await waitFor(() => expect((screen.getByLabelText('type style') as HTMLSelectElement).value).toBe('none'));
});

it('closes only after confirmation, then reloads the review', async () => {
  const closed = batch(); closed.state = 'closed'; closed.closed_at = '2026-09-27T12:00:00Z'; closed.close_hash = 'a'.repeat(64);
  api.get.mockResolvedValueOnce(batch()).mockResolvedValue(closed);
  api.close.mockResolvedValue({ state: 'closed' });
  render(<CommonsReview />);
  fireEvent.click(await screen.findByText('Close review & resume library analysis…'));
  expect(api.close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Close as assisted review'));
  await screen.findByText(/Closed as assisted review ·/);
  expect(api.close).toHaveBeenCalledWith(7);
  expect(screen.queryByText('Close review & resume library analysis…')).toBeNull();
  expect(screen.getAllByText('Agree & next').length).toBeGreaterThan(0);
});

it('shows the committed close even when the reload fails, and stops offering new grades', async () => {
  const open = batch(); open.call_budget = 15;
  open.items.push({ ...open.items[0], position: 1, status: 'pending', proposal: null, revision: 0 });
  api.get.mockResolvedValueOnce(open).mockRejectedValue(new Error('offline'));
  api.close.mockResolvedValue({ state: 'closed', revision: 8, close_hash: 'b'.repeat(64), closed: { closed_at: '2026-09-27T12:00:00Z' } });
  render(<CommonsReview />);
  expect(await screen.findByText('Generate remaining grades')).toBeTruthy();
  fireEvent.click(screen.getByText('Close review & resume library analysis…'));
  fireEvent.click(screen.getByText('Close as assisted review'));
  expect((await screen.findByText(/Closed as assisted review ·/)).textContent).toContain('b'.repeat(64));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Generate remaining grades')).toBeNull();
});

it('does not offer closing while a grade is running', async () => {
  const value = batch(); value.items[0].status = 'running'; value.items[0].proposal = null;
  api.get.mockResolvedValue(value);
  render(<CommonsReview />);
  const button = await screen.findByText('Close review & resume library analysis…');
  expect((button as HTMLButtonElement).disabled).toBe(true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function capturePoll() {
  const timer = vi.spyOn(window, 'setInterval');
  return () => {
    const callback = timer.mock.calls[0][0];
    if (typeof callback !== 'function') throw new Error('Review poll was not registered');
    act(() => callback());
  };
}

it('keeps a completed proposal when an older poll resolves afterward', async () => {
  const open = batch(); open.call_budget = 15; open.attempts = 0;
  open.items[0].status = 'pending'; open.items[0].proposal = null; open.items[0].revision = 0;
  const ready = batch(); ready.call_budget = 15;
  const stale = deferred<ReviewBatch>();
  api.get.mockResolvedValueOnce(open).mockReturnValueOnce(stale.promise);
  api.propose.mockResolvedValue(ready);
  const poll = capturePoll();
  render(<CommonsReview />);
  await screen.findByText('Generate remaining grades');
  poll();
  fireEvent.click(screen.getByText('Generate remaining grades'));
  await screen.findByText('An agent proposal');
  await act(async () => stale.resolve(open));
  expect(screen.getByText('An agent proposal')).toBeTruthy();
  expect(screen.queryByText('Generate remaining grades')).toBeNull();
  expect(api.propose).toHaveBeenCalledTimes(1);
});

it('ignores an older failed poll after a successful proposal', async () => {
  const open = batch(); open.call_budget = 15; open.attempts = 0;
  open.items[0].status = 'pending'; open.items[0].proposal = null; open.items[0].revision = 0;
  const ready = batch(); ready.call_budget = 15;
  const stale = deferred<ReviewBatch>();
  api.get.mockResolvedValueOnce(open).mockReturnValueOnce(stale.promise);
  api.propose.mockResolvedValue(ready);
  const poll = capturePoll();
  render(<CommonsReview />);
  await screen.findByText('Generate remaining grades');
  poll();
  fireEvent.click(screen.getByText('Generate remaining grades'));
  await screen.findByText('An agent proposal');
  await act(async () => stale.reject(new Error('Older read failed')));
  expect(screen.getByText('An agent proposal')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps a saved human review when an older poll returns after acceptance', async () => {
  const stale = deferred<ReviewBatch>();
  const saved = batch(); saved.items[0].reviewed_at = '2026-10-07'; saved.items[0].revision++;
  saved.items[0].reviewed_labels = structuredClone(saved.items[0].proposal!.labels);
  api.get.mockResolvedValueOnce(batch()).mockReturnValueOnce(stale.promise);
  api.accept.mockResolvedValue(saved);
  const poll = capturePoll();
  render(<CommonsReview />);
  await screen.findByText('An agent proposal');
  poll();
  fireEvent.click(screen.getAllByText('Agree & next')[0]);
  await screen.findByText('1 / 1 reviewed');
  await act(async () => stale.resolve(batch()));
  expect(screen.getByText('1 / 1 reviewed')).toBeTruthy();
  expect(screen.getByText('YOUR SAVED REVIEW')).toBeTruthy();
});

it('does not generate or accept merely from opening, polling, navigation or editing', async () => {
  const value = batch(); value.call_budget = 15;
  value.items.push({ ...structuredClone(value.items[0]), position: 1 });
  value.items.push({ ...structuredClone(value.items[0]), position: 2, status: 'pending', proposal: null });
  api.get.mockResolvedValue(value);
  const poll = capturePoll();
  render(<CommonsReview />);
  await screen.findByText('Generate remaining grades');
  poll();
  fireEvent.click(screen.getByRole('button', { name: /Reference 02/ }));
  fireEvent.click(screen.getByText('Edit grades'));
  fireEvent.change(screen.getByLabelText('type style'), { target: { value: 'serif' } });
  poll();
  await act(async () => Promise.resolve());
  expect(api.propose).not.toHaveBeenCalled();
  expect(api.accept).not.toHaveBeenCalled();
  expect(screen.getByLabelText('type style')).toHaveValue('serif');
});

it('waits for generation to finish before accepting or editing an already-ready grade', async () => {
  const open = batch(); open.call_budget = 15;
  open.items.push({ ...structuredClone(open.items[0]), position: 1, revision: 0, status: 'pending', proposal: null });
  const generated = structuredClone(open);
  generated.items[1] = { ...structuredClone(generated.items[0]), position: 1 };
  const pending = deferred<ReviewBatch>();
  api.get.mockResolvedValue(open); api.propose.mockReturnValueOnce(pending.promise);
  const saved = structuredClone(generated);
  saved.items[0].reviewed_at = '2026-10-07'; saved.items[0].reviewed_labels = structuredClone(saved.items[0].proposal!.labels);
  saved.items[0].revision++;
  api.accept.mockResolvedValue(saved);
  render(<CommonsReview />);
  fireEvent.click(await screen.findByText('Generate remaining grades'));
  expect(screen.getByText('Edit grades')).toBeDisabled();
  expect(screen.getByRole('button', { name: /Reference 02/ })).toBeDisabled();
  for (const button of screen.getAllByText('Agree & next')) {
    expect(button).toBeDisabled(); fireEvent.click(button);
  }
  expect(api.accept).not.toHaveBeenCalled();
  await act(async () => pending.resolve(generated));
  expect(screen.getByText('Edit grades')).toBeEnabled();
  fireEvent.click(screen.getAllByText('Agree & next')[0]);
  await screen.findByText('1 / 2 reviewed');
  expect(api.accept).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: /Reference 01/ }));
  expect(screen.getByText('YOUR SAVED REVIEW')).toBeTruthy();
});

it('does not start generation while an explicit human acceptance is still pending', async () => {
  const open = batch(); open.call_budget = 15;
  open.items.push({ ...structuredClone(open.items[0]), position: 1, status: 'pending', proposal: null });
  const pending = deferred<ReviewBatch>();
  api.get.mockResolvedValue(open); api.accept.mockReturnValueOnce(pending.promise);
  render(<CommonsReview />);
  await screen.findByText('Generate remaining grades');
  fireEvent.click(screen.getAllByText('Agree & next')[0]);
  expect(screen.getByText('Generate remaining grades')).toBeDisabled();
  fireEvent.click(screen.getByText('Generate remaining grades'));
  expect(api.propose).not.toHaveBeenCalled();
  const saved = structuredClone(open); saved.items[0].reviewed_at = '2026-10-07';
  await act(async () => pending.resolve(saved));
  expect(screen.getByText('Generate remaining grades')).toBeEnabled();
  expect(api.propose).not.toHaveBeenCalled();
});
