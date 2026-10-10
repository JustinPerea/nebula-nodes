import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { CanvasNavigation } from '../../src/components/CanvasNavigation';
import { useUIStore } from '../../src/store/uiStore';

const INITIAL_UI = { ...useUIStore.getState() };
const viewportMocks = vi.hoisted(() => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn() }));

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => viewportMocks,
}));

describe('Canvas navigation', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI, true);
    vi.clearAllMocks();
  });
  afterEach(() => document.querySelectorAll('.workspace-dock-panel').forEach((node) => node.remove()));

  it('hides the map by default while retaining zoom, fit and the count', () => {
    useUIStore.setState({ canvasPerfMode: true });
    const { container } = render(<ReactFlowProvider><CanvasNavigation nodeCount={3} /></ReactFlowProvider>);
    expect(screen.getByText('3 nodes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fit view/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /canvas minimap/i })).not.toBeInTheDocument();
    expect(container.querySelector('.react-flow__minimap')).toBeNull();
  });

  it('shows and hides the map from its preference independently of performance mode', () => {
    useUIStore.setState({ canvasPerfMode: false });
    const { container } = render(<ReactFlowProvider><CanvasNavigation nodeCount={1} /></ReactFlowProvider>);
    act(() => useUIStore.getState().setCanvasMinimapEnabled(true));
    expect(container.querySelector('.react-flow__minimap')).toBeInTheDocument();
    expect(useUIStore.getState().canvasPerfMode).toBe(false);
    act(() => useUIStore.getState().setCanvasMinimapEnabled(false));
    expect(container.querySelector('.react-flow__minimap')).toBeNull();
    expect(screen.getByText('1 node')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fit view/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /canvas minimap/i })).not.toBeInTheDocument();
  });

  it('measures the drawer at each Fit click without capturing earlier geometry', () => {
    const drawer = document.createElement('div');
    drawer.className = 'workspace-dock-panel';
    let drawerRight = 404;
    drawer.getBoundingClientRect = () => ({
      x: 84, y: 16, left: 84, right: drawerRight, top: 16, bottom: 704,
      width: drawerRight - 84, height: 688, toJSON: () => ({}),
    });
    document.body.appendChild(drawer);
    render(<ReactFlowProvider><CanvasNavigation nodeCount={3} /></ReactFlowProvider>);
    const fit = screen.getByRole('button', { name: 'Fit view' });
    expect(viewportMocks.fitView).not.toHaveBeenCalled();

    drawerRight = 304;
    fireEvent.click(fit);
    expect(viewportMocks.fitView).toHaveBeenCalledExactlyOnceWith({
      padding: { top: '40px', right: '40px', bottom: '40px', left: '328px' },
    });

    drawer.remove();
    fireEvent.click(fit);
    expect(viewportMocks.fitView).toHaveBeenCalledTimes(2);
    expect(viewportMocks.fitView).toHaveBeenLastCalledWith({
      padding: { top: '40px', right: '40px', bottom: '40px', left: '40px' },
    });
  });
});
