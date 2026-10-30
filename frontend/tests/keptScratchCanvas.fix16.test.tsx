/**
 * Round 16 of PR #199 (GM r21 and r22; review 14), the kept tab's own side.
 * - GM r22 (3): the Discard confirm is modal: the page behind it is inert,
 *   its own kept notice included, while the notice region's other notices
 *   stay reachable; Escape closes it and focus goes back to [Discard edits].
 * - GM r22 (4): the locked adds' own verbs; the wire-drop popup is live.
 * - Review 14 kept-hold LOW-1 (one busy state) and LOW-2 (H19, the switch
 *   toast's way back held while kept); lock-order NIT-3 (following holds
 *   Save and Discard, after kept and the run) and LOW-3 (the lazy restore
 *   copy retries and never leaves a blank notice).
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}),
  disconnect: vi.fn(), send: vi.fn(), setViewing: vi.fn(), notePersonAct: vi.fn(), setKeptEdits: vi.fn() } }));

import { NoticeRegion } from '../src/components/NoticeRegion';
import { InNoticeRegion } from '../src/components/InNoticeRegion';
import { KeptEditsNotice } from '../src/components/projects/KeptEditsNotice';
import { DISCARD_EDITS, KEEP_THEM } from '../src/components/projects/KeptDiscardConfirm';
import { ProjectSwitchToast } from '../src/components/projects/ProjectSwitchToast';
import { keepCanvasLocally, releaseKeptCanvas, useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { KEPT_MARK } from '../src/lib/canvasLock';
import { keptLockTitle, resetKeptCanvasForTests, subscribeKeptPulse } from '../src/lib/keptCanvas';
import { setFollowingSwitch } from '../src/lib/canvasFollow';
import { primeRestoreCopyForTests, restoreCopyNow, setRestoreCopyImportForTests, useRestoreCopyState,
  type RestoreCopy } from '../src/components/projects/restoreCopyLoader';
import { RESTORE_COPY_FALLBACK } from '../src/components/projects/restoreCopyCore';

const KEPT = { sourceId: 'alpha', sourceName: 'Alpha', lead: null, saving: false, error: null };
const initialProject = useProjectStore.getState();
let pulses = 0;
let stopPulses: () => void = () => {};

beforeEach(() => {
  resetKeptCanvasForTests();
  useGraphStore.setState({ nodes: [], edges: [], isExecuting: false, keptUndo: [], keptRedo: [] });
  keepCanvasLocally();
  useProjectStore.setState({ screen: 'workspace', keptEdits: { ...KEPT } });
  pulses = 0;
  stopPulses = subscribeKeptPulse(() => { pulses += 1; });
});
afterEach(() => {
  cleanup();
  stopPulses();
  setFollowingSwitch(null);
  releaseKeptCanvas();
  resetKeptCanvasForTests();
  useProjectStore.setState(initialProject, true);
  vi.restoreAllMocks();
});

describe('GM r22 (3): the Discard confirm is modal, with the page behind it inert', () => {
  function renderApp() {
    return render(<>
      <div data-testid="app"><button type="button">Canvas control</button></div>
      <NoticeRegion screen="canvas" />
      <InNoticeRegion slot="kept-edits"><KeptEditsNotice /></InNoticeRegion>
      <InNoticeRegion slot="project-switch"><div><button type="button">Other notice</button></div></InNoticeRegion>
    </>);
  }

  it('inert behind it (the kept notice too); the other notices stay reachable; Escape returns to [Discard edits]', async () => {
    renderApp();
    const discard = screen.getByRole('button', { name: DISCARD_EDITS });
    discard.focus();
    fireEvent.click(discard);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: KEEP_THEM })).toHaveFocus();
    // The app behind it.
    // The app behind it (its root, a child of <body>).
    const app = screen.getByTestId('app').parentElement!;
    expect(app.parentElement).toBe(document.body);
    expect(app).toHaveAttribute('inert');
    expect(app).toHaveAttribute('aria-hidden', 'true');
    // The notice that owns it isn't one of the notices above dialogs.
    const notice = document.querySelector('[data-kept-edits]')!;
    expect(notice).toHaveAttribute('inert');
    expect(document.querySelector('[data-notice-region]')).not.toHaveAttribute('inert');
    expect(screen.getByText('Other notice').closest('[inert]')).toBeNull();
    // Tab from the dialog's last button goes to the other notice, never the kept one.
    const buttons = [...dialog.querySelectorAll('button')];
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Tab' });
    expect(screen.getByText('Other notice')).toHaveFocus();
    // Escape (from the dialog) closes it; focus goes back to [Discard edits].
    screen.getByRole('button', { name: KEEP_THEM }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(app).not.toHaveAttribute('inert');
    expect(notice).not.toHaveAttribute('inert');
    await waitFor(() => expect(screen.getByRole('button', { name: DISCARD_EDITS })).toHaveFocus());
  });
});

describe('review 14 of PR #199, kept-hold LOW-1: one busy state for Save and Discard', () => {
  it('while either is on its way, both buttons wait', () => {
    useProjectStore.setState({ keptEdits: { ...KEPT, discarding: true } });
    const view = render(<KeptEditsNotice />);
    expect(screen.getByRole('button', { name: 'Save as a project' })).toBeDisabled();
    expect(screen.getByRole('button', { name: DISCARD_EDITS })).toBeDisabled();
    expect(screen.getByRole('button', { name: DISCARD_EDITS })).toHaveAttribute('aria-busy', 'true');
    act(() => useProjectStore.setState({ keptEdits: { ...KEPT, saving: true } }));
    view.rerender(<KeptEditsNotice />);
    expect(screen.getByRole('button', { name: DISCARD_EDITS })).toBeDisabled();
  });
});

describe('review 14 of PR #199, lock-order NIT-3: kept, then the run, following and offline', () => {
  it('following holds Save and Discard with its own line (kept leaves them on)', () => {
    act(() => setFollowingSwitch({ projectName: 'Beta', agent: 'Claude' }));
    render(<KeptEditsNotice />);
    for (const name of ['Save as a project', DISCARD_EDITS]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button.getAttribute('title')).toContain('Beta');
    }
  });
});

describe('review 14 of PR #199, kept-hold LOW-2 (H19): the switch toast’s way back while kept', () => {
  it('“Back to …” is held with the kept mark and its line, and a press pulses the kept line', () => {
    useProjectStore.setState({ switchNotice: { actorName: 'Claude', projectName: 'Beta', previousProjectId: 'alpha',
      previousProjectName: 'Alpha', created: false } as never });
    render(<><KeptEditsNotice /><ProjectSwitchToast /></>);
    const back = screen.getByRole('button', { name: 'Back to “Alpha”' });
    expect(back).toBeDisabled();
    expect(back).toHaveAttribute(KEPT_MARK);
    expect(back).toHaveAttribute('title', keptLockTitle('open'));
    fireEvent.pointerDown(back);
    expect(pulses).toBe(1);
  });
});

describe('GM r22 (4): the locked adds say their own verbs; the wire-drop popup is live', () => {
  it('the lines, verbatim, and where each is used', () => {
    expect(keptLockTitle('add-character')).toBe('You can add characters after you save it as a project.');
    expect(keptLockTitle('add-moodboard')).toBe('You can add moodboards after you save it as a project.');
    expect(keptLockTitle('test-character')).toBe('You can test characters after you save it as a project.');
    const read = (path: string) => readFileSync(resolve(__dirname, '../src/components', path), 'utf8');
    expect(read('panels/AssetsPanel.tsx')).toContain('keptAdd="add-character"');
    expect(read('panels/AssetsPanel.tsx')).toContain('keptAdd="add-moodboard"');
    expect(read('character-studio/CharacterTestPanel.tsx')).toContain("kept: 'test-character'");
    expect(read('ConnectionPopup.tsx')).toContain("kept: 'live'");
    expect(read('ConnectionPopup.tsx')).toMatch(/if \(\/\^n\\d\+\$\/\.test\(nodeId\) \|\| isCanvasKept\(\)\)/);
  });
});

describe('review 14 of PR #199, lock-order LOW-3: the lazy restore copy', () => {
  const real = restoreCopyNow();
  afterEach(() => { setRestoreCopyImportForTests(null); primeRestoreCopyForTests(real); });

  it('a failed load is tried again at the next focus or reconnect, and says it failed meanwhile', async () => {
    primeRestoreCopyForTests(null);
    let fail = true;
    setRestoreCopyImportForTests(() => (fail ? Promise.reject(new Error('chunk')) : Promise.resolve(real as RestoreCopy)));
    const { result } = renderHook(() => useRestoreCopyState(true));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.copy).toBeNull();
    fail = false;
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(result.current.copy).toBe(real));
    expect(result.current.failed).toBe(false);
  });

  it('the restore notice’s readable line while its copy is out: never a blank notice', () => {
    expect(RESTORE_COPY_FALLBACK).toBe('Nebula restored its project list.');
    const home = readFileSync(resolve(__dirname, '../src/components/projects/ProjectHome.tsx'), 'utf8');
    expect(home).toContain('{RESTORE_COPY_FALLBACK}');
    expect(home).toContain('copyFailed={copyFailed}');
  });
});

describe('GM r22 (2): the update line while kept shows under the kept line', () => {
  it('the store’s kept update line is on the canvas, and goes with kept mode', async () => {
    const { KEPT_UPDATE_LINE } = await import('../src/store/projectStore');
    useProjectStore.setState({ error: KEPT_UPDATE_LINE });
    const view = render(<KeptEditsNotice />);
    expect(document.querySelector('[data-kept-update]')).toHaveTextContent(KEPT_UPDATE_LINE);
    act(() => useProjectStore.setState({ error: 'Something else.' }));
    view.rerender(<KeptEditsNotice />);
    expect(document.querySelector('[data-kept-update]')).toBeNull();
  });
});
