import { useCallback, useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabelingWork, SaveResult } from '../src/components/commons/commonsLeave';

/**
 * Leaving the Commons with unsaved labels asks first (commons-leave, GM -
 * Design's treatment, 2026-10-22). #163 held every exit and disabled the
 * Commons' Back, Projects, the tabs and More. Now: the tabs and More stay
 * enabled (moving between sections isn't leaving; the panels keep their
 * drafts), and the real exits (Back, Projects, the browser's Back, the
 * Updates corner) open a small popover anchored to what was clicked:
 * "Your labels aren't saved." with Save and leave / Discard and leave / Stay.
 * The panels are stand-ins that keep the panel contract (onWork).
 */

const commons = vi.hoisted(() => ({
  status: vi.fn(), collections: vi.fn(), search: vi.fn(), folders: vi.fn(), settings: vi.fn(), candidates: vi.fn(),
}));
const capability = vi.hoisted(() => ({ enabled: vi.fn() }));
/** Each stand-in panel's start state and its save, discard and stop. */
const panels = vi.hoisted(() => ({
  labeling: { unsaved: true, running: false, save: vi.fn(), discard: vi.fn(), stop: vi.fn() },
  review: { unsaved: false, running: false, save: vi.fn(), discard: vi.fn(), stop: vi.fn() },
  /** The next in-flight save (the panel's own Save labels): settle it from the test. */
  inFlight: null as null | ((result: SaveResult) => void),
}));
vi.mock('../src/lib/commonsApi', () => ({
  commonsApi: commons,
  commonsEvaluationApi: { get: vi.fn() },
  filtersToRequest: () => ({ query: '', filters: {} }),
}));
vi.mock('../src/lib/commonsCapability', () => ({ fetchCommonsEnabled: capability.enabled }));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

function StandIn({ name, onWork }: { name: 'labeling' | 'review'; onWork?: (work: LabelingWork | null) => void }) {
  const config = panels[name];
  const [unsaved, setUnsaved] = useState(config.unsaved);
  const [running, setRunning] = useState(config.running);
  const [saving, setSaving] = useState<Promise<SaveResult> | null>(null);
  const save = useCallback(async (): Promise<SaveResult> => {
    const result: SaveResult = (await config.save()) ?? { ok: true };
    if (result.ok) setUnsaved(false);
    return result;
  }, [config]);
  const discard = useCallback(() => { config.discard(); setUnsaved(false); }, [config]);
  const stop = useCallback(() => { config.stop(); setRunning(false); }, [config]);
  useEffect(() => { onWork?.({ unsaved, saving, running, save, discard, stop }); }, [onWork, unsaved, saving, running, save, discard, stop]);
  useEffect(() => () => onWork?.(null), [onWork]);
  const startSave = () => {
    const promise = new Promise<SaveResult>((resolve) => { panels.inFlight = resolve; })
      .then((result) => { setSaving(null); if (result.ok) setUnsaved(false); return result; });
    setSaving(promise);
  };
  return (
    <section aria-label={`${name} panel`}>
      <button type="button" onClick={startSave}>Save labels</button>
      <span>{unsaved ? `${name} draft kept` : `${name} clean`}</span>
    </section>
  );
}
vi.mock('../src/components/commons/CommonsEvaluation', () => ({
  CommonsEvaluation: (props: { onWork?: (work: LabelingWork | null) => void }) => <StandIn name="labeling" {...props} />,
}));
vi.mock('../src/components/commons/CommonsReview', () => ({
  CommonsReview: (props: { onWork?: (work: LabelingWork | null) => void }) => <StandIn name="review" {...props} />,
}));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { useUIStore } = await import('../src/store/uiStore');
const { useProjectStore } = await import('../src/store/projectStore');
const { useCommonsCapability } = await import('../src/hooks/useCommonsCapability');
const { askBeforeLeavingCommons, commonsUnsaved } = await import('../src/lib/commonsUnsaved');

const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const goHome = vi.fn(async () => { useProjectStore.setState({ screen: 'home' }); });

function Shell() {
  useCommonsCapability();
  const view = useUIStore((state) => state.viewMode);
  const enabled = useUIStore((state) => state.commonsEnabled);
  return enabled && view === 'commons' ? <CommonsView /> : <p>Current {view}</p>;
}

function tabs() {
  return screen.getByRole('tablist', { name: 'Commons sections' });
}

async function openLabeling(): Promise<void> {
  await screen.findByRole('tablist', { name: 'Commons sections' });
  fireEvent.click(within(tabs()).getByRole('tab', { name: /^Blind labeling/ }));
  await screen.findByText('labeling draft kept');
  await waitFor(() => expect(commonsUnsaved()).toBe(true));
}

const back = () => screen.getByRole('button', { name: /^Back to Canvas|^Saving/ });
const home = () => screen.getByRole('button', { name: /^Back to projects|^Saving/ });
const popover = () => screen.getByRole('alertdialog');
const popoverButtons = () => within(popover()).getAllByRole('button').map((button) => button.textContent);

beforeEach(() => {
  history.replaceState(null, '', '/#commons');
  useUIStore.setState(initialUI, true);
  useUIStore.setState({ viewMode: 'canvas', commonsEnabled: false, commonsReturnView: 'canvas' });
  useProjectStore.setState({ ...initialProjects, screen: 'workspace', initialized: true, loading: false, goHome,
    activeProject: { id: 'alpha', name: 'Alpha', createdAt: '', updatedAt: '', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null } }, true);
  goHome.mockClear();
  for (const panel of [panels.labeling, panels.review]) {
    panel.save.mockReset().mockResolvedValue({ ok: true });
    panel.discard.mockReset();
    panel.stop.mockReset();
  }
  panels.labeling.unsaved = true; panels.labeling.running = false;
  panels.review.unsaved = false; panels.review.running = false;
  panels.inFlight = null;
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

describe('moving between sections is not leaving', () => {
  it('keeps the tabs and More enabled while labels are unsaved, and the draft survives Inbox and back', async () => {
    render(<Shell />);
    await openLabeling();
    for (const tab of within(tabs()).getAllByRole('tab')) expect(tab).toBeEnabled();
    expect(screen.getByRole('button', { name: /^More/ })).toBeEnabled();

    fireEvent.click(within(tabs()).getByRole('tab', { name: 'Inbox' }));
    expect(screen.getByText('labeling draft kept')).not.toBeVisible();
    // Still unsaved while another section shows: the drafts live on.
    expect(commonsUnsaved()).toBe(true);
    fireEvent.click(within(tabs()).getByRole('tab', { name: 'Settings' }));
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Blind labeling/ }));
    expect(screen.getByText('labeling draft kept')).toBeVisible();
    expect(panels.labeling.discard).not.toHaveBeenCalled();
  });

  it('marks the tab holding unsaved labels with a dot and "Unsaved" in its name, from any section', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(within(tabs()).getByRole('tab', { name: 'All' }));
    const tab = within(tabs()).getByRole('tab', { name: /^Blind labeling/ });
    expect(tab).toHaveAccessibleName(/Unsaved/);
    expect(tab.querySelector('.commons-tab__dot')).not.toBeNull();
    expect(within(tabs()).getByRole('tab', { name: 'Agent review' }).querySelector('.commons-tab__dot')).toBeNull();
    expect(screen.getByRole('button', { name: /^More/ })).toHaveAccessibleName(/Unsaved/);
  });
});

describe("the Commons' Back and Projects ask instead of being disabled", () => {
  it('stay enabled, with no "save or discard" title', async () => {
    render(<Shell />);
    await openLabeling();
    expect(back()).toBeEnabled();
    expect(home()).toBeEnabled();
    expect(home()).toHaveAttribute('title', 'Projects');
    expect(document.body.innerHTML).not.toContain('save or discard them first');
  });

  it('Back opens the popover with the exact copy, its buttons in order, and focus on Save and leave', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(back());
    const dialog = popover();
    expect(dialog).toHaveTextContent("Your labels aren't saved.");
    expect(dialog).toHaveAccessibleName("Your labels aren't saved.");
    expect(popoverButtons()).toEqual(['Save and leave', 'Discard and leave', 'Stay']);
    expect(within(dialog).getByRole('button', { name: 'Save and leave' })).toHaveClass('commons-button--primary');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save and leave' })).toHaveFocus());
    expect(useUIStore.getState().viewMode).toBe('commons');
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(document.activeElement ?? popover(), { key: 'Escape' })],
    ['Stay', () => fireEvent.click(within(popover()).getByRole('button', { name: 'Stay' }))],
  ])('%s stays: the popover closes, focus returns to Back, the draft is kept', async (_name, close) => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(back());
    await waitFor(() => expect(within(popover()).getByRole('button', { name: 'Save and leave' })).toHaveFocus());
    close();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(back()).toHaveFocus();
    expect(useUIStore.getState().viewMode).toBe('commons');
    expect(screen.getByText('labeling draft kept')).toBeTruthy();
    expect(panels.labeling.save).not.toHaveBeenCalled();
    expect(panels.labeling.discard).not.toHaveBeenCalled();
  });

  it('a click outside stays', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(back());
    popover();
    fireEvent.pointerDown(screen.getByText('labeling draft kept'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useUIStore.getState().viewMode).toBe('commons');
    expect(panels.labeling.discard).not.toHaveBeenCalled();
  });

  it('Save and leave runs the panel\'s own save, then leaves by Back', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(back());
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    expect(await screen.findByText('Current canvas')).toBeTruthy();
    expect(panels.labeling.save).toHaveBeenCalledTimes(1);
    expect(panels.labeling.discard).not.toHaveBeenCalled();
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(commonsUnsaved()).toBe(false);
  });

  it('Discard and leave runs the panel\'s own discard, then leaves by Back', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(back());
    fireEvent.click(within(popover()).getByRole('button', { name: 'Discard and leave' }));
    expect(await screen.findByText('Current canvas')).toBeTruthy();
    expect(panels.labeling.discard).toHaveBeenCalledTimes(1);
    expect(panels.labeling.save).not.toHaveBeenCalled();
  });

  it('saves and discards every panel holding a draft (Blind labeling and Agent review)', async () => {
    panels.review.unsaved = true;
    render(<Shell />);
    await openLabeling();
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Agent review/ }));
    await screen.findByText('review draft kept');
    fireEvent.click(back());
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    expect(await screen.findByText('Current canvas')).toBeTruthy();
    expect(panels.labeling.save).toHaveBeenCalledTimes(1);
    expect(panels.review.save).toHaveBeenCalledTimes(1);
  });

  it('Projects opens the same popover anchored to it; Save and leave saves, then goes to Projects', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(home());
    expect(popover()).toHaveTextContent("Your labels aren't saved.");
    expect(popover().dataset.anchor).toBe('home');
    expect(goHome).not.toHaveBeenCalled();
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(goHome).toHaveBeenCalledTimes(1));
    expect(panels.labeling.save).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().screen).toBe('home');
  });

  // GM: a conflict (or any refusal the same request would get again) can't
  // be fixed by saving again, so Save and leave goes and focus waits on Stay,
  // where the person can reload. A failure worth retrying (no answer, a
  // server error) keeps Save and leave as the retry.
  it('a conflict leaves only Discard and leave / Stay, with focus on Stay', async () => {
    panels.labeling.save.mockResolvedValue({ ok: false, reason: 'Labels changed in another window. Reload before saving.', retry: false });
    render(<Shell />);
    await openLabeling();
    fireEvent.click(back());
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(popover()).toHaveTextContent("Couldn’t save your labels."));
    expect(popover()).toHaveTextContent('Labels changed in another window. Reload before saving.');
    expect(popover()).not.toHaveTextContent("Your labels aren't saved.");
    expect(popoverButtons()).toEqual(['Discard and leave', 'Stay']);
    await waitFor(() => expect(within(popover()).getByRole('button', { name: 'Stay' })).toHaveFocus());
    expect(useUIStore.getState().viewMode).toBe('commons');
    fireEvent.click(within(popover()).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(back()).toHaveFocus();
    expect(useUIStore.getState().viewMode).toBe('commons');
  });

  it('a failure worth retrying keeps Save and leave as the retry, with focus on it', async () => {
    panels.labeling.save.mockResolvedValueOnce({ ok: false, reason: 'Commons request failed (503)', retry: true });
    render(<Shell />);
    await openLabeling();
    fireEvent.click(back());
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(popover()).toHaveTextContent("Couldn’t save your labels."));
    expect(popover()).toHaveTextContent('Commons request failed (503)');
    expect(popoverButtons()).toEqual(['Save and leave', 'Discard and leave', 'Stay']);
    await waitFor(() => expect(within(popover()).getByRole('button', { name: 'Save and leave' })).toHaveFocus());
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    expect(await screen.findByText('Current canvas')).toBeTruthy();
    expect(panels.labeling.save).toHaveBeenCalledTimes(2);
  });

  // Review: the failure lands in place in an open popover, with focus still
  // on Save and leave, so it must be announced.
  it('announces a failed Save and leave: the reason is an alert, and a second failure is announced again', async () => {
    panels.labeling.save.mockResolvedValue({ ok: false, reason: 'Commons request failed (503)', retry: true });
    render(<Shell />);
    await openLabeling();
    fireEvent.click(back());
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    const alert = await within(popover()).findByRole('alert');
    expect(alert).toHaveTextContent('Commons request failed (503)');
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(panels.labeling.save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(popover()).getByRole('alert')).not.toBe(alert));
    expect(within(popover()).getByRole('alert')).toHaveTextContent('Commons request failed (503)');
  });

  // Review: a press on the popover's own text moves focus where the browser
  // puts it, the nearest focusable ancestor (jsdom doesn't, so the test does).
  it('Escape still stays after a press on the popover\'s text, and Tab stays among its buttons', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(back());
    await waitFor(() => expect(within(popover()).getByRole('button', { name: 'Save and leave' })).toHaveFocus());
    const line = within(popover()).getByText("Your labels aren't saved.");
    fireEvent.pointerDown(line);
    fireEvent.mouseDown(line);
    const target = line.closest<HTMLElement>('[tabindex]');
    if (target) target.focus(); else (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(popover());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(within(popover()).getByRole('button', { name: 'Save and leave' })).toHaveFocus();
    line.closest<HTMLElement>('[tabindex]')?.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(back()).toHaveFocus();
    expect(useUIStore.getState().viewMode).toBe('commons');
  });

  it('a clean Commons leaves at once, with no popover', async () => {
    panels.labeling.unsaved = false;
    render(<Shell />);
    await screen.findByRole('tablist', { name: 'Commons sections' });
    fireEvent.click(back());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('Current canvas')).toBeTruthy();
  });
});

describe('a save already in progress', () => {
  it('a leave waits for it, with no popover; after about 300 ms Back reads "Saving…" and is busy; then it goes', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(screen.getByRole('button', { name: 'Save labels' }));
    await waitFor(() => expect(panels.inFlight).not.toBeNull());
    fireEvent.click(back());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(back()).not.toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(back()).toHaveAttribute('aria-busy', 'true'), { timeout: 1500 });
    expect(back()).toHaveTextContent('Saving…');
    expect(back()).toHaveAccessibleName('Saving…');
    await act(async () => { panels.inFlight!({ ok: true }); });
    expect(await screen.findByText('Current canvas')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('when that save fails the popover opens with "Couldn\'t save your labels." and the reason', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(screen.getByRole('button', { name: 'Save labels' }));
    await waitFor(() => expect(panels.inFlight).not.toBeNull());
    fireEvent.click(home());
    await act(async () => { panels.inFlight!({ ok: false, reason: 'Disk is read-only.', retry: true }); });
    await waitFor(() => expect(popover()).toHaveTextContent("Couldn’t save your labels."));
    expect(popover()).toHaveTextContent('Disk is read-only.');
    expect(popoverButtons()).toEqual(['Save and leave', 'Discard and leave', 'Stay']);
    expect(popover().dataset.anchor).toBe('home');
    expect(home()).not.toHaveAttribute('aria-busy', 'true');
    expect(goHome).not.toHaveBeenCalled();
  });
});

describe('a save already in progress that hits a conflict', () => {
  it('opens with Discard and leave / Stay only, focus on Stay', async () => {
    render(<Shell />);
    await openLabeling();
    fireEvent.click(screen.getByRole('button', { name: 'Save labels' }));
    await waitFor(() => expect(panels.inFlight).not.toBeNull());
    fireEvent.click(back());
    await act(async () => { panels.inFlight!({ ok: false, reason: 'Labels changed in another window. Reload before saving.', retry: false }); });
    await waitFor(() => expect(popover()).toHaveTextContent("Couldn’t save your labels."));
    expect(popoverButtons()).toEqual(['Discard and leave', 'Stay']);
    await waitFor(() => expect(within(popover()).getByRole('button', { name: 'Stay' })).toHaveFocus());
  });
});

describe('Agent review still grading', () => {
  it('asks "Agent review is still running." with Stop and leave / Stay; Stop and leave stops it, then leaves', async () => {
    panels.labeling.unsaved = false;
    panels.review.running = true;
    render(<Shell />);
    await screen.findByRole('tablist', { name: 'Commons sections' });
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Agent review/ }));
    await screen.findByText('review clean');
    fireEvent.click(back());
    expect(popover()).toHaveTextContent('Agent review is still running.');
    expect(popover()).not.toHaveTextContent("Your labels aren't saved.");
    expect(popoverButtons()).toEqual(['Stop and leave', 'Stay']);
    await waitFor(() => expect(within(popover()).getByRole('button', { name: 'Stop and leave' })).toHaveFocus());
    fireEvent.click(within(popover()).getByRole('button', { name: 'Stop and leave' }));
    expect(await screen.findByText('Current canvas')).toBeTruthy();
    expect(panels.review.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps running while the person moves to another section', async () => {
    panels.labeling.unsaved = false;
    panels.review.running = true;
    render(<Shell />);
    await screen.findByRole('tablist', { name: 'Commons sections' });
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Agent review/ }));
    await screen.findByText('review clean');
    fireEvent.click(within(tabs()).getByRole('tab', { name: 'All' }));
    expect(panels.review.stop).not.toHaveBeenCalled();
    expect(commonsUnsaved()).toBe(true);
  });
});

/** The traversal a leave starts (history.back()): its popstate or hashchange, then a beat. */
function traversal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => window.setTimeout(resolve, 0);
    window.addEventListener('popstate', done, { once: true });
    window.addEventListener('hashchange', done, { once: true });
  });
}

describe('the browser Back button or an in-app hash change', () => {
  /** The real traversal (jsdom's is async): wait for its popstate, or give up after a beat. */
  async function browserBack() {
    const settled = new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 300);
      window.addEventListener('popstate', () => { window.clearTimeout(timer); window.setTimeout(resolve, 0); }, { once: true });
    });
    window.history.back();
    await act(async () => { await settled; });
  }

  it('opens the popover anchored to Back; leaving lands on the entry they went back to, and one more Back stays out', async () => {
    // An earlier entry, the canvas entry, then #commons on top.
    history.replaceState(null, '', '/?entry=before');
    history.pushState(null, '', '/?entry=canvas');
    history.pushState(null, '', '/?entry=canvas#commons');
    render(<Shell />);
    await openLabeling();

    await browserBack();
    expect(useUIStore.getState().viewMode).toBe('commons');
    expect(window.location.hash).toBe('#commons');
    expect(popover().dataset.anchor).toBe('back');
    await waitFor(() => expect(within(popover()).getByRole('button', { name: 'Save and leave' })).toHaveFocus());

    const left = traversal();
    fireEvent.click(within(popover()).getByRole('button', { name: 'Discard and leave' }));
    await act(async () => { await left; });
    expect(panels.labeling.discard).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?entry=canvas');
    expect(window.location.hash).toBe('');
    expect(await screen.findByText('Current canvas')).toBeTruthy();

    // One more Back goes further back, not into the Commons again.
    await browserBack();
    expect(window.location.search).toBe('?entry=before');
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });

  it('Stay keeps the person in the Commons with #commons, and focus on Back', async () => {
    history.replaceState(null, '', '/?entry=canvas');
    history.pushState(null, '', '/?entry=canvas#commons');
    render(<Shell />);
    await openLabeling();
    await browserBack();
    fireEvent.click(within(popover()).getByRole('button', { name: 'Stay' }));
    expect(useUIStore.getState().viewMode).toBe('commons');
    expect(window.location.hash).toBe('#commons');
    expect(back()).toHaveFocus();
  });

  it('a hash change to #brand asks the same way; leaving opens the brand page', async () => {
    render(<Shell />);
    await openLabeling();
    const oldURL = window.location.href;
    window.history.pushState(null, '', '/#brand');
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href })); });
    expect(window.location.hash).toBe('#commons');
    expect(popover().dataset.anchor).toBe('back');
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    // The save settles first (its state lands through React), then the Back.
    await waitFor(() => expect(window.location.hash).toBe('#brand'));
    await waitFor(() => expect(useUIStore.getState().viewMode).not.toBe('commons'));
    expect(panels.labeling.save).toHaveBeenCalledTimes(1);
  });
});

describe('the Updates corner leaves through the same popover', () => {
  it('asks anchored to the clicked button, and its step runs only after a leave', async () => {
    render(<Shell />);
    await openLabeling();
    const corner = document.createElement('button');
    corner.textContent = 'Show on canvas';
    document.body.appendChild(corner);
    const step = vi.fn();
    let asked = false;
    act(() => { asked = askBeforeLeavingCommons(corner, step); });
    expect(asked).toBe(true);
    expect(popover().dataset.anchor).toBe('other');
    expect(step).not.toHaveBeenCalled();
    fireEvent.click(within(popover()).getByRole('button', { name: 'Stay' }));
    expect(corner).toHaveFocus();
    expect(step).not.toHaveBeenCalled();

    act(() => { askBeforeLeavingCommons(corner, step); });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Discard and leave' }));
    await waitFor(() => expect(step).toHaveBeenCalledTimes(1));
    expect(commonsUnsaved()).toBe(false);
    corner.remove();
  });

  it('asks nothing of a clean Commons', async () => {
    panels.labeling.unsaved = false;
    render(<Shell />);
    await screen.findByRole('tablist', { name: 'Commons sections' });
    expect(askBeforeLeavingCommons(document.body, vi.fn())).toBe(false);
  });
});
