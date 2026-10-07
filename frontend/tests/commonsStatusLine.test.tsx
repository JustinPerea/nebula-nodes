import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusLine } from '../src/components/commons/CommonsView';
import type { CommonsStatus } from '../src/lib/commonsTypes';

vi.mock('../src/lib/commonsApi', () => ({ commonsApi: {}, commonsEvaluationApi: {}, commonsReviewApi: {}, filtersToRequest: vi.fn() }));
afterEach(() => cleanup());

const status = (patch: Partial<CommonsStatus>): CommonsStatus => ({
  worker: { state: 'idle', running: true, budget_used: 0, budget: null },
  meter: { calls: 0, cap: 20, remaining: 20, resets_at: '2026-09-28T00:00:00Z' },
  queue: { queued: 0, analyzing: 0, analysis_failed: 0, held: 0, ready: 0 }, load: 1, load_threshold: 8, ...patch,
});

it('points to closing the agent review when grades exist', () => {
  render(<StatusLine status={status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: true })} onStart={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByText('Library analysis paused · close the agent review to resume')).toBeTruthy();
});

it('waits for sealed labels on a blind batch', () => {
  render(<StatusLine status={status({ evaluation_waiting: true, evaluation_state: 'open', evaluation_assisted: false })} onStart={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByText('Library analysis paused until reference labels are sealed')).toBeTruthy();
});

it('shows the normal worker line once the batch is closed', () => {
  render(<StatusLine status={status({ evaluation_waiting: false, evaluation_state: 'closed', evaluation_assisted: true })} onStart={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByText(/Worker idle/)).toBeTruthy();
  expect(screen.queryByText(/paused/)).toBeNull();
});
