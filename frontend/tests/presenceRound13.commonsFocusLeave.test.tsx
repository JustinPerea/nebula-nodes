/**
 * PR #204 round 13 (review 10 MEDIUM-2): the Commons no longer remounts on a demote, and two
 * things the remount used to end now end on their own:
 * - the leave popover the person was asking from: the panes it asked about start again, so it
 *   closes (focus goes on to a control still there);
 * - the New collection prompt is Add's: it goes while Add is locked, as Add's menu does, and
 *   comes back with it on the promote.
 */
import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabelingWork } from '../src/components/commons/commonsLeave';

const commons = vi.hoisted(() => ({
  status: vi.fn(), collections: vi.fn(), search: vi.fn(), folders: vi.fn(), settings: vi.fn(), candidates: vi.fn(),
}));
vi.mock('../src/lib/commonsApi', () => ({
  commonsApi: commons,
  commonsEvaluationApi: { get: vi.fn() },
  filtersToRequest: () => ({ query: '', filters: {} }),
}));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
/** Blind labeling with a label set: unsaved on mount (the panel contract, onWork). */
function LabelingPanel({ onWork }: { onWork?: (work: LabelingWork | null) => void }) {
  const [unsaved, setUnsaved] = useState(true);
  useEffect(() => {
    onWork?.({ unsaved, saving: null, running: false, save: async () => { setUnsaved(false); return { ok: true }; },
      discard: () => setUnsaved(false), stop: () => {} });
  }, [onWork, unsaved]);
  useEffect(() => () => onWork?.(null), [onWork]);
  return <button type="button" onClick={() => setUnsaved(false)}>Save labels</button>;
}
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: LabelingPanel }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: LabelingPanel }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const session = await import('../src/lib/personSession');
const { holdCommonsCalls } = await import('../src/lib/commonsHold');
const { useUIStore } = await import('../src/store/uiStore');
const initialUI = useUIStore.getState();

const flush = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); };
const wait = (ms: number) => act(() => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
const demote = async () => {
  act(() => { session.notePersonPromoted(); session.reportPersonRequired(); });
  await wait(220);
  await flush();
};

beforeEach(() => {
  session.resetPersonSessionForTests();
  act(() => session.notePersonPromoted());
  holdCommonsCalls(false);
  useUIStore.setState(initialUI, true);
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  commons.collections.mockResolvedValue([{ id: 'c1', name: 'Refs', kind: 'user' }]);
  commons.status.mockResolvedValue({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  commons.search.mockResolvedValue({ results: [] });
  commons.folders.mockResolvedValue([]);
  commons.settings.mockResolvedValue({});
  commons.candidates.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  useUIStore.setState(initialUI, true);
});

describe('what the old remount ended', () => {
  it('a leave popover open at the demote closes with the panes it asked about', async () => {
    render(<CommonsView />);
    await flush();
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Commons sections' })).getByRole('tab', { name: 'Blind labeling' }));
    await screen.findByRole('button', { name: 'Save labels' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    await demote();
    // Real timers under a loaded machine: the 150 ms hold settles, then the view switches.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // The header's controls are still the same: Back is there to try again.
    expect(screen.getByRole('button', { name: 'Back to Canvas' })).toBeTruthy();
  });

  it('the New collection prompt goes while Add is locked and comes back on the promote', async () => {
    render(<CommonsView />);
    await flush();
    fireEvent.change(screen.getByRole('combobox', { name: 'Add to' }), { target: { value: '__new__' } });
    await flush();
    expect(screen.getByRole('textbox', { name: /New collection name/ })).toBeTruthy();

    await demote();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /New collection name/ })).toBeNull());

    act(() => session.notePersonPromoted());
    await flush();
    expect(screen.getByRole('textbox', { name: /New collection name/ })).toBeTruthy();
  });
});
