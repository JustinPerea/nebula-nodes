import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';

import { useOpenOnDoubleClick } from './useOpenOnDoubleClick';

/** A stand-in for React Flow's pane, which zooms on a native dblclick. */
function Pane({ onPaneDoubleClick, open }: { onPaneDoubleClick: () => void; open: (() => void) | null }) {
  const pane = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = pane.current!;
    element.addEventListener('dblclick', onPaneDoubleClick);
    return () => element.removeEventListener('dblclick', onPaneDoubleClick);
  }, [onPaneDoubleClick]);
  return <div ref={pane}><Card open={open} /></div>;
}

function Card({ open }: { open: (() => void) | null }) {
  const ref = useOpenOnDoubleClick<HTMLDivElement>(open);
  return (
    <div ref={ref} data-testid="card">
      <span>Warm editorial</span>
      <div className="react-flow__handle" data-testid="handle" />
      <button type="button">Settings</button>
    </div>
  );
}

describe('useOpenOnDoubleClick', () => {
  it('opens the asset and keeps the double-click from zooming the canvas', () => {
    const open = vi.fn();
    const zoom = vi.fn();
    render(<Pane open={open} onPaneDoubleClick={zoom} />);
    fireEvent.doubleClick(screen.getByText('Warm editorial'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(zoom).not.toHaveBeenCalled();
  });

  it('leaves ports and buttons their own double-click', () => {
    const open = vi.fn();
    render(<Pane open={open} onPaneDoubleClick={() => {}} />);
    fireEvent.doubleClick(screen.getByTestId('handle'));
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Settings' }));
    expect(open).not.toHaveBeenCalled();
  });

  it('with nothing to open, the double-click does what it does anywhere on the canvas', () => {
    const zoom = vi.fn();
    render(<Pane open={null} onPaneDoubleClick={zoom} />);
    fireEvent.doubleClick(screen.getByText('Warm editorial'));
    expect(zoom).toHaveBeenCalledTimes(1);
  });
});
