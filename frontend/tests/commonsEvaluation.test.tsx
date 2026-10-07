import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommonsEvaluation } from '../src/components/commons/CommonsEvaluation';
import { evaluationComplete, type EvaluationBatch } from '../src/lib/commonsEvaluationTypes';

const api = vi.hoisted(() => ({ get: vi.fn(), prepare: vi.fn(), image: vi.fn(), accents: vi.fn(), labels: vi.fn(), seal: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({ commonsEvaluationApi: api }));
const batch = (): EvaluationBatch => ({ revision: 0, state: 'open', denominator: 150, tuning_count: 30, manifest_hash: 'fixture', sealed: null, seal_hash: null,
  closed: null, close_hash: null,
  fields: { type_style: ['none'] }, axes: ['quiet_loud'], roles: ['accent'], keywords: ['geometric_type'], excluded_count: 0, assisted_reviews: 0,
  items: [{ position: 0, image_sha256: 'fixture-image', width: 40, height: 32, accent_locked: false, labels: null }] });

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(batch()); api.image.mockResolvedValue(new Blob(['fixture']));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Image', class {
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not reveal palette until the server accepts accent observations', async () => {
  const result = batch(); result.revision = 1; result.items[0].accent_locked = true;
  result.items[0].palette = [{ index: 0, hex: '#ff0000', share: 1 }];
  api.accents.mockResolvedValue(result);
  render(<CommonsEvaluation />);
  await screen.findByText('What catches your eye?');
  expect(screen.queryByText('Assign color roles')).toBeNull();
  const none = screen.getByLabelText('I don’t see any accent colors');
  await waitFor(() => expect((none as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(none);
  fireEvent.click(screen.getByText('Save accents & reveal labels'));
  await screen.findByText('Assign color roles');
  expect(api.accents).toHaveBeenCalledWith(0, 0, [], true);
  expect(screen.getByLabelText('quiet loud').getAttribute('aria-valuetext')).toBe('Unanswered');
});

it('preserves unsaved labels when a stale revision is rejected', async () => {
  const value = batch(); value.items[0].accent_locked = true; value.items[0].palette = [{ index: 0, hex: '#ff0000', share: 1 }];
  api.get.mockResolvedValue(value); api.labels.mockRejectedValue(new Error('Labels changed in another window. Reload before saving.'));
  render(<CommonsEvaluation />);
  await screen.findByText('Set neutral');
  fireEvent.click(screen.getByText('Set neutral'));
  expect(screen.getByLabelText('quiet loud').getAttribute('aria-valuetext')).toBe('0');
  fireEvent.click(screen.getByText('Save labels'));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('quiet loud').getAttribute('aria-valuetext')).toBe('0');
  expect((screen.getByText('Review batch · 0 / 15') as HTMLButtonElement).disabled).toBe(true);
});

it('does not treat untouched zero sliders, missing keywords, or review flags as complete', () => {
  const value = batch(); const item = value.items[0]; item.accent_locked = true;
  item.palette = [{ index: 0, hex: '#ff0000', share: 1 }];
  item.labels = { tags: { type_style: 'none' }, axes: {}, palette_roles: { '0': 'accent' }, keywords: [], no_keywords: true, flagged: false };
  expect(evaluationComplete(item, value)).toBe(false);
  item.labels.axes.quiet_loud = 0; expect(evaluationComplete(item, value)).toBe(true);
  item.labels.flagged = true; expect(evaluationComplete(item, value)).toBe(false);
  item.labels.flagged = false; item.labels.no_keywords = false; expect(evaluationComplete(item, value)).toBe(false);
});

it('offers the assisted close instead of sealing once the agent has graded', async () => {
  const value = batch(); value.assisted_reviews = 15;
  api.get.mockResolvedValue(value);
  render(<CommonsEvaluation />);
  fireEvent.click(await screen.findByText('Review batch · 0 / 15'));
  expect(screen.queryByText('Seal all 15 labels')).toBeNull();
  expect(screen.getByText(/can no longer be sealed as blind labels/)).toBeTruthy();
  fireEvent.click(screen.getByText('Close review & resume library analysis…'));
  expect(screen.getByRole('alertdialog').textContent).toContain('an assisted review record');
});

it('offers sealing and the abandon close before any agent grade', async () => {
  render(<CommonsEvaluation />);
  fireEvent.click(await screen.findByText('Review batch · 0 / 15'));
  expect(screen.getByText('Seal all 15 labels')).toBeTruthy();
  expect(screen.getByText('Close without sealing…')).toBeTruthy();
});
