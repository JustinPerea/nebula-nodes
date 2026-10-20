import { Suspense, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OnboardingOverlay, RunHistoryPanel } from '../../src/components/DeferredPanels';
import { MeshPreview, WorldPreview } from '../../src/components/nodes/DeferredViewers';
import { DeferredRunHistoryPanel } from '../../src/lib/deferredChunks';
import { lazyWithPreload } from '../../src/lib/lazyWithPreload';
import { useUIStore } from '../../src/store/uiStore';

// Startup-entry split (lib/deferredChunks.ts): these pieces load on first use.
// The tests pin the user-visible contract: nothing is fetched or drawn while
// closed, the first open still opens, focus and Escape behave as before, and
// node viewers hold their box while their chunk is in flight.

const initialUI = useUIStore.getState();

beforeEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
});
afterEach(() => cleanup());

describe('lazyWithPreload', () => {
  it('renders synchronously, with no fallback, once preloaded', async () => {
    const load = vi.fn(async () => ({ Thing: () => <p>Loaded thing</p> }));
    const Thing = lazyWithPreload(load, (module) => module.Thing);
    await Thing.preload();
    await Thing.preload();
    expect(load).toHaveBeenCalledTimes(1);

    render(<Suspense fallback={<p>Fallback</p>}><Thing /></Suspense>);
    expect(screen.getByText('Loaded thing')).toBeInTheDocument();
    expect(screen.queryByText('Fallback')).toBeNull();
  });

  it('lets a later intent retry after a failed preload', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ Thing: () => <p>Loaded thing</p> });
    const Thing = lazyWithPreload(load, (module: { Thing: ComponentType }) => module.Thing);
    await expect(Thing.preload()).rejects.toThrow('offline');
    await expect(Thing.preload()).resolves.toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('deferred Run History', () => {
  it('stays unmounted while closed and opens on the first toggle', async () => {
    const preload = vi.spyOn(DeferredRunHistoryPanel, 'preload');
    render(<RunHistoryPanel />);
    expect(screen.queryByText('Run History')).toBeNull();
    expect(preload).not.toHaveBeenCalled();

    act(() => useUIStore.getState().togglePanel('history'));
    expect(await screen.findByText('Run History')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close run history panel' })).toBeInTheDocument();
    preload.mockRestore();
  });
});

describe('deferred onboarding', () => {
  it('opens on first start, takes focus, and Escape returns focus to the opener', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Help';
    document.body.appendChild(opener);
    opener.focus();

    render(<OnboardingOverlay />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useUIStore.getState().startOnboarding());

    const dialog = await screen.findByRole('dialog', { name: 'Welcome to Nebula Nodes' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take the tour' })).toHaveFocus());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useUIStore.getState().onboardingActive).toBe(false);
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe('deferred node viewers', () => {
  it('holds the mesh card box with the idle card while the viewer loads', async () => {
    const { container } = render(<MeshPreview src="/api/outputs/chair.glb" />);
    const fallback = container.querySelector('[data-deferred-fallback="mesh"]');
    expect(fallback).not.toBeNull();
    expect(fallback).toHaveClass('mesh-preview', 'mesh-preview--idle', 'nodrag', 'nowheel');
    expect(fallback).toHaveTextContent('GLB model');
    const fallbackFace = fallback!.innerHTML;
    const fallbackClass = fallback!.className;

    const viewer = await screen.findByRole('button', { name: 'Open GLB model preview' });
    expect(viewer).toHaveClass('mesh-preview', 'mesh-preview--idle');
    expect(container.querySelector('[data-deferred-fallback]')).toBeNull();
    // Same face, so nothing pops in or shifts when the chunk lands.
    expect(viewer.className).toBe(fallbackClass);
    expect(viewer.innerHTML).toBe(fallbackFace);
  });

  it('holds the world card box (compact size) while the viewer loads', async () => {
    const value = {
      schemaVersion: 1, provider: 'worldlabs', worldId: 'w-1', model: 'marble-1.1', displayName: 'Courtyard',
      promptType: 'text', caption: 'A courtyard',
      assets: { splats: { '100k': '/api/outputs/w-100k.spz' }, thumbnail: '/api/outputs/w-thumb.webp' },
    };
    const { container } = render(<WorldPreview value={value} compact />);
    const fallback = container.querySelector('[data-deferred-fallback="world"]');
    expect(fallback).toHaveClass('world-preview', 'world-preview--compact');
    expect(fallback).toHaveTextContent('Courtyard');
    const fallbackFace = fallback!.innerHTML;
    const fallbackClass = fallback!.className;

    const viewer = await screen.findByRole('button', { name: /Explore 3D world/ });
    expect(viewer).toHaveClass('world-preview', 'world-preview--compact');
    expect(container.querySelector('[data-deferred-fallback]')).toBeNull();
    // Same face (thumbnail, badge, caption, Explore), so nothing pops in when the chunk lands.
    expect(viewer.querySelector('img.world-preview__thumbnail')).not.toBeNull();
    expect(viewer.className).toBe(fallbackClass);
    expect(viewer.innerHTML).toBe(fallbackFace);
  });
});
