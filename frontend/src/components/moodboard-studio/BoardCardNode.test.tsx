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
  const props = {
    id: 'c1', data: { imageId: 'i1', url: '/api/outputs/chat-uploads/new.png', number: 1, setAside: false },
    width: 480, height: 270, selected: false, dragging: false, type: 'card', zIndex: 0, isConnectable: false,
    positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: true, selectable: true, deletable: false,
  } as unknown as NodeProps<BoardCardNodeType>;
  const fillOf = (filling: string[], progress = 0) => ({ has: (url: string) => filling.includes(url), progress: () => progress });
  const tree = (fill: ReturnType<typeof fillOf>) => (
    <BoardFillContext.Provider value={fill}>
      <BoardWideContext.Provider value={wideFrom([480], 1)}><BoardCardNode {...props} /></BoardWideContext.Provider>
    </BoardFillContext.Provider>
  );
  const draw = (filling: string[], progress = 0) => render(tree(fillOf(filling, progress)));

  it('is marked with its url while its placeholder fills, so the board\'s spring can bring it in', () => {
    const card = draw(['/api/outputs/chat-uploads/new.png']).container.querySelector('.moodboard-card') as HTMLElement;
    expect(card.dataset.fillUrl).toBe('/api/outputs/chat-uploads/new.png');
  });

  it('carries no mark otherwise', () => {
    expect(draw(['/api/outputs/other.png']).container.querySelector('.moodboard-card')!.hasAttribute('data-fill-url')).toBe(false);
  });

  it('drawn afresh mid-fade (React Flow remounts it), it starts where the spring is, not at 0 (live, r4)', () => {
    const card = draw(['/api/outputs/chat-uploads/new.png'], 0.8).container.querySelector('.moodboard-card') as HTMLElement;
    expect(card.style.opacity).toBe('0.8');
  });

  it('once the fill is over the stylesheet\'s opacity is back, even if the spring stopped short (a hidden tab)', () => {
    const view = draw(['/api/outputs/chat-uploads/new.png'], 0.3);
    const card = view.container.querySelector('.moodboard-card') as HTMLElement;
    expect(card.style.opacity).toBe('0.3');
    view.rerender(tree(fillOf([])));
    expect(card.style.opacity).toBe('');
    expect(card.hasAttribute('data-fill-url')).toBe(false);
  });
});
