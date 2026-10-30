import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pricingCases from '../../backend/tests/fixtures/pricing_cases.json';
import type { ModelNodeDefinition } from '../src/types';

/**
 * Fix round 2 of PR #200 (review 2 and GM's 2026-10-28 answers), the
 * component side:
 * - L-1: an Enter that ends an IME composition (Safari's keyCode 229, or
 *   isComposing) never sends the note; one shared helper (lib/imeComposing).
 * - L-4: Cinema's selected film-look chip and selected variation use the
 *   shared selected style (the category colour), never the accent; disabled,
 *   they and the checked Settings switch take the shared disabled look.
 * - L-5: the provider switcher's rows, the mask painter's Save and Run
 *   History's Forget take the canvas lock.
 * - L-6: EditNode's Open Editor opens the existing trim editor read-only
 *   while following or offline (finding the node, writing nothing).
 * - Nits: the bar's cut name stays whole graphemes and isolates its
 *   direction (<bdi>); the canvas pill grows to the left while it follows, so
 *   the Canvas and Creator Studio tabs stay put; Run History's Rerun and
 *   Retry say why they are disabled.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));

import { PromptDialog } from '../src/components/PromptDialog';
import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { EditNode } from '../src/components/nodes/EditNode';
import { ProviderSwitcher } from '../src/components/nodes/ProviderSwitcher';
import { MaskPainterModal } from '../src/components/panels/MaskPainterModal';
import { ForgetRecoveryConfirm } from '../src/components/panels/ForgetRecoveryConfirm';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { openingName } from '../src/lib/canvasFollow';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { usePricingStore } from '../src/store/pricingStore';
import type { PricingTable } from '../src/lib/pricing';
import type { RunRecord } from '../src/lib/runHistory';

const SRC = join(__dirname, '../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
const initialProject = useProjectStore.getState();
const initialGraph = useGraphStore.getState();
const initialUI = useUIStore.getState();
const WAIT = 'Wait for “beta” to open.';
const RECONNECT = 'This works again when Nebula reconnects.';
const follow = () => act(() => setFollowingSwitch({ projectName: 'beta', agent: 'Codex' }));
const offline = () => act(() => noteBackendConnection('offline'));
const at = (element: ReactElement) => render(element).container;
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')]
  .find((item) => item.textContent?.trim() === text) as HTMLButtonElement;

function cssRules(css: string): Array<{ selector: string; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

beforeEach(() => {
  resetCanvasFollowForTests();
  resetBackendConnectionForTests();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  act(() => { resetCanvasFollowForTests(); resetBackendConnectionForTests(); });
  useProjectStore.setState(initialProject, true);
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
  vi.restoreAllMocks();
});

// ── L-1: Safari's IME Enter ────────────────────────────────────────────────

describe('L-1: an Enter that ends an IME composition never sends the note', () => {
  const dialog = () => {
    const done = vi.fn();
    render(<PromptDialog request={{ label: 'Note for agents', initial: 'line one', resolve: () => {} }} onDone={done} multiline confirmLabel="Send note" />);
    return { done, field: screen.getByRole('textbox', { name: 'Note for agents' }) };
  };

  it('Safari: keyCode 229 with isComposing false (compositionend came first) is the input method\'s', () => {
    const { done, field } = dialog();
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    expect(done).not.toHaveBeenCalled();
  });

  it('during a composition (isComposing) it is the input method\'s too; a plain Enter still sends', () => {
    const { done, field } = dialog();
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    expect(done).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 });
    expect(done).toHaveBeenCalledWith('line one');
  });

  it('a one-line prompt never submits on the input method\'s Enter either', () => {
    const done = vi.fn();
    render(<PromptDialog request={{ label: 'Rename', initial: 'Hero', resolve: () => {} }} onDone={done} />);
    const field = screen.getByRole('textbox', { name: 'Rename' });
    const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(done).not.toHaveBeenCalled();
  });

  it('one helper: CommandPalette and PromptDialog both use lib/imeComposing', () => {
    expect(read('lib/imeComposing.ts')).toMatch(/export function composing\(/);
    for (const file of ['components/CommandPalette.tsx', 'components/PromptDialog.tsx']) {
      expect(read(file), file).toMatch(/from '\.\.\/lib\/imeComposing'/);
      expect(read(file), file).not.toMatch(/function composing\(/);
    }
  });
});

// ── L-2: the note's lines ───────────────────────────────────────────────────

describe('L-2: the pin card shows the lines the person wrote', () => {
  it('its text keeps line breaks (white-space: pre-line)', () => {
    const rule = cssRules(read('styles/canvasPins.css')).find(({ selector }) => selector === '.canvas-pin__text');
    expect(rule?.body).toMatch(/white-space:\s*pre-line/);
  });
});

// ── L-4: Cinema's selection, and the checked switch ─────────────────────────

describe('L-4: the selected chip and variation use the shared selected style; disabled, the shared grey', () => {
  const cinema = cssRules(read('styles/cinema-studio.css'));
  const shared = read('styles/disabled-buttons.css');

  it('selected: the category colour, never the accent', () => {
    for (const name of ['cinema-shared-controls__chip--active', 'cinema-shot-panel__variation--active']) {
      const rules = cinema.filter(({ selector }) => new RegExp(`\\.${name}(?![\\w-])`).test(selector));
      expect(rules.length, name).toBeGreaterThan(0);
      for (const { body } of rules) expect(body, name).not.toMatch(/--sr-accent|#ff5a1f/i);
      expect(rules.map(({ body }) => body).join(' '), name).toMatch(/--node-category-color/);
    }
  });

  it('the whole Cinema view carries the category colour (the shared controls and the shot panel sit outside the rail)', () => {
    expect(read('components/cinema-studio/CinemaStudioView.tsx')).toMatch(/className="cinema-studio-view"[^>]*style=\{\{[^}]*--node-category-color/);
  });

  // Fix round 3 (review 3 M-3): the variation, an image-only button, left the
  // unfilled rule for its own (its thumbnail dims; agentPresenceFollowups.r3).
  it('disabled: the chip is in the shared unfilled rule, the variation in the image rule; the checked switch turns the grey fill', () => {
    const unfilled = /:is\(([^)]*)\):is\(:disabled, \[aria-disabled='true'\]:not\(\[data-held-pending\]\)\),/.exec(shared)?.[1] ?? '';
    expect(unfilled).toMatch(/\.cinema-shared-controls__chip\b/);
    expect(shared).toMatch(/:is\(\.cinema-shot-panel__variation\):is\(:disabled, \[aria-disabled='true'\]\) img/);
    const switches = cssRules(shared).filter(({ selector }) => /\.settings-switch:checked/.test(selector) && /:disabled/.test(selector));
    expect(switches.length).toBeGreaterThan(0);
    expect(switches[0].body).toMatch(/background:\s*var\(--sr-disabled-fill[^;]*!important/);
  });
});

// ── L-5: the provider rows, the mask painter's Save, Forget ─────────────────

describe('L-5: controls the store gate refused silently now take the lock', () => {
  const fixture = pricingCases as unknown as { definitions: Record<string, ModelNodeDefinition>; pricing: PricingTable };
  const TABLE = fixture.definitions.table;
  beforeEach(() => {
    NODE_DEFINITIONS.table = TABLE;
    usePricingStore.setState({ table: fixture.pricing, loading: false });
    useUIStore.setState({ skin: 'slava-restraint' });
  });
  afterEach(() => {
    delete NODE_DEFINITIONS.table;
    usePricingStore.setState({ table: null, loading: false });
  });

  it('the provider switcher\'s rows: disabled, marked and GM\'s tooltip while following; a press picks nothing', () => {
    const onPick = vi.fn();
    render(<ProviderSwitcher definition={TABLE} params={{}} variant="inspector" onPick={onPick} />);
    const rows = screen.getAllByRole('menuitemradio');
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row).toBeEnabled();
    follow();
    for (const row of screen.getAllByRole('menuitemradio')) {
      expect(row).toBeDisabled();
      expect(row).toHaveAttribute('data-following-disabled');
      expect(row).toHaveAttribute('title', WAIT);
    }
    fireEvent.click(screen.getAllByRole('menuitemradio')[1]);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('offline, the rows say when they work again', () => {
    render(<ProviderSwitcher definition={TABLE} params={{}} variant="inspector" onPick={vi.fn()} />);
    offline();
    for (const row of screen.getAllByRole('menuitemradio')) {
      expect(row).toBeDisabled();
      expect(row).toHaveAttribute('data-offline-disabled');
      expect(row).toHaveAttribute('title', RECONNECT);
    }
  });

  it('the mask painter\'s Save Mask takes the lock', () => {
    render(<MaskPainterModal imageUrl={null} initialMask={null} onSave={vi.fn()} onClose={vi.fn()} />);
    follow();
    const save = screen.getByRole('button', { name: 'Save Mask' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('data-following-disabled');
    expect(save).toHaveAttribute('title', WAIT);
  });

  it('Run History\'s Forget confirm takes the lock while following, not only offline', () => {
    const onConfirm = vi.fn();
    render(<ForgetRecoveryConfirm name="“World”" onCancel={vi.fn()} onConfirm={onConfirm} />);
    follow();
    const forget = document.querySelector('.prompt-dialog__destructive') as HTMLButtonElement;
    expect(forget).toBeDisabled();
    expect(forget).toHaveAttribute('data-following-disabled');
    expect(forget).toHaveAttribute('title', WAIT);
  });
});

// ── N-7: Run History's Rerun and Retry say why ──────────────────────────────

describe('review N-7: Run History\'s disabled Rerun and Retry give the reason', () => {
  const record = (id: string, status: RunRecord['status']): RunRecord => ({ id, status, trigger: 'graph', startedAt: Date.now(),
    snapshot: { nodes: [{ id: 'n1', definitionId: 'text-input', params: {}, outputs: {} }], edges: [] } });
  beforeEach(() => {
    useGraphStore.setState({ runHistory: [record('failed-run', 'failed'), record('complete-run', 'complete')], isExecuting: false });
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
  });

  it('following: GM\'s tooltip', () => {
    render(<RunHistoryPanel />);
    follow();
    for (const name of ['Retry failed Full graph run', 'Rerun Full graph']) {
      const control = screen.getByRole('button', { name });
      expect(control, name).toBeDisabled();
      expect(control, name).toHaveAttribute('title', WAIT);
    }
  });

  // Fix round 3 (review 3 LOW-1, GM r4 answer 2): each says its own verb.
  it('offline: the reconnect tooltip with its verb; the panel itself stays open and live (review 2 check 2)', () => {
    render(<RunHistoryPanel />);
    offline();
    for (const [name, line] of [['Retry failed Full graph run', 'You can retry it when Nebula reconnects.'],
      ['Rerun Full graph', 'You can rerun it when Nebula reconnects.']]) {
      const control = screen.getByRole('button', { name });
      expect(control, name).toBeDisabled();
      expect(control, name).toHaveAttribute('title', line);
    }
    expect(screen.getAllByText(/Full graph/).length).toBeGreaterThan(0);
  });
});

// ── L-6: EditNode's Open Editor ─────────────────────────────────────────────

describe('L-6: EditNode\'s Open Editor opens the existing trim editor read-only while following or offline', () => {
  const props = { id: 'e1', data: { definitionId: 'video-edit', params: { clips: [] } }, selected: true } as never;
  beforeEach(() => {
    useGraphStore.setState({
      nodes: [
        { id: 'v1', type: 'model-node', position: { x: 0, y: 0 }, data: { label: 'Clip', definitionId: 'video-input', params: {}, state: 'idle', outputs: {} } },
        { id: 'e1', type: 'editNode', position: { x: 200, y: 0 }, data: { label: 'Edit', definitionId: 'video-edit', params: { clips: [] }, state: 'idle', outputs: {} } },
      ],
      edges: [{ id: 'x', source: 'v1', sourceHandle: 'video', target: 'e1', targetHandle: 'video_in' }],
    } as never);
  });

  for (const [state, enter] of [['following', follow], ['offline', offline]] as const) {
    it(`${state}: enabled; it opens this node's editor and writes nothing`, () => {
      const make = vi.spyOn(useGraphStore.getState(), 'getOrCreateEditNodeDownstream');
      const root = at(<ReactFlowProvider><EditNode {...(props as object)} /></ReactFlowProvider>);
      enter();
      const open = button(root, 'Open Editor');
      expect(open).toBeEnabled();
      expect(open).not.toHaveAttribute('data-following-disabled');
      expect(open).not.toHaveAttribute('data-offline-disabled');
      fireEvent.click(open);
      expect(useUIStore.getState().viewMode).toBe('editor');
      expect(useUIStore.getState().editorTargetNodeId).toBe('e1');
      expect(make).not.toHaveBeenCalled();
    });
  }

  it('the editor\'s own edits stay locked (its keys and clips refuse; the transport takes the lock)', () => {
    expect(read('components/editor/EditorView.tsx')).toMatch(/refuseCanvasEdit\(\)/);
    expect(read('components/editor/TimelineClip.tsx')).toMatch(/refuseCanvasEdit\(\)/);
    expect(read('components/editor/EditorTransport.tsx')).toMatch(/useCanvasLock\(\)/);
  });
});

// ── Nits: the agent bar ─────────────────────────────────────────────────────

describe('review N-1, N-2, N-3: the agent bar', () => {
  beforeEach(() => {
    useProjectStore.setState({ screen: 'workspace', saveStatus: 'saved', busy: false,
      activeProject: { id: 'followups', name: 'Followups', createdAt: '', updatedAt: '', lastOpenedAt: null,
        nodeCount: 2, edgeCount: 0, thumbnail: null } } as never);
  });

  it('N-2: a cut name ends on a whole grapheme (Intl.Segmenter), never a dangling joiner', () => {
    const name = `${'x'.repeat(21)}👩🏽‍🎨👩🏽‍🎨👩🏽‍🎨🙂`;
    const shown = openingName(name);
    expect(shown.endsWith('…')).toBe(true);
    const body = shown.slice(0, -1);
    expect(body).toBe(`${'x'.repeat(21)}👩🏽‍🎨👩🏽‍🎨`);
    // 24 graphemes stay whole, though they are more code points.
    const whole = `${'x'.repeat(20)}👩🏽‍🎨👩🏽‍🎨👩🏽‍🎨🙂`;
    expect(openingName(whole)).toBe(whole);
  });

  it('N-1: the name isolates its own direction, with "…" inside it (RTL names cut at their logical end)', () => {
    const { container } = render(<ProjectWorkspaceControls />);
    act(() => setFollowingSwitch({ projectName: 'מסע ארוך מאוד אל מעבר להרים הרחוקים', agent: 'Codex' }));
    const name = container.querySelector('.project-workspace-controls__opening-name') as HTMLElement;
    expect(name.tagName).toBe('BDI');
    expect(name.textContent?.endsWith('…')).toBe(true);
  });

  it('N-3: the canvas pill grows to the left while it follows, so the tabs after it stay put', () => {
    const wrap = document.createElement('div');
    wrap.className = 'canvas-tabs-wrap';
    document.body.append(wrap);
    const { container } = render(<ProjectWorkspaceControls />, { container: wrap });
    const bar = container.querySelector('.project-workspace-controls') as HTMLElement;
    let width = 160;
    bar.getBoundingClientRect = () => ({ width, height: 30, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 30, toJSON: () => ({}) });
    act(() => setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }));
    width = 222;
    act(() => setFollowingSwitch({ projectName: 'Second canvas!', agent: 'Codex' }));
    expect(wrap.style.getPropertyValue('--follow-grow')).toBe('62px');
    const css = read('components/CanvasTabs.css');
    expect(css).toMatch(/\.canvas-tabs-wrap\s*\{[^}]*transform:\s*translateX\(calc\(-50%\s*-\s*var\(--follow-grow,\s*0px\)\s*\/\s*2\)\)/);
    act(() => setFollowingSwitch(null));
    expect(wrap.style.getPropertyValue('--follow-grow')).toBe('');
  });
});
