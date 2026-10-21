import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import type { Moodboard, MoodboardImage } from '../../types';

// Q98 (Justin, 2026-10-21: "a) Yes: the same check, and the same placeholder
// for old boards"). A board saved before board images were checked can hold
// an image link to another site. It stays on the board, but the app never
// loads it: every place a board image is drawn shows #133's placeholder and
// "Image link from outside Nebula" instead (lib/storedImage.ts), so no
// request goes to that host.

const api = vi.hoisted(() => ({
  analyzeMoodboard: vi.fn(), createMoodboard: vi.fn(), editMoodboard: vi.fn(), fetchMoodboard: vi.fn(),
  fetchMoodboards: vi.fn(), keepMoodboardBriefOverride: vi.fn(), lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(), updateMoodboard: vi.fn(),
}));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/backend', async (importOriginal) => ({
  ...(await importOriginal<object>()), apiFetch: vi.fn(), backendAssetUrlSync: (url: string) => url,
}));
vi.mock('../../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));
vi.mock('../WorkspaceHeader', () => ({
  WorkspaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../asset-trash/AssetTrash', () => ({ RecentlyDeletedAssets: () => null, UndoDeleteToast: () => null }));
vi.mock('../../hooks/useAssetDelete', () => ({
  useAssetDelete: () => ({ lastDeleted: null, busy: false, error: null, refreshKey: 0, remove: vi.fn(),
    undo: vi.fn(), dismiss: vi.fn(), refresh: vi.fn() }),
}));

import { MoodboardStudioView } from './MoodboardStudioView';
import { MoodboardListView } from './MoodboardListView';
import { BoardSidePanel } from './BoardSidePanel';
import { BoardCardNode, type BoardCardData } from './BoardCardNode';
import { BoardWideContext, wideFrom, type BoardCardNodeType } from './boardNodes';
import { MoodboardNode } from '../nodes/MoodboardNode';
import { MoodboardBundlePreview } from '../nodes/MoodboardBundlePreview';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import { useStoredAssetsStore } from '../../store/storedAssetsStore';

const OUTSIDE = 'https://example.com/x.png';
const NOTE = 'Image link from outside Nebula';
const card = (id: string, x: number) => [{ id: `c-${id}`, frameId: null, x, y: 0, w: 400, h: 300, weight: 1 }];
const outside: MoodboardImage = { id: 'imgout', url: OUTSIDE, weight: 1, notes: '', privateNote: '', excluded: false,
  placements: card('imgout', 0) } as MoodboardImage;
const local: MoodboardImage = { id: 'imgloc', url: '/api/outputs/chat-uploads/mine.png', weight: 1, notes: '',
  privateNote: '', excluded: false, placements: card('imgloc', 420) } as MoodboardImage;
const oldBoard = (): Moodboard => ({
  id: 'old1', name: 'Old board', version: 3, notes: '', mode: 'look', strength: 0.7, images: [outside, local],
  analysis: null, direction: '', avoid: [], pinnedColors: { include: [], exclude: [] }, briefOverride: null,
  coverImageId: null, thumbnail: OUTSIDE, projectId: null, createdAt: '', updatedAt: '', outsideImages: ['imgout'],
} as unknown as Moodboard);

/** Nothing on the page points at the outside host. */
function loadsNothingOutside(container: ParentNode = document) {
  const sources = Array.from(container.querySelectorAll('img, source, video, audio'))
    .map((el) => el.getAttribute('src') ?? el.getAttribute('srcset') ?? '');
  expect(sources.filter((src) => src.includes('example.com'))).toEqual([]);
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.fetchMoodboard.mockImplementation(async (id: string) => (id === 'old1' ? oldBoard() : null));
  api.fetchMoodboards.mockImplementation(async (scope: string) => (scope === 'global' ? [oldBoard()] : []));
  api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: oldBoard() });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  useStoredAssetsStore.setState({ entries: {} });
  useBoardCanvasStore.setState({ view: 'list', selection: {}, viewports: {} });
  setOpenProject(['p1', 'Project']);
});
afterEach(() => cleanup());

describe('an old board in Moodboard Studio', () => {
  it('List view: the cover, the rail and the tile show the placeholder; the upload still draws', async () => {
    act(() => { useUIStore.getState().enterMoodboardEditor('old1', 'global'); });
    render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
    await screen.findByDisplayValue('Old board');

    const cover = document.querySelector('.moodboard-def__cover')!;
    expect(cover.querySelector('img')).toBeNull();
    expect(within(cover as HTMLElement).getByText(NOTE)).toBeTruthy();
    const rail = document.querySelector('.moodboard-rail__item .moodboard-rail__thumb')!;
    expect(rail.querySelector('img')).toBeNull();
    const tiles = Array.from(document.querySelectorAll<HTMLElement>('.moodboard-tile__image'));
    expect(tiles[0].querySelector('img')).toBeNull();
    expect(within(tiles[0]).getByText(NOTE)).toBeTruthy();
    expect(tiles[1].querySelector('img')?.getAttribute('src')).toBe(local.url);
    loadsNothingOutside();
  });
});

describe('the List view and the Board view', () => {
  it('a tile for an outside image shows the placeholder', () => {
    const { container } = render(
      <MoodboardListView images={[outside, local]} analysis={null} cover={null} uploading={false}
        onFiles={vi.fn()} onDrop={vi.fn()} onRemove={vi.fn()} onUpdate={vi.fn()} onSetCover={vi.fn()}
        onTextDone={vi.fn()} />,
    );
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(container.querySelectorAll('.moodboard-tile__image img')).toHaveLength(1);
    loadsNothingOutside(container);
  });

  it('a card on the board shows the placeholder, wide or not', () => {
    for (const width of [300, 900]) {
      const props = {
        id: 'c1', data: { imageId: 'imgout', url: OUTSIDE, number: 1, setAside: false } as BoardCardData,
        width, height: 300, selected: false, dragging: false, type: 'card', zIndex: 0, isConnectable: false,
        positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: true, selectable: true, deletable: false,
      } as unknown as NodeProps<BoardCardNodeType>;
      const { container } = render(
        <BoardWideContext.Provider value={wideFrom([300, 900], 1)}><BoardCardNode {...props} /></BoardWideContext.Provider>,
      );
      expect(container.querySelector('img')).toBeNull();
      expect(screen.getByText(NOTE)).toBeTruthy();
      cleanup();
    }
  });

  it('the side panel of a selected outside image shows the placeholder', () => {
    const { container } = render(
      <BoardSidePanel images={[outside, local]} selected={['imgout']} analysis={null} onUpdate={vi.fn()}
        onRemove={vi.fn()} onTextDone={vi.fn()}>{null}</BoardSidePanel>,
    );
    expect(container.querySelector('.moodboard-board-panel__image img')).toBeNull();
    expect(screen.getByText(NOTE)).toBeTruthy();
    loadsNothingOutside(container);
  });
});

describe('an old board on the canvas', () => {
  it('the Moodboard node shows the placeholder for an outside cover', async () => {
    const props = { id: 'n1', data: { params: { moodboard: 'old1' } }, selected: false } as unknown as NodeProps;
    const { container } = render(<ReactFlowProvider><MoodboardNode {...props} /></ReactFlowProvider>);
    await screen.findByText('Old board');
    expect(container.querySelector('.moodboard-node__preview img')).toBeNull();
    expect(screen.getByText(NOTE)).toBeTruthy();
    loadsNothingOutside(container);
  });

  it('a saved bundle naming an outside image draws only Nebula\'s own', () => {
    const bundle = {
      kind: 'nebula_moodboard', moodboardId: 'old1', name: 'Old board', mode: 'look', strength: 0.7,
      images: [{ id: 'imgout', url: OUTSIDE, weight: 1, notes: '', excluded: false },
        { id: 'imgloc', url: local.url, weight: 1, notes: '', excluded: false }],
      representativeImages: [OUTSIDE, local.url], palette: [], accents: [], styleBrief: '', analysis: {},
    };
    const { container } = render(<MoodboardBundlePreview value={bundle} variant="full" />);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(local.url);
    loadsNothingOutside(container);
  });
});
