import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const clearProjectMock = vi.fn();
vi.mock('../src/lib/backend', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../src/lib/currentProject', () => ({ clearCurrentProjectCache: () => clearProjectMock() }));

import { BACKEND_PROBE_INTERVAL_MS, BackendConnectionStatus } from '../src/components/BackendConnectionStatus';

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  clearProjectMock.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('BackendConnectionStatus', () => {
  it('surfaces backend loss and clears the warning after recovery', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<BackendConnectionStatus />);

    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('status')).toHaveTextContent('Backend offline');

    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKEND_PROBE_INTERVAL_MS); });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(clearProjectMock).toHaveBeenCalledTimes(1);
  });

  it('stays visually quiet while the backend is healthy', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    render(<BackendConnectionStatus />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
