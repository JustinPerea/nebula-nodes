import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabelingWork } from '../src/components/commons/commonsLeave';

/**
 * p157 review: the Commons keeps its "unsaved labels" state to itself
 * (CommonsView disables its own Back, tabs and More), but the Updates corner,
 * now on every screen, can leave the Commons too. CommonsView publishes the
 * state (lib/commonsUnsaved) so the corner's way out (goToCanvas, Review)
 * can refuse while Blind labeling or Agent review holds unsaved work.
 */

const commons = vi.hoisted(() => ({
  status: vi.fn(), collections: vi.fn(), search: vi.fn(), folders: vi.fn(), settings: vi.fn(), candidates: vi.fn(),
}));
const dirty = vi.hoisted(() => ({ value: true }));
vi.mock('../src/lib/commonsApi', () => ({
  commonsApi: commons,
  commonsEvaluationApi: { get: vi.fn() },
  filtersToRequest: () => ({ query: '', filters: {} }),
}));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
/** A panel with unsaved work, reported the way the real ones do (the panel contract: unsaved on mount, gone on unmount). */
function DirtyPanel({ onWork }: { onWork?: (work: LabelingWork | null) => void }) {
  useEffect(() => {
    onWork?.({ unsaved: dirty.value, saving: null, running: false, save: async () => ({ ok: true }), discard: () => {}, stop: () => {} });
    return () => onWork?.(null);
  }, [onWork]);
  return <p>panel</p>;
}
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: DirtyPanel }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: DirtyPanel }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { useUIStore } = await import('../src/store/uiStore');

beforeEach(() => {
  dirty.value = true;
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  commons.collections.mockResolvedValue([]);
  commons.status.mockResolvedValue({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  commons.search.mockResolvedValue({ results: [] });
  commons.folders.mockResolvedValue([]);
  commons.settings.mockResolvedValue({});
  commons.candidates.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe('the Commons says when it holds unsaved labels', () => {
  it.each(['Agent review', 'Blind labeling'])('while %s holds unsaved work, and not after it unmounts', async (name) => {
    const { commonsUnsaved } = await import('../src/lib/commonsUnsaved');
    const view = render(<CommonsView />);
    await screen.findByRole('tablist', { name: 'Commons sections' });
    expect(commonsUnsaved()).toBe(false);
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Commons sections' })).getByRole('tab', { name }));
    await vi.waitFor(() => expect(commonsUnsaved()).toBe(true));
    act(() => view.unmount());
    expect(commonsUnsaved()).toBe(false);
  });

  it('a clean panel reports nothing unsaved', async () => {
    dirty.value = false;
    const { commonsUnsaved } = await import('../src/lib/commonsUnsaved');
    render(<CommonsView />);
    await screen.findByRole('tablist', { name: 'Commons sections' });
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Commons sections' })).getByRole('tab', { name: 'Agent review' }));
    await screen.findByText('panel');
    expect(commonsUnsaved()).toBe(false);
  });
});
