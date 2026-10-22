import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Commons' own ways out while it holds unsaved labels (commons-exits,
 * 2026-10-22): the browser's Back or a hash edit stays in the Commons and
 * puts the URL back, and the header's Projects button is disabled with the
 * reason, as Back already is. After a save each works again.
 */
const commons = vi.hoisted(() => ({
  status: vi.fn(), collections: vi.fn(), search: vi.fn(), folders: vi.fn(), settings: vi.fn(), candidates: vi.fn(),
}));
const capability = vi.hoisted(() => ({ enabled: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({
  commonsApi: commons,
  commonsEvaluationApi: { get: vi.fn() },
  filtersToRequest: () => ({ query: '', filters: {} }),
}));
vi.mock('../src/lib/commonsCapability', () => ({ fetchCommonsEnabled: capability.enabled }));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));
/** Blind labeling with a label set: dirty on mount; Save reports it clean, as the real panel does. */
function LabelingPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  useEffect(() => {
    onDirtyChange?.(true);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange]);
  return <button type="button" onClick={() => onDirtyChange?.(false)}>Save labels</button>;
}
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: LabelingPanel }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: LabelingPanel }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { useUIStore } = await import('../src/store/uiStore');
const { useProjectStore } = await import('../src/store/projectStore');
const { useCommonsCapability } = await import('../src/hooks/useCommonsCapability');

const REASON = 'The Commons has unsaved changes: save or discard them first.';
const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();

function Shell() {
  useCommonsCapability();
  const view = useUIStore((state) => state.viewMode);
  const enabled = useUIStore((state) => state.commonsEnabled);
  return enabled && view === 'commons' ? <CommonsView /> : <p>Current canvas</p>;
}

async function openLabeling(): Promise<void> {
  const tabs = await screen.findByRole('tablist', { name: 'Commons sections' });
  fireEvent.click(within(tabs).getByRole('tab', { name: 'Blind labeling' }));
  await screen.findByRole('button', { name: 'Save labels' });
}

/** The browser's Back (or a hash edit) to `hash`: the URL changes, then hashchange. */
function navigateTo(hash: string): void {
  const oldURL = window.location.href;
  window.history.pushState(null, '', `/${hash}`);
  act(() => { window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href })); });
}

beforeEach(() => {
  history.replaceState(null, '', '/#commons');
  useUIStore.setState(initialUI, true);
  useUIStore.setState({ viewMode: 'canvas', commonsEnabled: false, commonsReturnView: 'canvas' });
  useProjectStore.setState({ ...initialProjects, screen: 'workspace', initialized: true, loading: false,
    activeProject: { id: 'alpha', name: 'Alpha', createdAt: '', updatedAt: '', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null } }, true);
  capability.enabled.mockResolvedValue(true);
  commons.collections.mockResolvedValue([]);
  commons.status.mockResolvedValue({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  commons.search.mockResolvedValue({ results: [] });
  commons.folders.mockResolvedValue([]);
  commons.settings.mockResolvedValue({});
  commons.candidates.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
});

describe('the browser Back button or a hash edit', () => {
  it.each(['', '#brand', '#moodboard/board-1'])('to "%s" while labels are unsaved stays in the Commons and puts #commons back; after saving it leaves', async (hash) => {
    render(<Shell />);
    await openLabeling();

    navigateTo(hash);
    expect(useUIStore.getState().viewMode).toBe('commons');
    expect(window.location.hash).toBe('#commons');
    expect(screen.getByRole('button', { name: 'Save labels' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save labels' }));
    navigateTo(hash);
    expect(useUIStore.getState().viewMode).not.toBe('commons');
  });

  it("a refused Back keeps the canvas entry: after saving, the next Back reaches it", async () => {
    // The canvas entry (marked by its query), then #commons pushed on top,
    // as when the person opens the Commons by its hash.
    history.replaceState(null, '', '/?entry=canvas');
    history.pushState(null, '', '/?entry=canvas#commons');
    // The real traversal (jsdom's is async): wait for its popstate, or give
    // up after a beat when there's nowhere to go back to.
    const back = async () => {
      const settled = new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 300);
        window.addEventListener('popstate', () => { window.clearTimeout(timer); window.setTimeout(resolve, 0); }, { once: true });
      });
      window.history.back();
      await act(async () => { await settled; });
    };
    render(<Shell />);
    await openLabeling();

    await back();
    expect(useUIStore.getState().viewMode).toBe('commons');
    expect(window.location.hash).toBe('#commons');

    fireEvent.click(screen.getByRole('button', { name: 'Save labels' }));
    await back();
    expect(window.location.search).toBe('?entry=canvas');
    expect(window.location.hash).toBe('');
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(await screen.findByText('Current canvas')).toBeTruthy();
  });

  it('leaves a clean Commons, as before', async () => {
    render(<Shell />);
    await screen.findByRole('tablist', { name: 'Commons sections' });
    navigateTo('');
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(await screen.findByText('Current canvas')).toBeTruthy();
  });
});

describe("the header's Projects button", () => {
  it('is disabled with the reason while labels are unsaved, and works after saving', async () => {
    render(<Shell />);
    await openLabeling();
    const home = screen.getByRole('button', { name: 'Back to projects' });
    expect(home).toBeDisabled();
    expect(home).toHaveAttribute('title', REASON);

    fireEvent.click(screen.getByRole('button', { name: 'Save labels' }));
    expect(home).toBeEnabled();
    expect(home).toHaveAttribute('title', 'Projects');
  });
});
