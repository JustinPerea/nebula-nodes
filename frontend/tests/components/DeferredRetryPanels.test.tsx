import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentLog, MaskPainterModal, OnboardingOverlay, RunHistoryPanel, ConnectionPopup } from '../../src/components/DeferredPanels';
import { MeshPreview, WorldPreview } from '../../src/components/nodes/DeferredViewers';
import { useUIStore } from '../../src/store/uiStore';

// Each deferred piece, wired as the app wires it, recovers from a chunk that
// failed once: on the next open (Run History, the tour, a wire drop, Paint
// Mask), from the mask painter's Try again, and for node viewers when the
// window comes back online or regains focus. The real chunks are replaced by
// stubs behind a loader that fails a set number of times. Each test uses its
// own chunk, because a chunk that has loaded stays loaded for the file.

const chunks = vi.hoisted(() => ({
  failures: new Map<string, number>(),
  loads: new Map<string, number>(),
}));

vi.mock('../../src/lib/deferredChunks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/deferredChunks')>();
  const { lazyWithPreload } = await import('../../src/lib/lazyWithPreload');
  const flaky = <M,>(name: string, module: M) => () => {
    chunks.loads.set(name, (chunks.loads.get(name) ?? 0) + 1);
    const left = chunks.failures.get(name) ?? 0;
    if (left > 0) {
      chunks.failures.set(name, left - 1);
      return Promise.reject(new Error(`chunk failed: ${name}`));
    }
    return Promise.resolve(module);
  };
  return {
    ...actual,
    DeferredRunHistoryPanel: lazyWithPreload(
      flaky('history', { RunHistoryPanel: () => <p>Run History stub</p> }), (m) => m.RunHistoryPanel),
    DeferredOnboardingOverlay: lazyWithPreload(
      flaky('tour', { OnboardingOverlay: () => <p>Tour stub</p> }), (m) => m.OnboardingOverlay),
    DeferredConnectionPopup: lazyWithPreload(
      flaky('popup', { ConnectionPopup: () => <p>Popup stub</p> }), (m) => m.ConnectionPopup),
    DeferredMaskPainterModal: lazyWithPreload(
      flaky('mask', { MaskPainterModal: ({ onClose }: { onClose: () => void }) => (
        <div role="dialog" aria-label="Real mask painter"><button type="button" onClick={onClose}>Cancel</button></div>
      ) }),
      (m) => m.MaskPainterModal),
    DeferredMeshPreview: lazyWithPreload(
      flaky('mesh', { MeshPreview: ({ src }: { src: string }) => <button type="button">Real mesh viewer {src}</button> }),
      (m) => m.MeshPreview),
    DeferredWorldPreview: lazyWithPreload(
      flaky('world', { WorldPreview: () => <button type="button">Real world viewer</button> }),
      (m) => m.WorldPreview),
    DeferredAgentLog: lazyWithPreload(
      flaky('agentlog', { AgentLog: () => <p>Agent log stub</p> }), (m) => m.AgentLog),
  };
});

const initialUI = useUIStore.getState();
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
const fire = (type: 'online' | 'focus') => act(() => { window.dispatchEvent(new Event(type)); });

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a deferred panel whose chunk failed once', () => {
  it('Run History opens on the next toggle', async () => {
    chunks.failures.set('history', 1);
    render(<RunHistoryPanel />);
    act(() => useUIStore.getState().togglePanel('history'));
    await flush();
    expect(screen.queryByText('Run History stub')).toBeNull();
    // The failed open does not leave the dock marked open with nothing in it.
    expect(useUIStore.getState().panels.history.visible).toBe(false);

    act(() => useUIStore.getState().togglePanel('history'));
    expect(await screen.findByText('Run History stub')).toBeInTheDocument();
    expect(useUIStore.getState().panels.history.visible).toBe(true);
    expect(chunks.loads.get('history')).toBe(2);
  });

  it('the tour opens on the next start', async () => {
    chunks.failures.set('tour', 1);
    render(<OnboardingOverlay />);
    act(() => useUIStore.getState().startOnboarding());
    await flush();
    expect(screen.queryByText('Tour stub')).toBeNull();
    expect(useUIStore.getState().onboardingActive).toBe(false);

    act(() => useUIStore.getState().startOnboarding());
    expect(await screen.findByText('Tour stub')).toBeInTheDocument();
    expect(chunks.loads.get('tour')).toBe(2);
  });

  it('the connection popup opens on the next wire drop', async () => {
    chunks.failures.set('popup', 1);
    const popup = { position: { x: 10, y: 10 }, nodeId: 'n1', handleId: 'image', handleType: 'source' as const };
    render(<ConnectionPopup />);
    act(() => useUIStore.getState().showConnectionPopup(popup));
    await flush();
    expect(screen.queryByText('Popup stub')).toBeNull();
    expect(useUIStore.getState().connectionPopup.visible).toBe(false);

    act(() => useUIStore.getState().showConnectionPopup(popup));
    expect(await screen.findByText('Popup stub')).toBeInTheDocument();
    expect(chunks.loads.get('popup')).toBe(2);
  });

  it('the mask painter loads on the next Paint Mask, and offers Try again next to Close', async () => {
    chunks.failures.set('mask', 2);
    const onClose = vi.fn();
    const props = { imageUrl: '/api/outputs/a.png', initialMask: null, onSave: () => {}, onClose };
    const first = render(<MaskPainterModal {...props} />);
    await flush();
    // Error copy round 3b (GM's WRAP rule): Try again sits beside it and
    // redoes the load, so the line drops its own "try again".
    expect(screen.getByRole('alert').textContent).toBe("Couldn't load the mask painter. Nebula's server isn't answering. Make sure it's running.");
    first.unmount();

    // Paint Mask again mounts it again, which fetches again (and fails, the second time).
    render(<MaskPainterModal {...props} />);
    await flush();
    expect(chunks.loads.get('mask')).toBe(2);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load the mask painter/i);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Real mask painter' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(chunks.loads.get('mask')).toBe(3);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('a deferred node viewer whose chunk failed once', () => {
  it('replaces the mesh placeholder with the real viewer when the window comes back online', async () => {
    chunks.failures.set('mesh', 1);
    const { container } = render(<MeshPreview src="/api/outputs/chair.glb" />);
    await flush();
    expect(container.querySelector('[data-deferred-fallback="mesh"]')).toHaveTextContent('GLB model');

    await fire('online');
    expect(await screen.findByRole('button', { name: /Real mesh viewer/ })).toBeInTheDocument();
    expect(container.querySelector('[data-deferred-fallback]')).toBeNull();
  });

  it('replaces the world placeholder with the real viewer when the window regains focus', async () => {
    chunks.failures.set('world', 1);
    const value = {
      schemaVersion: 1, provider: 'worldlabs', worldId: 'w-1', model: 'marble-1.1', displayName: 'Courtyard',
      promptType: 'text', caption: 'A courtyard', assets: { splats: { '100k': '/api/outputs/w-100k.spz' } },
    };
    const { container } = render(<WorldPreview value={value} />);
    await flush();
    expect(container.querySelector('[data-deferred-fallback="world"]')).not.toBeNull();

    await fire('focus');
    expect(await screen.findByRole('button', { name: 'Real world viewer' })).toBeInTheDocument();
    expect(container.querySelector('[data-deferred-fallback]')).toBeNull();
  });
});

describe('the Agent log, which has no open to retry on', () => {
  it('appears when the window comes back online after its chunk failed', async () => {
    chunks.failures.set('agentlog', 1);
    render(<AgentLog />);
    await flush();
    expect(screen.queryByText('Agent log stub')).toBeNull();

    await fire('online');
    expect(await screen.findByText('Agent log stub')).toBeInTheDocument();
    expect(chunks.loads.get('agentlog')).toBe(2);
  });
});
