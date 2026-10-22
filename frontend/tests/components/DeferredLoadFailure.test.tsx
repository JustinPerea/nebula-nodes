import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MeshPreview } from '../../src/components/nodes/DeferredViewers';
import { MaskPainterModal, RunHistoryPanel } from '../../src/components/DeferredPanels';
import { useUIStore } from '../../src/store/uiStore';

// A deferred chunk can fail to load (the web build was replaced while a tab
// was open, a flaky disk or network). Before the split these components were
// in the startup entry and could not fail this way, so a failed chunk must not
// take the canvas down with it: the piece shows its fallback (or a way out)
// and everything around it stays mounted.

vi.mock('../../src/components/nodes/MeshPreview', () => {
  throw new Error('chunk failed: MeshPreview');
});
vi.mock('../../src/components/panels/RunHistoryPanel', () => {
  throw new Error('chunk failed: RunHistoryPanel');
});
vi.mock('../../src/components/panels/MaskPainterModal', () => {
  throw new Error('chunk failed: MaskPainterModal');
});

const initialUI = useUIStore.getState();
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a deferred chunk that fails to load', () => {
  it('keeps the mesh card as its idle face and leaves the rest of the canvas mounted', async () => {
    render(<div><p>Neighbour node</p><MeshPreview src="/api/outputs/chair.glb" /></div>);
    await flush();
    expect(screen.getByText('Neighbour node')).toBeInTheDocument();
    expect(document.querySelector('[data-deferred-fallback="mesh"]')).toHaveTextContent('GLB model');
  });

  it('does not take the app down when Run History cannot load', async () => {
    render(<div><p>Canvas</p><RunHistoryPanel /></div>);
    act(() => useUIStore.getState().togglePanel('history'));
    await flush();
    expect(screen.getByText('Canvas')).toBeInTheDocument();
  });

  it('gives the mask painter a way out when it cannot load', async () => {
    const onClose = vi.fn();
    render(<div><p>Inspector</p><MaskPainterModal imageUrl="/api/outputs/a.png" initialMask={null} onSave={() => {}} onClose={onClose} /></div>);
    await flush();
    expect(screen.getByText('Inspector')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the mask painter. Check your connection."); // round 3b: Try again is beside it
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // The header's close and the footer's Close next to Try again both close it.
    const closes = screen.getAllByRole('button', { name: 'Close' });
    expect(closes).toHaveLength(2);
    for (const close of closes) fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
