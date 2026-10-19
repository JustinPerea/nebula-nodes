import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { OverviewImage, OverviewVideoStill } from './OverviewImage';
import { useUIStore } from '../../store/uiStore';

const HERO = '/api/outputs/run-1/hero.png';

afterEach(() => {
  useUIStore.setState({ canvasZoomedOut: false });
});

describe('OverviewImage (design-canvas gap 19)', () => {
  it('shows the file itself at normal zoom and its thumbnail when zoomed out', () => {
    render(<OverviewImage src={HERO} alt="Generated output" />);
    const image = screen.getByAltText('Generated output');
    expect(image.getAttribute('src')).toBe(HERO);

    act(() => useUIStore.getState().setCanvasZoomedOut(true));
    expect(image.getAttribute('src')).toBe(`${HERO}?thumb=1`);

    act(() => useUIStore.getState().setCanvasZoomedOut(false));
    expect(image.getAttribute('src')).toBe(HERO);
  });

  it('falls back to the file when the thumbnail fails, and stays there', () => {
    useUIStore.setState({ canvasZoomedOut: true });
    render(<OverviewImage src={HERO} alt="Generated output" />);
    const image = screen.getByAltText('Generated output');
    fireEvent.error(image);
    expect(image.getAttribute('src')).toBe(HERO);
    fireEvent.error(image);
    expect(image.getAttribute('src')).toBe(HERO);
  });

  it('keeps images it has no thumbnail for', () => {
    useUIStore.setState({ canvasZoomedOut: true });
    render(<OverviewImage src="https://cdn.example.com/a.png" alt="Remote" />);
    expect(screen.getByAltText('Remote').getAttribute('src')).toBe('https://cdn.example.com/a.png');
  });
});

describe('OverviewVideoStill', () => {
  it('puts a still over the video only while zoomed out', () => {
    const { container } = render(<OverviewVideoStill src="/api/outputs/run-2/clip.mp4" />);
    expect(container.querySelector('img')).toBeNull();
    act(() => useUIStore.getState().setCanvasZoomedOut(true));
    const still = container.querySelector('img');
    expect(still?.getAttribute('src')).toBe('/api/outputs/run-2/clip.mp4?thumb=1');
    expect(still?.className).toBe('model-node__preview-still');
    fireEvent.error(still!);
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows nothing for a video that has no thumbnail', () => {
    useUIStore.setState({ canvasZoomedOut: true });
    const { container } = render(<OverviewVideoStill src="https://cdn.example.com/clip.mp4" />);
    expect(container.querySelector('img')).toBeNull();
  });
});
