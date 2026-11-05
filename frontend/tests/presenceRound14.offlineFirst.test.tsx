/**
 * PR #204 round 14, GM r23 answer 3: offline comes first. While Nebula is offline only the offline
 * notice shows: a not-connected line (a lock's line, a because line, the general notice) waits,
 * since connecting the tab wouldn't be enough. Back online and still not connected, it shows.
 * The Commons and the lock lines are pinned in presenceRound14.commonsLock and .pickerLine; this
 * file pins the rest of the places listed in the round 14 notes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const { CanvasMessageNotice } = await import('../src/components/canvas/CanvasMessageNotice');
const { CanvasUndoNotice } = await import('../src/components/canvas/CanvasUndoNotice');
const { useGraphStore } = await import('../src/store/graphStore');
const connection = await import('../src/lib/backendConnection');
const session = await import('../src/lib/personSession');
const copy = await import('../src/lib/errorCopy');

const SRC = join(__dirname, '../src');
const text = () => document.body.textContent ?? '';

afterEach(() => {
  cleanup();
  act(() => { connection.noteBackendConnection('online'); });
  session.notePersonPromoted();
  useGraphStore.getState().dismissMessageNotice?.();
  useGraphStore.getState().dismissUndoNotice?.();
});

describe('offline comes first (GM r23 3)', () => {
  it('the general notice waits while offline and comes back online', async () => {
    render(<PersonRequiredBanner />);
    act(() => { session.reportPersonRequired(); });
    const general = session.personRequiredMessage();
    await waitFor(() => expect(text()).toContain(general));
    act(() => { connection.noteBackendConnection('offline'); });
    await waitFor(() => expect(text()).not.toContain(general));
    act(() => { connection.noteBackendConnection('online'); });
    await waitFor(() => expect(text()).toContain(general));
  });

  it('a because line in the notice region (the undo slot, where error lines go) waits while offline; any other message shows', async () => {
    render(<><CanvasUndoNotice /><CanvasMessageNotice /></>);
    const because = copy.notConnectedBecause('save the style');
    act(() => { connection.noteBackendConnection('offline'); });
    act(() => { useGraphStore.getState().notify(because, 'error'); });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(text()).not.toContain(because);
    act(() => { connection.noteBackendConnection('online'); });
    await waitFor(() => expect(text()).toContain(because));
    act(() => { connection.noteBackendConnection('offline'); });
    act(() => { useGraphStore.getState().notify('Couldn’t save the style. Try again.', 'error'); });
    await waitFor(() => expect(text()).toContain('Couldn’t save the style. Try again.'));
  });

  it('every other place where a not-connected line and the offline notice could meet applies the rule', () => {
    const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
    expect(read('components/canvas/PinComposer.tsx')).toMatch(/const gateBanner = \(bannerUp && !lock\.offline\) \|\| sendLock\.shown;/);
    expect(read('components/proposals/AssetProposalStrip.tsx')).toMatch(/\{!offline && <p className="asset-proposal__held-line">/);
    expect(read('components/panels/Inspector.tsx')).toMatch(/const shownFavoriteError = useOfflineFirstBecause\(favoriteError\);/);
    expect(read('components/panels/Inspector.tsx')).not.toMatch(/<LineText text=\{favoriteError\}/);
    expect(read('components/projects/ProjectHome.tsx')).toMatch(/const errorKept = useOfflineFirstBecause\(error \?\? null\);\n\s*const showError = !unsavedEdits && Boolean\(errorKept\);/);
    expect(read('components/panels/settings/AgentSpendSection.tsx')).toMatch(/useOfflineFirstBecause\(held \? notConnectedBecause\('load the connected apps'\) : error\)/);
    expect(read('components/panels/settings/PersonalAgentsSection.tsx')).toMatch(/useOfflineFirstBecause\(demoted \? notConnectedBecause\('load your agents'\) : error\)/);
  });
});
