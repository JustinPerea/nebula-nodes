import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { ReactNode } from 'react';
import type { ProposalView } from '../src/lib/wsClient';

/**
 * GM - Design, 2026-10-23:
 * 2. "Yes, move the proposal bar into the region, stacked above the notices.
 *    Accept / Reject are decisions and must never sit under a panel. The order
 *    from the bottom up is notices, then the proposal bar."
 * 3. "Yes, all three toasts join the region. One region, one stack, and
 *    nothing else draws toasts."
 *
 * Every item renders where its own state lives and portals into its slot in
 * the region's one stack, so it keeps its role, buttons, timers and hold.
 */

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async () => new Response('{}', { status: 200 }),
  backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}`,
}));

import { NoticeRegion } from '../src/components/NoticeRegion';
import { ProposalBar } from '../src/components/canvas/ProposalBar';
import { PinComposer } from '../src/components/canvas/PinComposer';
import { UndoDeleteToast } from '../src/components/asset-trash/AssetTrash';
import { BoardUndoToast } from '../src/components/moodboard-studio/BoardUndoToast';
import { ProjectSwitchToast } from '../src/components/projects/ProjectSwitchToast';
import { ProjectHome } from '../src/components/projects/ProjectHome';
import { PersonRequiredBanner } from '../src/components/PersonRequiredBanner';
import { reportPersonRequired } from '../src/lib/personSession';
import { isCanvasShortcutTarget } from '../src/lib/canvasShortcutScope';
import { isStudioShortcutTarget } from '../src/components/moodboard-studio/studioKeys';
import { useGraphStore } from '../src/store/graphStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { useProjectStore } from '../src/store/projectStore';
import { useUIStore } from '../src/store/uiStore';

const LAZY = { timeout: 10_000 };
const SLOW = 20_000;
const SRC = join(__dirname, '../src');

const initialGraph = useGraphStore.getState();
const initialProposals = useCanvasProposalsStore.getState();
const initialPins = useCanvasPinsStore.getState();
const initialProjects = useProjectStore.getState();
const initialUI = useUIStore.getState();

beforeEach(() => {
  useGraphStore.setState({ undoNotice: null, undoStack: [], redoStack: [] });
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
});
afterEach(() => {
  cleanup();
  useGraphStore.setState(initialGraph, true);
  useCanvasProposalsStore.setState(initialProposals, true);
  useCanvasPinsStore.setState(initialPins, true);
  useProjectStore.setState(initialProjects, true);
  useUIStore.setState(initialUI, true);
});

function proposal(id: string): ProposalView {
  return {
    id, status: 'open', agent: { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true },
    note: 'Add a text node', projectId: 'p', createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    nodes: [{ ref: '+t', definitionId: 'text-input', name: 'Text Input', category: 'text', params: {},
      position: { x: 400, y: 0 }, cost: { kind: 'free', provider: null, label: 'free' },
      runs: false, willRun: false, ports: { inputs: [], outputs: [] } }],
    edges: [], params: [], run: [],
    cost: { paidRuns: 0, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [], note: '' },
    references: [], reason: null, idMap: null, runNodeIds: null,
  } as unknown as ProposalView;
}

/** The one region, with what each screen mounts beside it. */
function withRegion(screenName: 'canvas' | 'studio' | 'home', children: ReactNode) {
  return render(
    <ReactFlowProvider>
      {children}
      <NoticeRegion screen={screenName} />
    </ReactFlowProvider>,
  );
}

function inRegion(element: Element) {
  const region = element.closest('[data-notice-region]');
  expect(region, 'renders in the app\'s one notice region').not.toBeNull();
  expect(document.querySelectorAll('[data-notice-region]')).toHaveLength(1);
  return region!;
}

/** Which slot an item sits in. */
const slotOf = (element: Element) => element.closest<HTMLElement>('[data-notice-slot]')?.dataset.noticeSlot;

/** True when `a` is drawn above `b` in the stack (earlier in the column). */
const above = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the proposal bar in the region (GM 2)', () => {
  it('stacks above the notices, in the same region, with no panel of its own', async () => {
    useCanvasProposalsStore.getState().open(proposal('p1'), 'key-a');
    useGraphStore.getState().notify('Imported. One note.', 'info');
    withRegion('canvas', <ProposalBar />);
    const bar = await screen.findByRole('region', { name: 'Proposal from Codex' }, LAZY);
    const notice = await screen.findByText('Imported. One note.', {}, LAZY);
    expect(inRegion(bar)).toBe(inRegion(notice));
    expect(slotOf(bar)).toBe('proposal');
    expect(above(bar, notice)).toBe(true);
    expect(bar.closest('.react-flow__panel, .proposal-bar-panel')).toBeNull();
    // Accept and Reject are in it, and its agent colour comes with it.
    expect(bar.querySelector('button')).not.toBeNull();
    expect(bar.style.getPropertyValue('--agent-color')).toBe('#5B9DFF');
  }, SLOW);

  it('its run-later notice sits right under it, above the canvas notice', async () => {
    useCanvasProposalsStore.getState().open(proposal('p1'), 'key-a');
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n7'] } as never });
    useGraphStore.getState().notify('Imported. One note.', 'info');
    withRegion('canvas', <ProposalBar />);
    const bar = await screen.findByRole('region', { name: 'Proposal from Codex' }, LAZY);
    const later = (await screen.findByText(/Run them when the current run finishes/, {}, LAZY)).closest('.proposal-bar')!;
    const notice = await screen.findByText('Imported. One note.', {}, LAZY);
    expect(above(bar, later)).toBe(true);
    expect(above(later, notice)).toBe(true);
  }, SLOW);
});

describe('every toast joins the region (GM 3)', () => {
  it('the canvas pin error toast', async () => {
    useCanvasPinsStore.setState({ error: "Couldn't save the note.", composer: null });
    withRegion('canvas', <PinComposer />);
    const toast = screen.getByRole('alert');
    expect(toast).toHaveClass('canvas-pin-toast');
    inRegion(toast);
    expect(slotOf(toast)).toBe('pin');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('the asset trash toast', () => {
    withRegion('canvas', <UndoDeleteToast name="Warm editorial" onUndo={() => {}} onDismiss={() => {}} />);
    const toast = screen.getByText(/Moved “Warm editorial” to Recently deleted/).closest('.asset-trash__toast')!;
    inRegion(toast);
    expect(slotOf(toast)).toBe('asset-trash');
    expect(toast).toHaveAttribute('role', 'status');
  });

  // One toast now for the Board and the List view (it took `inWindow` to sit
  // at the window's foot in the List view; the region places it in both).
  it('the moodboard toast, on the board and in the List view (the window toast)', () => {
    const toast = { id: 1, text: 'Removed #1', action: { label: 'Undo' as const, run: () => {} } };
    withRegion('studio', <>
      <BoardUndoToast toast={toast} onDismiss={() => {}} />
      <BoardUndoToast toast={{ ...toast, id: 2, text: 'Removed #2' }} onDismiss={() => {}} />
    </>);
    for (const text of ['Removed #1', 'Removed #2']) {
      const root = screen.getByText(text).closest('.moodboard-board-toast')!;
      inRegion(root);
      expect(slotOf(root)).toBe('board');
    }
  });

  it('the project-switch toast', () => {
    useProjectStore.setState({ switchNotice: { actorName: 'Claude Code', created: false, projectName: 'Beta',
      previousProjectId: 'alpha', previousProjectName: 'Alpha', keptCopy: false } as never });
    withRegion('canvas', <ProjectSwitchToast />);
    const toast = screen.getByText('Claude Code opened “Beta”.').closest('.project-switch-toast')!;
    inRegion(toast);
    expect(slotOf(toast)).toBe('project-switch');
  });

  it("the Projects screen's Undo toast, with a region on Projects too", () => {
    withRegion('home', <ProjectHome projects={[]} loading={false} busy={false} error={null}
      onCreate={() => {}} onOpen={() => {}} onRename={() => {}} onDelete={() => {}} onRetry={() => {}}
      onRestore={() => {}} onPurge={() => {}} onEmptyTrash={() => {}} onDismissUndo={() => {}}
      lastDeleted={{ id: 'glass', name: 'Glass campaign' }} />);
    const toast = screen.getByText(/Moved “Glass campaign” to Recently deleted/).closest('.project-home__toast')!;
    inRegion(toast);
    expect(slotOf(toast)).toBe('project-home');
  });

  it('the person-required line', () => {
    withRegion('canvas', <PersonRequiredBanner />);
    act(() => reportPersonRequired());
    const line = document.querySelector('.person-required')!;
    expect(line).not.toBeNull();
    inRegion(line);
    expect(slotOf(line)).toBe('person-required');
  });

  it('one order, bottom up: the canvas notice, the toasts, the run-later notice, the proposal bar', async () => {
    useCanvasProposalsStore.getState().open(proposal('p1'), 'key-a');
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n7'] } as never });
    useCanvasPinsStore.setState({ error: "Couldn't save the note.", composer: null });
    useProjectStore.setState({ switchNotice: { actorName: 'Claude Code', created: false, projectName: 'Beta',
      previousProjectId: 'alpha', previousProjectName: 'Alpha', keptCopy: false } as never });
    useGraphStore.getState().notify('Imported. One note.', 'info');
    withRegion('canvas', <>
      <ProposalBar />
      <PinComposer />
      <UndoDeleteToast name="Warm editorial" onUndo={() => {}} onDismiss={() => {}} />
      <ProjectSwitchToast />
      <PersonRequiredBanner />
    </>);
    act(() => reportPersonRequired());
    await screen.findByRole('region', { name: 'Proposal from Codex' }, LAZY);
    await screen.findByText('Imported. One note.', {}, LAZY);
    await screen.findByText(/Run them when the current run finishes/, {}, LAZY);
    const shown = [...document.querySelectorAll<HTMLElement>('[data-notice-slot]')]
      .filter((slot) => slot.childElementCount > 0)
      .map((slot) => slot.dataset.noticeSlot);
    // Top down, as the column draws them.
    expect(shown).toEqual(['proposal', 'run-later', 'person-required', 'project-switch', 'pin', 'asset-trash', 'notice']);
  }, SLOW);
});

/** Every file under src with this extension. */
function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return path.endsWith(ext) && !/\.test\./.test(path) ? [path] : [];
  });
}

/** Each CSS rule as [selector, body]. */
function rules(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let match = pattern.exec(bare); match; match = pattern.exec(bare)) {
    out.push([match[1].trim(), match[2]]);
  }
  return out;
}

// The items left their screens' trees for the region (a portal keeps React's
// tree, not the DOM's), and the screens' keys listen on the document and check
// the DOM. Focus on the bar or a toast's button keeps the screen's keys.
describe('focus in the region leaves the screen its keys', () => {
  it('the canvas: the proposal bar, its buttons and the pin toast\'s Dismiss', async () => {
    useCanvasProposalsStore.getState().open(proposal('p1'), 'key-a');
    useCanvasPinsStore.setState({ error: "Couldn't save the note.", composer: null });
    withRegion('canvas', <><ProposalBar /><PinComposer /></>);
    const bar = await screen.findByRole('region', { name: 'Proposal from Codex' }, LAZY);
    expect(bar.closest('.canvas-wrapper')).toBeNull();
    expect(isCanvasShortcutTarget(bar)).toBe(true);
    for (const button of bar.querySelectorAll('button')) expect(isCanvasShortcutTarget(button)).toBe(true);
    const pin = screen.getByRole('alert');
    expect(isCanvasShortcutTarget(within(pin).getByRole('button', { name: 'Dismiss' }))).toBe(true);
  }, SLOW);

  it('Moodboard Studio: the board toast and the asset trash toast, not other screens\' lines', () => {
    const toast = { id: 1, text: 'Removed #1', action: { label: 'Undo' as const, run: () => {} } };
    withRegion('studio', <>
      <div className="moodboard-studio-view" />
      <BoardUndoToast toast={toast} onDismiss={() => {}} />
      <UndoDeleteToast name="Warm editorial" busy onUndo={() => {}} onDismiss={() => {}} />
      <PersonRequiredBanner />
    </>);
    act(() => reportPersonRequired());
    const board = screen.getByText('Removed #1').closest('.moodboard-board-toast')!;
    const trash = screen.getByText(/Moved “Warm editorial”/).closest('.asset-trash__toast')!;
    const buttons = [...board.querySelectorAll('button'), ...trash.querySelectorAll('button')];
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      for (const action of ['undo', 'redo', 'save'] as const) {
        expect(isStudioShortcutTarget(button, action), `${button.textContent || button.getAttribute('aria-label')} ${action}`).toBe(true);
      }
    }
    // Another screen's line in the region doesn't pick up the Studio's keys.
    const line = document.querySelector('[data-notice-slot="person-required"] .person-required');
    expect(line).not.toBeNull();
    expect(isStudioShortcutTarget(line, 'undo')).toBe(false);
  });
});

describe('nothing outside the region draws a toast (GM 3)', () => {
  /** The class on each toast's root (a class that ends in "toast"), and who renders it. */
  function toastRoots(): Map<string, string[]> {
    const roots = new Map<string, string[]>();
    for (const file of files(SRC, '.tsx')) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/className=[{"'`][^"'`}]*?\b([\w-]*toast)(?![\w-])/g)) {
        const list = roots.get(match[1]) ?? [];
        if (!list.includes(file)) list.push(file);
        roots.set(match[1], list);
      }
    }
    return roots;
  }

  it('lists every toast root, and each renders through the region', () => {
    const roots = toastRoots();
    expect([...roots.keys()].sort()).toEqual([
      'asset-trash__toast', 'canvas-pin-toast', 'moodboard-board-toast', 'project-home__toast', 'project-switch-toast',
    ]);
    for (const [root, sources] of roots) {
      for (const file of sources) {
        expect(readFileSync(file, 'utf8'), `${relative(SRC, file)} renders .${root} through InNoticeRegion`)
          .toMatch(/<InNoticeRegion\b/);
      }
    }
    expect(readFileSync(join(SRC, 'components/PersonRequiredBanner.tsx'), 'utf8')).toMatch(/<InNoticeRegion\b/);
    expect(readFileSync(join(SRC, 'components/canvas/ProposalBar.tsx'), 'utf8')).toMatch(/<InNoticeRegion\b/);
  });

  it('no stylesheet places a toast itself: no fixed or absolute toast, nor the person-required line', () => {
    const offenders: string[] = [];
    for (const file of [...files(SRC, '.css')]) {
      for (const [selector, body] of rules(readFileSync(file, 'utf8'))) {
        if (!/toast\b|\.person-required\b(?![-_])/.test(selector)) continue;
        if (/position:\s*(fixed|absolute)/.test(body)) offenders.push(`${relative(SRC, file)}: ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the proposal bar keeps no spacing of its own over the notices: --notice-stack-h is gone', () => {
    const uses = [...files(SRC, '.css'), ...files(SRC, '.tsx'), ...files(SRC, '.ts')]
      .filter((file) => readFileSync(file, 'utf8').includes('--notice-stack-h'))
      .map((file) => relative(SRC, file));
    expect(uses).toEqual([]);
  });
});
