import { beforeEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { CanvasNavigation } from '../../src/components/CanvasNavigation';
import { useUIStore } from '../../src/store/uiStore';

const INITIAL_UI = { ...useUIStore.getState() };

describe('Canvas navigation', () => {
  beforeEach(() => useUIStore.setState(INITIAL_UI, true));

  it('renders only the minimap, and only while its preference is on', () => {
    useUIStore.setState({ canvasPerfMode: false });
    const { container } = render(<ReactFlowProvider><CanvasNavigation /></ReactFlowProvider>);
    expect(container.querySelector('.react-flow__minimap')).toBeNull();
    expect(container.querySelector('.react-flow__controls')).toBeNull();
    act(() => useUIStore.getState().setCanvasMinimapEnabled(true));
    expect(container.querySelector('.react-flow__minimap')).toBeInTheDocument();
    expect(useUIStore.getState().canvasPerfMode).toBe(false);
    act(() => useUIStore.getState().setCanvasMinimapEnabled(false));
    expect(container.querySelector('.react-flow__minimap')).toBeNull();
  });
});
