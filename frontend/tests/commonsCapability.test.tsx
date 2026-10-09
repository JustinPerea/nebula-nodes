import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommonsCapability } from '../src/hooks/useCommonsCapability';
import { fetchCommonsEnabled } from '../src/lib/commonsCapability';
import { WorkspaceRail } from '../src/components/WorkspaceRail';
import { CommonsView } from '../src/components/commons/CommonsView';
import { useUIStore } from '../src/store/uiStore';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
const commons = vi.hoisted(() => ({ status: vi.fn(), collections: vi.fn(), search: vi.fn(), workerStart: vi.fn(), workerStop: vi.fn() }));
vi.mock('../src/lib/backend', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/commonsApi', () => ({ commonsApi: commons, filtersToRequest: () => ({ query: '', filters: {} }) }));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsSettings', () => ({ CommonsSettings: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function Shell() {
  useCommonsCapability();
  const view = useUIStore((state) => state.viewMode);
  const enabled = useUIStore((state) => state.commonsEnabled);
  return <>{enabled && view === 'commons' ? <CommonsView /> : <WorkspaceRail />}</>;
}

beforeEach(() => {
  vi.resetAllMocks();
  history.replaceState({}, '', '/');
  useUIStore.setState({ viewMode: 'canvas', commonsEnabled: false, commonsReturnView: 'canvas', onboardingActive: false });
  commons.collections.mockResolvedValue([]);
  commons.status.mockResolvedValue({ worker: { running: false, state: 'idle' }, queue: {} });
  commons.search.mockResolvedValue({ results: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Commons backend capability', () => {
  it.each([json({ enabled: false }), json({}, 404), json({ enabled: 'true' }), json(null)])('defaults off for unavailable or non-boolean capability replies', async (response) => {
    transport.fetch.mockResolvedValue(response);
    expect(await fetchCommonsEnabled()).toBe(false);
    expect(transport.fetch).toHaveBeenCalledWith('/api/capabilities/commons');
  });
  it('defaults off on network failure', async () => {
    transport.fetch.mockRejectedValue(new Error('offline'));
    expect(await fetchCommonsEnabled()).toBe(false);
  });
  it('does not touch Commons status, stores or auth in a disabled app', async () => {
    transport.fetch.mockResolvedValue(json({ enabled: false }));
    render(<Shell />);
    await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Open Commons' })).toBeNull();
    useUIStore.getState().enterCommons();
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(commons.status).not.toHaveBeenCalled();
    expect(commons.collections).not.toHaveBeenCalled();
    expect(commons.search).not.toHaveBeenCalled();
    expect(transport.fetch.mock.calls.map(([path]) => path)).toEqual(['/api/capabilities/commons']);
  });
  it.each(['canvas', 'create'] as const)('waits for explicit navigation after backend opt-in, then restores %s', async (viewMode) => {
    useUIStore.setState({ viewMode });
    transport.fetch.mockResolvedValue(json({ enabled: true, scopedAgents: ['claude', 'codex'] }));
    render(<Shell />);
    const open = await screen.findByRole('button', { name: 'Open Commons' });
    expect(commons.status).not.toHaveBeenCalled();
    fireEvent.click(open);
    expect(await screen.findByRole('tablist', { name: 'Commons sections' })).toBeTruthy();
    await waitFor(() => expect(commons.status).toHaveBeenCalledTimes(1));
    expect(commons.workerStart).not.toHaveBeenCalled();
    expect(commons.workerStop).not.toHaveBeenCalled();
    expect(screen.getAllByRole('heading', { name: 'Commons', level: 1 })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: `Back to ${viewMode === 'create' ? 'Creator Studio' : 'Canvas'}` }));
    expect(useUIStore.getState().viewMode).toBe(viewMode);
    expect(await screen.findByRole('button', { name: 'Open Commons' })).toBeTruthy();
  });
  it('ignores a Commons hash while off and opens its route only after capability opt-in', async () => {
    history.replaceState({}, '', '/#commons');
    transport.fetch.mockResolvedValue(json({ enabled: false }));
    const first = render(<Shell />);
    await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(1));
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(commons.status).not.toHaveBeenCalled();
    first.unmount();
    transport.fetch.mockResolvedValue(json({ enabled: true }));
    render(<Shell />);
    expect(await screen.findByRole('tablist', { name: 'Commons sections' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(location.hash).toBe('');
  });
  it('restores the previous workspace when leaving the Commons hash route', async () => {
    transport.fetch.mockResolvedValue(json({ enabled: true }));
    render(<Shell />);
    await screen.findByRole('button', { name: 'Open Commons' });
    await act(async () => { location.hash = '#commons'; window.dispatchEvent(new Event('hashchange')); });
    expect(await screen.findByRole('tablist', { name: 'Commons sections' })).toBeTruthy();
    await act(async () => { location.hash = ''; window.dispatchEvent(new Event('hashchange')); });
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });
  it('cannot let a stale capability reply enable a replaced app', async () => {
    let finish!: (value: Response) => void;
    transport.fetch.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    const view = render(<Shell />);
    view.unmount();
    await act(async () => { finish(json({ enabled: true })); });
    expect(useUIStore.getState().commonsEnabled).toBe(false);
  });
  it('preserves the Create session and dock state and restores them when capability is withdrawn', () => {
    useUIStore.getState().setLeftDock('history');
    useUIStore.setState({ viewMode: 'create', createSessionId: 'current-create', commonsEnabled: true });
    const panels = useUIStore.getState().panels;
    useUIStore.getState().enterCommons();
    useUIStore.getState().enterCommons();
    expect(useUIStore.getState().commonsReturnView).toBe('create');
    useUIStore.getState().setCommonsEnabled(false);
    expect(useUIStore.getState().viewMode).toBe('create');
    expect(useUIStore.getState().createSessionId).toBe('current-create');
    expect(useUIStore.getState().panels).toBe(panels);
    expect(useUIStore.getState().leftDock).toBe('history');
  });
});
