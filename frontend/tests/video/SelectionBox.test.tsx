import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SelectionBox } from '../../src/components/video-editor/SelectionBox';
import { useUIStore } from '../../src/store/uiStore';

const INITIAL_UI_STATE = { ...useUIStore.getState() };

describe('SelectionBox — scaffolding', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    // Clean up any leftover layer elements between tests
    document.querySelectorAll('[data-track-item-id]').forEach((el) => el.remove());
  });

  it('renders nothing when target element does not exist in DOM', () => {
    const { container } = render(<SelectionBox remotionNodeId="r1" trackItemId="missing" />);
    expect(container.querySelector('.remotion-selection-box')).toBeNull();
  });

  it('renders an outline div positioned via getBoundingClientRect', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    // Mock getBoundingClientRect to return a known rect
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 200, width: 300, height: 150, right: 400, bottom: 350, x: 100, y: 200, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);

    const { container } = render(<SelectionBox remotionNodeId="r1" trackItemId="track-xyz" />);
    const box = container.querySelector('.remotion-selection-box') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.left).toBe('100px');
    expect(box.style.top).toBe('200px');
    expect(box.style.width).toBe('300px');
    expect(box.style.height).toBe('150px');

    document.body.removeChild(layerEl);
  });
});
