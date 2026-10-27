import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../src/lib/backend', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));

import { BACKEND_PROBE_INTERVAL_MS, BackendConnectionStatus, OFFLINE_LINE } from '../src/components/BackendConnectionStatus';
import { isBackendOffline, refuseEditWhileOffline, resetBackendConnectionForTests } from '../src/lib/backendConnection';

function reducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  resetBackendConnectionForTests();
  reducedMotion(false);
});

afterEach(() => vi.useRealTimers());

describe('BackendConnectionStatus', () => {
  it('surfaces backend loss in GM\'s round 14 words and leaves on reconnect', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<BackendConnectionStatus />);

    await act(async () => { await Promise.resolve(); });
    // GM, round 14 of PR #114, word for word (was "Nebula is offline. Reconnecting…").
    expect(OFFLINE_LINE).toBe('Nebula is offline. Editing is paused until it reconnects.');
    expect(screen.getByRole('status').textContent).toBe(OFFLINE_LINE);
    expect(isBackendOffline()).toBe(true);

    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKEND_PROBE_INTERVAL_MS); });

    // No "Back online" toast: the banner just leaves.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).toBe('');
    expect(isBackendOffline()).toBe(false);
  });

  it('stays visually quiet while the backend is healthy', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    render(<BackendConnectionStatus />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // Review 13, L4 (its probe U1): a slow probe's late failure, after a newer
  // probe answered OK, turned a connected tab offline.
  it('the newest probe decides: an older probe answering late is ignored', async () => {
    const calls: { resolve: (r: unknown) => void; reject: (e: unknown) => void }[] = [];
    fetchMock.mockImplementation(() => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }));
    render(<BackendConnectionStatus />);
    expect(calls).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(BACKEND_PROBE_INTERVAL_MS); });
    expect(calls).toHaveLength(2);
    await act(async () => { calls[1].resolve({ ok: true, status: 200 }); });
    await act(async () => { calls[0].reject(new TypeError('Failed to fetch')); });
    expect(isBackendOffline()).toBe(false);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('an older probe\'s late success does not hide the banner a newer failure showed', async () => {
    const calls: { resolve: (r: unknown) => void; reject: (e: unknown) => void }[] = [];
    fetchMock.mockImplementation(() => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }));
    render(<BackendConnectionStatus />);
    await act(async () => { vi.advanceTimersByTime(BACKEND_PROBE_INTERVAL_MS); });
    await act(async () => { calls[1].reject(new TypeError('Failed to fetch')); });
    await act(async () => { calls[0].resolve({ ok: true, status: 200 }); });
    expect(isBackendOffline()).toBe(true);
    expect(screen.getByRole('status').textContent).toBe(OFFLINE_LINE);
  });

  it('a blocked edit pulses the banner on a spring, at most once a second', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<BackendConnectionStatus />);
    await act(async () => { await Promise.resolve(); });
    const banner = screen.getByRole('status');
    expect(banner.getAttribute('data-pulse')).toBeNull();
    act(() => { refuseEditWhileOffline(); });
    expect(banner.getAttribute('data-pulse')).toBe('spring');
    const first = banner.getAttribute('data-pulse-seq');
    act(() => { refuseEditWhileOffline(); });
    expect(banner.getAttribute('data-pulse-seq')).toBe(first);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    act(() => { refuseEditWhileOffline(); });
    expect(banner.getAttribute('data-pulse-seq')).not.toBe(first);
    // The live region is the same element throughout: it isn't announced again.
    expect(screen.getByRole('status')).toBe(banner);
  });

  it('with reduced motion, the pulse is a colour flash', async () => {
    reducedMotion(true);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<BackendConnectionStatus />);
    await act(async () => { await Promise.resolve(); });
    act(() => { refuseEditWhileOffline(); });
    expect(screen.getByRole('status').getAttribute('data-pulse')).toBe('flash');
  });
});
