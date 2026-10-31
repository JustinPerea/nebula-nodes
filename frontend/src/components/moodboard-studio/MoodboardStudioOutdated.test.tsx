import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Moodboard } from '../../types';

// #208 (review 1, GM r1 and r2): a board analyzed before alpha counted, with
// a transparent image, says so in Studio twice, verbatim as the backend sends
// it: under its colours, and by "Brief sent to generators", since that brief
// is built from those colours while a run analyzes again and sends a new one.

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
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import { useStoredAssetsStore } from '../../store/storedAssetsStore';

const COLORS_LINE = 'These colors counted transparent areas as dark. Analyze again to update them.';
const BRIEF_LINE = 'This brief uses the old colors. The next run analyzes the board again and sends an updated one.';

function board(outdated: boolean): Moodboard {
  const image = { id: 'img1', url: '/api/outputs/chat-uploads/mark.png', weight: 1, notes: '', privateNote: '',
    excluded: false, placements: [{ id: 'c1', frameId: null, x: 0, y: 0, w: 400, h: 300, weight: 1 }] };
  return {
    id: 'mb1', name: 'Mark', version: 3, notes: '', mode: 'look', strength: 0.7, images: [image],
    analysis: {
      version: 5, summary: '1 reference image analyzed as look. Palette: #040605.', palette: ['#040605'],
      accents: [], colors: [], keywords: [], images: [], warnings: [], styleBrief: 'Color palette: #040605.',
      ...(outdated ? { outdated: COLORS_LINE } : {}),
    },
    brief: {
      styleBrief: 'Color palette: #040605.', generatedStyleBrief: 'Color palette: #040605.', negativePrompt: '',
      avoid: [], avoidPrompt: '', direction: '', pinnedColors: { include: [], exclude: [] }, palette: ['#040605'],
      accents: [], override: { active: false, stale: false }, needsAnalysis: false,
      ...(outdated ? { outdated: BRIEF_LINE } : {}),
    },
    direction: '', avoid: [], pinnedColors: { include: [], exclude: [] }, briefOverride: null, coverImageId: null,
    thumbnail: image.url, projectId: null, createdAt: '', updatedAt: '',
  } as unknown as Moodboard;
}

let current = board(true);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.fetchMoodboard.mockImplementation(async (id: string) => (id === 'mb1' ? current : null));
  api.fetchMoodboards.mockImplementation(async (scope: string) => (scope === 'global' ? [current] : []));
  api.lookupStoredAsset.mockImplementation(async () => ({ status: 'ready', asset: current }));
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  useStoredAssetsStore.setState({ entries: {} });
  useBoardCanvasStore.setState({ view: 'list', selection: {}, viewports: {} });
  setOpenProject(['p1', 'Project']);
});
afterEach(() => cleanup());

async function open() {
  act(() => { useUIStore.getState().enterMoodboardEditor('mb1', 'global'); });
  render(<ReactFlowProvider><MoodboardStudioView /></ReactFlowProvider>);
  await screen.findByDisplayValue('Mark');
}

describe('a board whose saved colors are out of date', () => {
  it('says so under the colors and by the brief, in GM’s words', async () => {
    current = board(true);
    await open();
    expect((await screen.findByText(COLORS_LINE)).className).toBe('moodboard-analysis__outdated');
    const line = await screen.findByText(BRIEF_LINE);
    expect(line.className).toBe('moodboard-analysis__outdated');
    expect(line.closest('.moodboard-brief')).not.toBeNull();
  });

  it('says neither on a board whose colors are current', async () => {
    current = board(false);
    await open();
    expect(await screen.findByText('Color palette: #040605.')).toBeTruthy();
    expect(screen.queryByText(COLORS_LINE)).toBeNull();
    expect(screen.queryByText(BRIEF_LINE)).toBeNull();
  });
});
