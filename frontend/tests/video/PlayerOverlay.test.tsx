import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { PlayerOverlay } from '../../src/components/video-editor/PlayerOverlay';
import { useUIStore } from '../../src/store/uiStore';

const INITIAL_UI_STATE = { ...useUIStore.getState() };

function renderOverlay() {
  return render(<PlayerOverlay remotionNodeId="r1" />);
}

describe('PlayerOverlay', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
  });

  it('renders a transparent overlay div', () => {
    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay');
    expect(overlay).not.toBeNull();
  });

  it('pointerdown on overlay with a hit dispatches setSelectedTrackItem(id)', () => {
    // Seed a layer DOM element with data-track-item-id below the overlay's z-stack
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    document.body.appendChild(layerEl);

    // Mock elementsFromPoint to return our seeded element
    const elementsFromPointSpy = vi
      .spyOn(document, 'elementsFromPoint')
      .mockReturnValue([layerEl] as unknown as Element[]);

    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay') as HTMLElement;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });

    expect(useUIStore.getState().selectedTrackItemId).toBe('track-xyz');

    elementsFromPointSpy.mockRestore();
    document.body.removeChild(layerEl);
  });

  it('pointerdown on overlay with no hit dispatches setSelectedTrackItem(null)', () => {
    useUIStore.setState({ selectedTrackItemId: 'previously-selected' });

    const elementsFromPointSpy = vi
      .spyOn(document, 'elementsFromPoint')
      .mockReturnValue([] as unknown as Element[]);

    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay') as HTMLElement;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });

    expect(useUIStore.getState().selectedTrackItemId).toBeNull();

    elementsFromPointSpy.mockRestore();
  });

  it('renders SelectionBox when selectedTrackItemId is non-null and target element is in DOM', () => {
    // Set up the layer DOM BEFORE rendering so SelectionBox's first effect
    // finds it and computes a rect (otherwise the first render returns null
    // and there's no trigger to re-query after appendChild).
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    document.body.appendChild(layerEl);
    useUIStore.setState({ selectedTrackItemId: 'track-xyz' });
    const { container } = renderOverlay();
    expect(container.querySelector('.remotion-selection-box')).not.toBeNull();
    document.body.removeChild(layerEl);
  });
});
