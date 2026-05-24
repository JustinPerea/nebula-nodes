import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { PlayerOverlay } from '../../src/components/video-editor/PlayerOverlay';
import { useUIStore } from '../../src/store/uiStore';

const INITIAL_UI_STATE = { ...useUIStore.getState() };

function makePlayerFrameRef(): { current: HTMLElement } {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720, x: 0, y: 0, toJSON: () => ({}),
  });
  return { current: el };
}

function renderOverlay() {
  return render(<PlayerOverlay remotionNodeId="r1" playerFrameRef={makePlayerFrameRef()} />);
}

describe('PlayerOverlay', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    document.querySelectorAll('[data-track-item-id], [data-track-item-content-id]').forEach((el) => el.remove());
  });

  it('renders a transparent overlay div', () => {
    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay');
    expect(overlay).not.toBeNull();
  });

  it('pointerdown on overlay with a hit dispatches setSelectedTrackItem(id)', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    document.body.appendChild(layerEl);

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

  it('prefers content wrapper hits over full-frame layer roots', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    const contentEl = document.createElement('div');
    contentEl.setAttribute('data-track-item-content-id', 'track-xyz');
    layerEl.appendChild(contentEl);
    document.body.appendChild(layerEl);

    const elementsFromPointSpy = vi
      .spyOn(document, 'elementsFromPoint')
      .mockReturnValue([contentEl, layerEl] as unknown as Element[]);

    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay') as HTMLElement;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });

    expect(useUIStore.getState().selectedTrackItemId).toBe('track-xyz');

    elementsFromPointSpy.mockRestore();
    document.body.removeChild(layerEl);
  });

  it('does not select a full-frame root when its content wrapper was missed', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    const contentEl = document.createElement('div');
    contentEl.setAttribute('data-track-item-content-id', 'track-xyz');
    layerEl.appendChild(contentEl);
    document.body.appendChild(layerEl);

    const elementsFromPointSpy = vi
      .spyOn(document, 'elementsFromPoint')
      .mockReturnValue([layerEl] as unknown as Element[]);

    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay') as HTMLElement;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });

    expect(useUIStore.getState().selectedTrackItemId).toBeNull();

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
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    document.body.appendChild(layerEl);
    useUIStore.setState({ selectedTrackItemId: 'track-xyz' });
    const { container } = renderOverlay();
    expect(container.querySelector('.remotion-selection-box')).not.toBeNull();
    document.body.removeChild(layerEl);
  });
});
