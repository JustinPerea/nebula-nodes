import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider, useStore } from '@xyflow/react';
import type { MoodboardImage } from '../../types';

// Plan C1: the board is a second React Flow canvas with its own provider.
// App wraps every view in one ReactFlowProvider (App.tsx); without its own,
// the board's cards would land in the main canvas's store.

beforeAll(() => {
  // React Flow measures its pane; give jsdom a size so it draws the cards in view.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 1200; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 800; } });
});
afterEach(() => cleanup());

import { BoardCanvas } from './BoardCanvas';

const images: MoodboardImage[] = ['i1', 'i2'].map((id, index) => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false,
  placements: [{ id: `c-${id}`, frameId: null, x: index * 520, y: 0, w: 480, h: 270, weight: 1, placedBy: 'person', placedAt: '' }],
}));

function OuterProbe() {
  const count = useStore((state) => state.nodeLookup.size);
  return <output aria-label="main canvas nodes">{count}</output>;
}

describe('the Board view has its own React Flow store', () => {
  it("draws its cards without putting them in the app's canvas store", async () => {
    render(
      <ReactFlowProvider>
        <OuterProbe />
        <BoardCanvas boardKey="k" images={images} onMove={() => {}} onDropFiles={() => {}} />
      </ReactFlowProvider>,
    );
    const cards = await screen.findAllByLabelText(/^Reference #\d/);
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(['Reference #1', 'Reference #2']);
    expect(screen.getByLabelText('main canvas nodes').textContent).toBe('0');
  });
});
