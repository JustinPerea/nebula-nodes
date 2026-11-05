import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';

// The DOM sites an agent cursor on a moodboard finds (lib/agentAnchors): the
// Studio's card carries its image's anchor once the Studio has published
// which saved board it has open.
vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url }));

import { BoardCardNode, type BoardCardData } from './BoardCardNode';
import { BoardWideContext, wideFrom, type BoardCardNodeType } from './boardNodes';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';

afterEach(() => { cleanup(); useBoardCanvasStore.getState().setStudioBoard(null); });

function mount(data: Partial<BoardCardData> = {}) {
  const props = {
    id: 'c1', data: { imageId: 'i1', url: '/api/outputs/ref.png', number: 3, setAside: false, ...data },
    width: 480, height: 270, selected: false, dragging: false, type: 'card', zIndex: 0, isConnectable: false,
    positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: true, selectable: true, deletable: false,
  } as unknown as NodeProps<BoardCardNodeType>;
  return render(<BoardWideContext.Provider value={wideFrom([270, 480, 600], 1)}><BoardCardNode {...props} /></BoardWideContext.Provider>);
}

describe('the Studio card is an anchor', () => {
  it('carries moodboard:<board>/<image> for the open saved board', () => {
    act(() => useBoardCanvasStore.getState().setStudioBoard({ boardId: 'b1', boardKey: 'b1', imageIds: ['i1'] }));
    expect(mount().container.querySelector('.moodboard-card')!.getAttribute('data-agent-anchor')).toBe('moodboard:b1/i1');
  });

  it('carries none for a draft, so no selector is ever built from nothing', () => {
    expect(mount().container.querySelector('.moodboard-card')!.hasAttribute('data-agent-anchor')).toBe(false);
  });
});
