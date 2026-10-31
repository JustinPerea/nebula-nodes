import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { OutsideChip } from './OutsideChip';
import { nearestEdge, outsideChipText } from './outsideChipText';
import type { OutsideTiles } from './BoardCanvas';

// The reveal for tiles placed outside the view (GM - Design, #210 answer 1):
// an edge chip with an arrow, a thumbnail and GM's words; a button that brings
// the tiles into view; no timer; it goes when pressed, when the tiles come
// into view, on Esc, or at the next paste (the Studio replaces it).

vi.mock('../../lib/backend', () => ({ apiFetch: vi.fn(), backendAssetUrlSync: (url: string) => url }));

const camera: { set: (x: number, y: number, zoom: number) => void } = { set: () => {} };
const pan = (x: number, y: number, zoom: number) => camera.set(x, y, zoom);
function Pan() {
  const store = useStoreApi();
  useEffect(() => { camera.set = (x, y, zoom) => act(() => { store.setState({ transform: [x, y, zoom] }); }); }, [store]);
  return null;
}

const one: OutsideTiles = { id: 1, rects: [{ x: 1200, y: 300, width: 300, height: 200 }], thumb: '/api/outputs/a.png' };
const two: OutsideTiles = { id: 2, rects: [{ x: 300, y: 900, width: 300, height: 200 }, { x: 650, y: 900, width: 300, height: 200 }], thumb: null };

function mount(tiles: OutsideTiles) {
  const onShow = vi.fn();
  const onDone = vi.fn();
  const view = render(
    <ReactFlowProvider initialWidth={1000} initialHeight={700}>
      <Pan />
      <OutsideChip tiles={tiles} onShow={onShow} onDone={onDone} />
    </ReactFlowProvider>,
  );
  return { view, onShow, onDone };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the outside-the-view chip', () => {
  it('says GM\'s words for one tile, with the thumbnail, on the edge nearest it, arrow pointing at it', () => {
    const { view } = mount(one);
    const chip = screen.getByRole('button', { name: 'Added outside the view, show it' });
    expect(chip.textContent).toContain('Added outside the view');
    expect(chip.className).toContain('moodboard-board__outside-chip--right');
    expect(chip.textContent).toContain('→');
    expect(view.container.querySelector('.moodboard-board__outside-thumb')?.getAttribute('src')).toBe('/api/outputs/a.png');
  });

  it('several: "N images added outside the view", at the edge nearest the first', () => {
    mount(two);
    const chip = screen.getByRole('button', { name: '2 images added outside the view, show them' });
    expect(chip.className).toContain('moodboard-board__outside-chip--bottom');
    expect(outsideChipText(2).text).toBe('2 images added outside the view');
  });

  it('one polite announcement with the same words and a full stop', () => {
    mount(one);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Added outside the view.');
  });

  it('pressing it brings the tiles into view (the board\'s fit spring) and it goes', () => {
    const { onShow, onDone } = mount(two);
    fireEvent.click(screen.getByRole('button'));
    expect(onShow).toHaveBeenCalledWith(two.rects);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('goes when the person pans or zooms the tiles into view, not before', () => {
    const { onDone } = mount(one);
    pan(-100, 0, 1);
    expect(onDone).not.toHaveBeenCalled();
    pan(-700, -100, 1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('goes on Esc, but not on Esc typed in a text field', () => {
    const { onDone } = mount(one);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onDone).not.toHaveBeenCalled();
    field.remove();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('has no timer: it is still there a minute later', () => {
    vi.useFakeTimers();
    const { onDone } = mount(one);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('the nearest edge follows where the tile is', () => {
    expect(nearestEdge({ x: -50, y: 350 }, 1000, 700)).toBe('left');
    expect(nearestEdge({ x: 1100, y: 350 }, 1000, 700)).toBe('right');
    expect(nearestEdge({ x: 500, y: -40 }, 1000, 700)).toBe('top');
    expect(nearestEdge({ x: 500, y: 800 }, 1000, 700)).toBe('bottom');
  });
});
