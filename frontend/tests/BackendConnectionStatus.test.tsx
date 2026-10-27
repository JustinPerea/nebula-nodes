import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../src/lib/backend', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));

import { BACKEND_PROBE_INTERVAL_MS, BackendConnectionStatus } from '../src/components/BackendConnectionStatus';
import { isBackendOffline } from '../src/lib/backendConnection';

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('BackendConnectionStatus', () => {
  it('surfaces backend loss and clears the warning after recovery', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<BackendConnectionStatus />);

    await act(async () => { await Promise.resolve(); });
    // GM, round 13 of PR #114, word for word.
    expect(screen.getByRole('status').textContent).toBe('Nebula is offline. Reconnecting…');
    expect(isBackendOffline()).toBe(true);

    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKEND_PROBE_INTERVAL_MS); });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(isBackendOffline()).toBe(false);
  });

  it('stays visually quiet while the backend is healthy', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    render(<BackendConnectionStatus />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
