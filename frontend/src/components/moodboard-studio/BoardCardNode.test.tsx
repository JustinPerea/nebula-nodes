import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';

// A card draws the 512 px thumbnail the backend makes (`?thumb=1`) unless it
// is wider than about 480 css px on screen (plan PR5), so a 300-card board
// doesn't decode 300 full-size files.

// The canvas works out once per zoom which card widths are "wide" and hands
// the cards that line (BoardWideContext), so a drag or a pan doesn't run a
// zoom check in each of 300 cards.
const view = { zoom: 1 };
vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url }));

import { BoardCardNode, type BoardCardData } from './BoardCardNode';
import { BoardFillContext, BoardWideContext, wideFrom, type BoardCardNodeType } from './boardNodes';

afterEach(() => { cleanup(); view.zoom = 1; });

function mount(data: Partial<BoardCardData> = {}, width = 480) {
  const props = {
    id: 'c1', data: { imageId: 'i1', url: '/api/outputs/ref.png', number: 3, setAside: false, ...data },
    width, height: 270, selected: false, dragging: false, type: 'card', zIndex: 0, isConnectable: false,
    positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: true, selectable: true, deletable: false,
  } as unknown as NodeProps<BoardCardNodeType>;
  return render(
    <BoardWideContext.Provider value={wideFrom([270, 480, 600], view.zoom)}>
      <BoardCardNode {...props} />
    </BoardWideContext.Provider>,
  );
}
const src = (container: HTMLElement) => container.querySelector('img')!.getAttribute('src');

describe('a card on the board', () => {
  it('shows the thumbnail while it is no wider than 480 px on screen', () => {
    expect(src(mount().container)).toBe('/api/outputs/ref.png?thumb=1');
    cleanup();
    view.zoom = 0.4;
    expect(src(mount().container)).toBe('/api/outputs/ref.png?thumb=1');
  });

  it('shows the file itself once it is wider', () => {
    view.zoom = 1.25;
    expect(src(mount().container)).toBe('/api/outputs/ref.png');
  });

  it('falls back to the file when there is no thumbnail', () => {
    const { container } = mount();
    fireEvent.error(container.querySelector('img')!);
    expect(src(container)).toBe('/api/outputs/ref.png');
  });

  it('the line moves only when a zoom crosses a card width', () => {
    expect(wideFrom([270, 480, 600], 1)).toBe(600);
    expect(wideFrom([270, 480, 600], 1.01)).toBe(480);
    expect(wideFrom([270, 480, 600], 0.5)).toBe(Infinity);
    expect(wideFrom([270, 480, 600], 2)).toBe(270);
  });

  it('a link to another site is never loaded: the placeholder says why (Q98)', () => {
    const { container } = mount({ url: 'https://example.com/a.jpg' });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Image link from outside Nebula');
  });
});

describe('a card taking a placeholder\'s spot (GM r5)', () => {
  const url = '/api/outputs/chat-uploads/new.png';
  const propsFor = (filling: boolean) => ({
    id: 'c1', data: { imageId: 'i1', url, number: 1, setAside: false, filling },
    width: 480, height: 270, selected: false, dragging: false, type: 'card', zIndex: 0, isConnectable: false,
    positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: true, selectable: true, deletable: false,
  } as unknown as NodeProps<BoardCardNodeType>);
  // Progress is read by image id (review 4, MEDIUM-1): only i1's counts.
  const fillOf = (progress = 0) => ({ progress: (imageId: string) => (imageId === 'i1' ? progress : 0) });
  const tree = (filling: boolean, progress = 0) => (
    <BoardFillContext.Provider value={fillOf(progress)}>
      <BoardWideContext.Provider value={wideFrom([480], 1)}><BoardCardNode {...propsFor(filling)} /></BoardWideContext.Provider>
    </BoardFillContext.Provider>
  );
  const draw = (filling: boolean, progress = 0) => render(tree(filling, progress));

  it('is marked with its image id while its placeholder fills, so the board\'s spring can bring it in', () => {
    const card = draw(true).container.querySelector('.moodboard-card') as HTMLElement;
    expect(card.dataset.fillId).toBe('i1');
    expect(card.hasAttribute('data-fill-url')).toBe(false);
  });

  it('carries no mark otherwise, whatever file it shows (an older tile of the same file is never hidden)', () => {
    const card = draw(false, 0.4).container.querySelector('.moodboard-card') as HTMLElement;
    expect(card.hasAttribute('data-fill-id')).toBe(false);
    expect(card.style.opacity).toBe('');
  });

  it('drawn afresh mid-fade (React Flow remounts it), it starts where the spring is, not at 0 (live, r4)', () => {
    const card = draw(true, 0.8).container.querySelector('.moodboard-card') as HTMLElement;
    expect(card.style.opacity).toBe('0.8');
  });

  it('once the fill is over the stylesheet\'s opacity is back, even if the spring stopped short (a hidden tab)', () => {
    const view = draw(true, 0.3);
    const card = view.container.querySelector('.moodboard-card') as HTMLElement;
    expect(card.style.opacity).toBe('0.3');
    view.rerender(tree(false));
    expect(card.style.opacity).toBe('');
    expect(card.hasAttribute('data-fill-id')).toBe(false);
  });
});
