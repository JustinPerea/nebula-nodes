import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { CanvasNavigation } from '../../src/components/CanvasNavigation';
import { useUIStore } from '../../src/store/uiStore';

const INITIAL_UI = { ...useUIStore.getState() };

describe('Canvas navigation', () => {
  beforeEach(() => useUIStore.setState(INITIAL_UI, true));

  it('keeps zoom, fit and the count available with performance mode disabled', () => {
    useUIStore.setState({ canvasPerfMode: false });
    render(<ReactFlowProvider><CanvasNavigation nodeCount={3} /></ReactFlowProvider>);
    expect(screen.getByText('3 nodes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fit view/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /canvas minimap/i })).not.toBeInTheDocument();
  });

  it('collapses and restores the map without removing viewport controls or count', () => {
    useUIStore.setState({ canvasPerfMode: true, minimapCollapsed: false });
    render(<ReactFlowProvider><CanvasNavigation nodeCount={1} /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize canvas minimap' }));
    expect(useUIStore.getState().minimapCollapsed).toBe(true);
    expect(screen.getByText('1 node')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas minimap' }));
    expect(useUIStore.getState().minimapCollapsed).toBe(false);
    expect(screen.getByRole('button', { name: 'Minimize canvas minimap' })).toBeInTheDocument();
  });
});
