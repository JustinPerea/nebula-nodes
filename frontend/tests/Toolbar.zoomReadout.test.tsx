/**
 * The zoom readout while a whole graph is held (components/Canvas.tsx,
 * store/canvasRevealStore.ts): it shows no number until the graph's fit has
 * run, so it never reads 100% for a graph about to be fitted to another
 * value, and its box does not change size when the number arrives.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(), getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 0.95 })) }),
    useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
      selector({ transform: [0, 0, 0.95], minZoom: 0.1, maxZoom: 4 }),
    useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
  };
});

import { Toolbar } from '../src/components/panels/Toolbar';
import { useCanvasRevealStore } from '../src/store/canvasRevealStore';

afterEach(() => { cleanup(); useCanvasRevealStore.setState({ covered: false }); });

const readout = () => document.querySelector('.toolbar__zoom-level') as HTMLElement;

describe('the zoom readout', () => {
  it('shows the zoom normally', () => {
    render(<Toolbar />);
    expect(readout().textContent).toBe('95%');
    expect(readout().getAttribute('aria-label')).toBe('Zoom 95%, reset to 100%');
  });

  it('shows no number while a whole graph is held, and the fitted number after', () => {
    useCanvasRevealStore.setState({ covered: true });
    render(<Toolbar />);
    expect(readout().textContent).not.toMatch(/\d/);
    expect(readout().textContent).not.toContain('%');
    expect(readout().getAttribute('aria-label')).not.toMatch(/\d+%\b.*reset/);
    expect(screen.getByRole('button', { name: 'Zoom, reset to 100%' })).toBe(readout());
    // The box keeps its size: the same element, the same width rule, blank figure-width space where the number goes.
    expect(readout().querySelector('.toolbar__zoom-value')?.textContent).toMatch(/^\u2007+$/);
    act(() => useCanvasRevealStore.setState({ covered: false }));
    expect(readout().textContent).toBe('95%');
  });
});
