import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import type { Node } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeData } from '../src/types';

/**
 * Fix round 3 of PR #200 (review 3 and GM's round 3 answers), the component
 * side, from review 3's live findings:
 * - M-2: the kept notes stack, one per project, newest at the bottom, each
 *   with its own Copy note and ×; on another project each names its own.
 * - M-3 and LOW-5: Cinema's variation images (image-only buttons) dim their
 *   thumbnail when disabled, and the selected one, like the selected film-look
 *   chip, keeps its outline in the shared grey (GM: "That's the disabled look
 *   for image-only buttons everywhere").
 * - LOW-1: Run history's Rerun, Retry and Recover say their own verb offline.
 * - LOW-3: a follow that starts while the mask painter is open: the project
 *   bar sits above the painter's scrim (GM: "the bar goes on top, same as the
 *   other editors"), and the painter's tools and strokes lock.
 * - LOW-4: the read-only trim editor locks Render Preview and Export….
 * - LOW-5: the pin card is bounded and scrolls.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/hooks/useRenderJob', () => ({
  useRenderJob: () => ({ job: null, error: null, begin: vi.fn(), cancel: vi.fn(), reset: vi.fn() }),
}));

import { PinComposer } from '../src/components/canvas/PinComposer';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { MaskPainterModal } from '../src/components/panels/MaskPainterModal';
import { EditorTransport } from '../src/components/editor/EditorTransport';
import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useProjectStore } from '../src/store/projectStore';
import { noteKeptLine, type KeptNote } from '../src/lib/canvasPins';
import { offlineDisabledReason, OFFLINE_RECOVER, OFFLINE_RERUN, OFFLINE_RETRY } from '../src/lib/errorCopy';
import { publishOpenProject } from '../src/lib/currentProject';
import { setProjectContext } from '../src/lib/projectContext';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import type { RunRecord } from '../src/lib/runHistory';

const SRC = join(__dirname, '../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
const initialGraph = useGraphStore.getState();
const initialUI = useUIStore.getState();
const initialProject = useProjectStore.getState();
const WAIT = 'Wait for “beta” to open.';
const RECONNECT = 'This works again when Nebula reconnects.';
const follow = () => act(() => setFollowingSwitch({ projectName: 'beta', agent: 'Codex' }));
const offline = () => act(() => noteBackendConnection('offline'));
const at = (element: ReactElement) => render(element).container;

function cssRules(css: string): Array<{ selector: string; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }));
}

beforeEach(() => {
  resetCanvasFollowForTests();
  resetBackendConnectionForTests();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  act(() => { resetCanvasFollowForTests(); resetBackendConnectionForTests(); });
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProject, true);
  useCanvasPinsStore.setState({ composer: null, composerCanvas: null, draft: '', drafts: {}, kept: [], error: null, errorProject: null } as never);
  publishOpenProject(null);
  setProjectContext(null);
  vi.restoreAllMocks();
});

// ── M-2: the kept notes stack ───────────────────────────────────────────────

describe('M-2: kept notes stack, one per project, each with its own Copy note and ×', () => {
  const reason = { agent: 'Codex', projectName: 'Second canvas' };
  const note = (project: string, projectName: string, text: string, why = reason): KeptNote =>
    ({ text, project, projectName, following: why, line: noteKeptLine(why) });

  it('on a third project both show, oldest first, each naming its project; × drops only its own', () => {
    setProjectContext({ id: 'gamma', revision: 'rev-c' });
    publishOpenProject({ id: 'gamma', name: 'Third canvas' });
    useCanvasPinsStore.setState({ kept: [note('alpha', 'Alpha', 'A note'),
      note('beta', 'Second canvas', 'B note', { agent: 'Codex', projectName: 'Third canvas' })] } as never);
    render(<PinComposer />);
    const notices = screen.getAllByRole('status');
    expect(notices.map((item) => item.textContent?.replace(/Copy note×$/, ''))).toEqual([
      'Your note for “Alpha” wasn’t sent because Codex started opening “Second canvas”.A note',
      'Your note for “Second canvas” wasn’t sent because Codex started opening “Third canvas”.B note',
    ]);
    for (const item of notices) {
      expect(within(item).getByRole('button', { name: 'Copy note' })).toBeTruthy();
      expect(within(item).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    }
    const write = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText: write } });
    fireEvent.click(within(notices[1]).getByRole('button', { name: 'Copy note' }));
    expect(write).toHaveBeenCalledWith('B note');
    fireEvent.click(within(notices[0]).getByRole('button', { name: 'Dismiss' }));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('B note');
  });

  it('on its own project the line stays as it is', () => {
    setProjectContext({ id: 'alpha', revision: 'rev-a' });
    publishOpenProject({ id: 'alpha', name: 'Alpha' });
    useCanvasPinsStore.setState({ kept: [note('alpha', 'Alpha', 'A note')] } as never);
    render(<PinComposer />);
    expect(screen.getByRole('status').textContent).toContain('Your note wasn’t sent because Codex started opening “Second canvas”.');
  });

  it('N-3: a failed send\'s error shows on its own project only', () => {
    setProjectContext({ id: 'beta', revision: 'rev-b' });
    publishOpenProject({ id: 'beta', name: 'Second canvas' });
    useCanvasPinsStore.setState({ error: "Couldn't save the note. Nebula didn't respond.", errorProject: 'alpha' } as never);
    render(<PinComposer />);
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    setProjectContext({ id: 'alpha', revision: 'rev-a' });
    publishOpenProject({ id: 'alpha', name: 'Alpha' });
    render(<PinComposer />);
    expect(screen.getByRole('status').textContent).toContain("Couldn't save the note. Nebula didn't respond.");
  });
});

// ── M-3 and LOW-5: image-only buttons and the selected chip, disabled ──────

describe('M-3: an image-only button dims its thumbnail disabled; the selected one keeps a grey outline', () => {
  const shared = cssRules(read('styles/disabled-buttons.css'));
  const imageRule = shared.find(({ selector }) => /\.cinema-shot-panel__variation/.test(selector) && /:disabled/.test(selector) && /\bimg\b/.test(selector));
  const selectedRules = shared.filter(({ selector }) => /:disabled/.test(selector) && /--active|aria-pressed/.test(selector));

  it('the thumbnail: dimmed and greyscale, as strong as the shared grey', () => {
    expect(imageRule, 'a disabled image rule for the variation').toBeDefined();
    const opacity = Number(/opacity:\s*([\d.]+)/.exec(imageRule!.body)?.[1]);
    // The shared grey is white at 0.55: the thumbnail at most that strong.
    expect(opacity).toBeLessThanOrEqual(0.55);
    expect(opacity).toBeGreaterThan(0.2);
    expect(imageRule!.body).toMatch(/filter:\s*grayscale\(1\)/);
  });

  it('the selected variation and the selected film-look chip keep their outline, in the shared grey', () => {
    for (const name of ['cinema-shot-panel__variation--active', 'cinema-shared-controls__chip--active']) {
      const rule = selectedRules.find(({ selector }) => selector.includes(name));
      expect(rule, name).toBeDefined();
      expect(rule!.body, name).toMatch(/border-color:\s*var\(--sr-disabled-ink[^;]*!important/);
      expect(rule!.body, name).toMatch(/box-shadow:[^;]*var\(--sr-disabled-ink[^;]*!important/);
    }
  });

  it('the variation is no ghost button any more (that rule dropped its selected outline)', () => {
    const unfilled = /:is\(([^)]*)\):is\(:disabled, \[aria-disabled='true'\]:not\(\[data-held-pending\]\)\),/.exec(read('styles/disabled-buttons.css'))?.[1] ?? '';
    expect(unfilled).not.toMatch(/\.cinema-shot-panel__variation\b/);
  });
});

// ── LOW-1: Run history's verbs ─────────────────────────────────────────────

describe('LOW-1: Run history\'s Rerun, Retry and Recover say their verb offline', () => {
  const record = (id: string, status: RunRecord['status']): RunRecord => ({ id, status, trigger: 'graph', startedAt: Date.now(),
    snapshot: { nodes: [{ id: 'n1', definitionId: 'text-input', params: {}, outputs: {} }], edges: [] } });

  it('the constants are GM\'s lines', () => {
    expect(offlineDisabledReason(OFFLINE_RERUN)).toBe('You can rerun it when Nebula reconnects.');
    expect(offlineDisabledReason(OFFLINE_RETRY)).toBe('You can retry it when Nebula reconnects.');
    expect(offlineDisabledReason(OFFLINE_RECOVER)).toBe('You can recover it when Nebula reconnects.');
  });

  it('offline: Rerun and Retry give their own line; following, GM\'s wait line', () => {
    useGraphStore.setState({ runHistory: [record('failed-run', 'failed'), record('complete-run', 'complete')], isExecuting: false });
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
    render(<RunHistoryPanel />);
    offline();
    expect(screen.getByRole('button', { name: 'Rerun Full graph' })).toHaveAttribute('title', 'You can rerun it when Nebula reconnects.');
    expect(screen.getByRole('button', { name: 'Retry failed Full graph run' })).toHaveAttribute('title', 'You can retry it when Nebula reconnects.');
    act(() => resetBackendConnectionForTests());
    follow();
    expect(screen.getByRole('button', { name: 'Rerun Full graph' })).toHaveAttribute('title', WAIT);
  });

  it('Recover uses its own line (RunHistoryPanel picks it for a recovery replay)', () => {
    const source = read('components/panels/RunHistoryPanel.tsx');
    expect(source).toMatch(/recoveryReplayReady\s*\?\s*OFFLINE_RECOVER/);
    expect(source).not.toMatch(/run-history__replay"[\s\S]{0,200}offline: true/);
  });
});

// ── LOW-3: the mask painter during a follow ────────────────────────────────

describe('LOW-3: the mask painter while following', () => {
  it('the project bar sits above the painter\'s scrim while following (the wrap is marked, and raised over 1000)', () => {
    useProjectStore.setState({ screen: 'workspace', saveStatus: 'saved', busy: false,
      activeProject: { id: 'a', name: 'Followups', createdAt: '', updatedAt: '', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null } } as never);
    const wrap = document.createElement('div');
    wrap.className = 'canvas-tabs-wrap';
    document.body.append(wrap);
    render(<ProjectWorkspaceControls />, { container: wrap });
    expect(wrap).not.toHaveAttribute('data-following');
    follow();
    expect(wrap).toHaveAttribute('data-following');
    const raised = cssRules(read('components/CanvasTabs.css')).find(({ selector }) => selector === '.canvas-tabs-wrap[data-following]');
    const painter = Number(/z-index:\s*(\d+)/.exec(cssRules(read('styles/mask-painter.css')).find(({ selector }) => selector === '.mask-painter__overlay')!.body)?.[1]);
    expect(Number(/z-index:\s*(\d+)/.exec(raised?.body ?? '')?.[1])).toBeGreaterThan(painter);
    act(() => setFollowingSwitch(null));
    expect(wrap).not.toHaveAttribute('data-following');
  });

  // Live (fix round 3): the skin's `body.app-slava-restraint .canvas-tabs-wrap`
  // (z-index: var(--sr-layer-panel)) outranked the plain [data-following]
  // rule, and the painter's scrim still covered the bar. Every rule that sets
  // the wrap's z-index has a [data-following] twin, as specific, above it.
  it('every rule that layers the wrap has a [data-following] twin over the painter', () => {
    const painter = Number(/z-index:\s*(\d+)/.exec(cssRules(read('styles/mask-painter.css')).find(({ selector }) => selector === '.mask-painter__overlay')!.body)?.[1]);
    const rules = (readdirSync(SRC, { recursive: true }) as string[]).filter((file) => file.endsWith('.css'))
      .flatMap((file) => cssRules(read(file)).flatMap(({ selector, body }) => selector.split(',').map((one) => ({ one: one.trim(), body }))));
    const layering = rules.filter(({ one, body }) => one.endsWith('.canvas-tabs-wrap') && /z-index\s*:/.test(body)).map(({ one }) => one);
    expect(layering.length).toBeGreaterThanOrEqual(2);
    for (const one of layering) {
      const twin = rules.find((rule) => rule.one === `${one}[data-following]`);
      expect(twin, one).toBeDefined();
      expect(Number(/z-index:\s*(\d+)/.exec(twin!.body)?.[1]), one).toBeGreaterThan(painter);
    }
  });

  it('its tools lock (Brush, Erase, Size, Clear, Save) with GM\'s tooltip; Cancel and Close stay', () => {
    render(<MaskPainterModal imageUrl={null} initialMask={null} onSave={vi.fn()} onClose={vi.fn()} />);
    follow();
    for (const name of [/Brush/, /Erase/, /Clear/, /Save Mask/]) {
      const control = screen.getByRole('button', { name });
      expect(control, String(name)).toBeDisabled();
      expect(control, String(name)).toHaveAttribute('title', WAIT);
    }
    expect(screen.getByRole('slider')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });

  it('offline the same, with the reconnect line', () => {
    render(<MaskPainterModal imageUrl={null} initialMask={null} onSave={vi.fn()} onClose={vi.fn()} />);
    offline();
    expect(screen.getByRole('button', { name: /Clear/ })).toHaveAttribute('title', RECONNECT);
    expect(screen.getByRole('button', { name: /Brush/ })).toBeDisabled();
  });
});

// ── LOW-4: the read-only trim editor ───────────────────────────────────────

describe('LOW-4: the read-only trim editor locks Render Preview and Export…', () => {
  const mount = () => {
    const clip = { id: 'c1', start: 0, duration: 2, sourceIn: 0, sourceOut: 2, volume: 1, mute: false };
    const node: Node<NodeData> = { id: 'e1', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Edit', definitionId: 'video-edit', params: { clips: [clip], sourceFps: 30 }, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node] });
    return at(<EditorTransport editNode={node} sourceUrl="/api/outputs/a.mp4" />);
  };
  const find = (root: HTMLElement, cls: string) => root.querySelector(`.${cls}`) as HTMLButtonElement;

  for (const [state, enter, title] of [['following', follow, WAIT], ['offline', offline, RECONNECT]] as const) {
    it(`${state}: both disabled with ${state === 'following' ? 'the follow' : 'the reconnect'} tooltip`, () => {
      const root = mount();
      expect(find(root, 'editor-transport__btn--render')).toBeEnabled();
      expect(find(root, 'editor-transport__btn--export')).toBeEnabled();
      enter();
      for (const cls of ['editor-transport__btn--render', 'editor-transport__btn--export']) {
        expect(find(root, cls), cls).toBeDisabled();
        expect(find(root, cls), cls).toHaveAttribute('title', title);
      }
    });
  }
});

// ── LOW-5: the pin card ────────────────────────────────────────────────────

describe('LOW-5: a tall note scrolls inside a bounded card', () => {
  it('the note text has a max height and scrolls; the card takes no canvas wheel', () => {
    const rule = cssRules(read('styles/canvasPins.css')).find(({ selector }) => selector === '.canvas-pin__text');
    expect(rule?.body).toMatch(/max-height:/);
    expect(rule?.body).toMatch(/overflow-y:\s*auto/);
    expect(read('components/canvas/PinLayer.tsx')).toMatch(/className="canvas-pin__card nowheel"/);
  });
});
