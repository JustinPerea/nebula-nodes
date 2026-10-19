import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Moodboard, MoodboardAnalysis } from '../../src/types';

const api = vi.hoisted(() => ({ boards: vi.fn(), board: vi.fn() }));
vi.mock('../../src/lib/api', async (original) => ({ ...await original<typeof import('../../src/lib/api')>(),
  fetchMoodboards: api.boards, fetchMoodboard: api.board }));

import { MoodboardStudioView } from '../../src/components/moodboard-studio/MoodboardStudioView';
import { useUIStore } from '../../src/store/uiStore';
import { useAssetStudioDraftStore } from '../../src/store/assetStudioDraftStore';
import { setOpenProject } from '../../src/test/projectState';

const initialUI = useUIStore.getState();
const analysis = (fields: Partial<MoodboardAnalysis>): MoodboardAnalysis => ({
  version: 2, sourceHash: 'abc', mode: 'look', modeIntent: '', strength: 0.7, summary: 'Two images.',
  tasteProfile: '', styleBrief: 'Brief', negativePrompt: '', keywords: [], avoids: [], palette: ['#1e285a', '#ebe1cd'],
  accents: ['#f06e1e'], lighting: '', composition: '', materials: [], textures: [], motifs: [], subjectBias: [],
  representativeImages: [], providerHints: {}, images: [], warnings: [], ...fields,
});
const board = (fields: Partial<MoodboardAnalysis>): Moodboard => ({ id: 'board-a', name: 'Board', version: 1,
  images: [{ id: 'image-one', url: '/one.png', weight: 1, notes: '', excluded: false }],
  notes: '', mode: 'look', strength: 0.7, analysis: analysis(fields), thumbnail: '/one.png', createdAt: '', updatedAt: '' });

async function open(saved: Moodboard) {
  api.boards.mockImplementation(async (scope: string) => scope === 'global' ? [saved] : []);
  api.board.mockImplementation(async (id: string) => (id === saved.id ? saved : null));
  useUIStore.getState().enterMoodboardEditor('board-a');
  render(<MoodboardStudioView />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const swatches = (label: string) => within(screen.getByRole('list', { name: label })).getAllByRole('listitem')
  .map((item) => item.getAttribute('title'));

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  api.boards.mockReset(); api.board.mockReset(); setOpenProject(['project-one', 'First project']);
});
afterEach(() => { cleanup(); useUIStore.setState(initialUI, true);
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} }); });

describe('Moodboard Studio extraction', () => {
  it('shows accent colors apart from the palette', async () => {
    await open(board({}));
    expect(swatches('Palette')).toEqual(['#1e285a', '#ebe1cd']);
    expect(swatches('Accents')).toEqual(['#f06e1e']);
    expect(screen.queryByText(/older analyzer/)).toBeNull();
  });

  it('asks to analyze again when the analysis came from the older analyzer', async () => {
    await open(board({ version: 1, accents: undefined }));
    expect(swatches('Palette')).toEqual(['#1e285a', '#ebe1cd']);
    expect(screen.queryByRole('list', { name: 'Accents' })).toBeNull();
    expect(screen.getByText(/Made by the older analyzer, which ignored image weights/)).toBeInTheDocument();
  });
});
