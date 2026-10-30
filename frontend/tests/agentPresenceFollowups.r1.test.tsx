import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider, type Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CinemaSceneSpec, NodeData } from '../src/types';

/**
 * Fix round 1 of PR #200 (GM's visual review 1 and review 1 of the PR).
 * - GM bug 1: the project bar shows "Opening “Second canvas”…" whole and
 *   grows to fit; only a name past 24 characters is cut.
 * - GM bug 2 / review L-1: the note dialog is a textarea that grows, starts
 *   with the caret at the end and nothing selected, its OK reads "Send note",
 *   and text selection is never the accent.
 * - GM bug 3: with a failed reference, Generate shot and Generate 2 are both
 *   disabled, with the same reason as their tooltip and one line under them.
 * - GM answer 1: offline, Cinema's controls are locked and say when they
 *   work again (errorCopy offlineDisabledReason).
 * - GM answer 6 / review L-2, L-3: one disabled colour treatment.
 * - GM note: the selected shot card uses the shared selected style.
 * - GM answers 3/4 and review L-6: repeated names grouped, in canvas order.
 * - Review L-5: EditNode's Open Editor takes the lock.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  getCachedBackendBaseUrl: () => null,
}));

import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { PromptDialog } from '../src/components/PromptDialog';
import { PinComposer } from '../src/components/canvas/PinComposer';
import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { CinemaShotsRail } from '../src/components/cinema-studio/CinemaShotsRail';
import { CinemaStudioToolbar } from '../src/components/cinema-studio/CinemaStudioToolbar';
import { EditNode } from '../src/components/nodes/EditNode';
import { offlineDisabledReason, nodeNameList } from '../src/lib/errorCopy';
import { changesNotSavedLine } from '../src/lib/savingCutOff';
import { movedNodesLine, type PlaceholderRunRow } from '../src/lib/placeholderRunConfirm';
import { noteKeptLine, NOTE_KEPT_LINE } from '../src/lib/canvasPins';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { useCinemaUploadStore } from '../src/store/cinemaUploadStore';

const SRC = join(__dirname, '../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
const initialProject = useProjectStore.getState();
const initialGraph = useGraphStore.getState();
const initialUI = useUIStore.getState();

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
  useCinemaUploadStore.setState({ uploads: [] });
  useCanvasPinsStore.setState({ composer: null, composerCanvas: null, draft: '', drafts: {}, kept: [], error: null } as never);
});

// ── GM bug 1: the agent bar ─────────────────────────────────────────────────

describe('GM bug 1: the project bar names the project being opened in full', () => {
  beforeEach(() => {
    useProjectStore.setState({ screen: 'workspace', saveStatus: 'saved', busy: false,
      activeProject: { id: 'followups', name: 'Followups', createdAt: '', updatedAt: '', lastOpenedAt: null,
        nodeCount: 2, edgeCount: 0, thumbnail: null } } as never);
  });

  it('"Second canvas" renders whole, and the bar is never held to the width it had (it grows to fit)', () => {
    const { container } = render(<ProjectWorkspaceControls />);
    const bar = container.querySelector('.project-workspace-controls') as HTMLElement;
    // The width a short "Followups" bar had at 1280 (the follow starts there).
    bar.getBoundingClientRect = () => ({ width: 160, height: 30, x: 0, y: 0, top: 0, left: 0, right: 160, bottom: 30, toJSON: () => ({}) });
    act(() => setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }));
    expect(container.querySelector('.project-workspace-controls__opening-name')?.textContent).toBe('Second canvas');
    expect(bar.textContent).toBe('Opening “Second canvas”…');
    expect(bar.style.width).toBe('');
    expect(bar.style.maxWidth).toBe('');
    expect(bar).toHaveAttribute('title', 'Opening “Second canvas”…');
  });

  it('the CSS never cuts the line or the bar while following (no max-width, no overflow hidden, no ellipsis)', () => {
    const css = read('components/projects/ProjectWorkspaceControls.css');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => /--following|__opening/.test(selector))
      .map(([, selector, body]) => `${selector.trim()} { ${body.trim()} }`);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((rule) => /max-width|overflow:\s*hidden|text-overflow/.test(rule))).toEqual([]);
  });

  it('only a name past 24 characters is cut, with "…"; the title and label keep all of it', () => {
    const { container } = render(<ProjectWorkspaceControls />);
    const name = 'Second canvas with a name far too long';
    act(() => setFollowingSwitch({ projectName: name, agent: 'Codex' }));
    const shown = container.querySelector('.project-workspace-controls__opening-name')?.textContent ?? '';
    expect(shown).toBe(`${name.slice(0, 23).trimEnd()}…`);
    const bar = container.querySelector('.project-workspace-controls') as HTMLElement;
    expect(bar).toHaveAttribute('title', `Opening “${name}”…`);
    expect(bar).toHaveAttribute('aria-label', `Opening “${name}”…`);
    act(() => setFollowingSwitch({ projectName: 'Exactly twenty-four char', agent: 'Codex' }));
    expect(container.querySelector('.project-workspace-controls__opening-name')?.textContent).toBe('Exactly twenty-four char');
  });
});

// ── GM bug 2: the kept-note dialog ──────────────────────────────────────────

describe('GM bug 2 and review L-1: the note dialog', () => {
  it('starts with the caret at the end of the kept note, nothing selected, in a textarea that grows', () => {
    useCanvasPinsStore.setState({ kept: [{ text: 'Make the sky warmer and the sea darker', line: NOTE_KEPT_LINE, project: '', projectName: '', following: null }] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    const field = screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.value).toBe('Make the sky warmer and the sea darker');
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(field.value.length);
    expect(field.selectionEnd).toBe(field.value.length);
    // Grows to about 4 lines, then scrolls (AutoGrowTextarea reads max-height).
    const css = read('styles/prompt-dialog.css');
    expect(css).toMatch(/\.prompt-dialog__field textarea[^{]*\{[^}]*max-height:[^}]*\}/);
  });

  it('typing adds to it; it never replaces it', () => {
    useCanvasPinsStore.setState({ kept: [{ text: 'warmer sky', line: NOTE_KEPT_LINE, project: '', projectName: '', following: null }] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    const field = screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
    expect(field.selectionStart).toBe(field.selectionEnd);
  });

  it('"Send note" and "Cancel"', () => {
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    expect(screen.getByRole('button', { name: 'Send note' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OK' })).toBeNull();
  });

  it('Enter sends; Shift+Enter starts a new line', () => {
    const done = vi.fn();
    render(<PromptDialog request={{ label: 'Note for agents', initial: 'a', resolve: () => {} }} onDone={done} multiline confirmLabel="Send note" />);
    const field = screen.getByRole('textbox', { name: 'Note for agents' });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(done).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(done).toHaveBeenCalledWith('a');
  });

  it('other prompts still select their text on open (a rename)', () => {
    render(<PromptDialog request={{ label: 'Rename', initial: 'Hero', resolve: () => {} }} onDone={vi.fn()} />);
    const field = screen.getByRole('textbox', { name: 'Rename' }) as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4]);
  });

  it('text selection is the standard colour app-wide, never the accent', () => {
    const offenders = walk(SRC, /\.css$/).flatMap((path) => cssRules(readFileSync(path, 'utf8'))
      .filter(({ selector, body }) => /::selection/.test(selector) && /--sr-accent|#ff5a1f/i.test(body))
      .map(({ selector }) => `${relative(SRC, path)}: ${selector}`));
    expect(offenders).toEqual([]);
  });

  it('GM answer 2: the kept-note lines use ’', () => {
    expect(NOTE_KEPT_LINE).toBe('Your note wasn’t sent because the canvas changed first.');
    expect(noteKeptLine({ agent: 'Codex', projectName: 'Second canvas' }))
      .toBe('Your note wasn’t sent because Codex started opening “Second canvas”.');
  });
});

// ── Cinema: GM bug 3, GM answer 1 ───────────────────────────────────────────

const sceneSpec = (): CinemaSceneSpec => ({ version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
  shots: [{ id: 'a', prompt: 'a lighthouse at dusk', output: { status: 'done', imageUrl: '/a.png' } }, { id: 'b', prompt: 'Two' }] } as never);

function cinemaScene(): CinemaSceneSpec {
  const spec = sceneSpec();
  const node: Node<NodeData> = { id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
    data: { label: 'Scene', definitionId: 'cinema-scene', params: { scene: spec }, state: 'idle', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [], isImportingGraph: false, activeRuns: [] } as never);
  useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
  return spec;
}
const at = (element: ReactElement) => render(element).container;
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')]
  .find((item) => item.textContent?.trim() === text) as HTMLButtonElement;

describe('GM bug 3: a failed reference disables Generate shot and Generate 2 alike', () => {
  it('both disabled, the same reason as each tooltip, and one reason line under the row', () => {
    const spec = cinemaScene();
    useCinemaUploadStore.setState({ uploads: [{ id: 'u1', attempt: 'x', nodeId: 'n1', shotId: 'a', name: 'reference.png',
      status: 'error', error: 'Upload failed.', canRetry: true }] });
    const root = at(<CinemaShotPanel cinemaNodeId="n1" scene={spec} shot={spec.shots[0]} onChangeShot={vi.fn()} />);
    const reason = 'Retry or remove failed reference uploads before generating.';
    for (const label of ['Generate shot', 'Generate 2']) {
      const control = button(root, label);
      expect(control, label).toBeDisabled();
      expect(control, label).toHaveAttribute('title', reason);
    }
    const lines = [...root.querySelectorAll('[role="status"]')].filter((line) => line.textContent === reason);
    expect(lines).toHaveLength(1);
    // Under the row with both buttons: after Generate 2 in the document.
    expect(button(root, 'Generate 2').compareDocumentPosition(lines[0]) & Node_FOLLOWING).toBeTruthy();
  });
});
const Node_FOLLOWING = 4;

describe('GM answer 1: offline, Cinema is locked and every control says when it works again', () => {
  it('offlineDisabledReason: GM\'s words', () => {
    expect(offlineDisabledReason('generate')).toBe('You can generate when Nebula reconnects.');
    expect(offlineDisabledReason()).toBe('This works again when Nebula reconnects.');
  });

  it('Generate shot, Generate 2, Send to motion, the prompt; + Add shot and the reorder arrows; Generate all', () => {
    const spec = cinemaScene();
    const panel = at(<CinemaShotPanel cinemaNodeId="n1" scene={spec} shot={spec.shots[0]} onChangeShot={vi.fn()} />);
    const rail = at(<CinemaShotsRail cinemaNodeId="n1" scene={spec} selectedShotId="b" onSelect={vi.fn()}
      onAddShot={vi.fn()} onRemoveShot={vi.fn()} onReorder={vi.fn()} />);
    const toolbar = at(<CinemaStudioToolbar cinemaNodeId="n1" />);
    act(() => noteBackendConnection('offline'));
    const generateShot = button(panel, 'Generate shot');
    expect(generateShot).toBeDisabled();
    expect(generateShot).toHaveAttribute('title', 'You can generate when Nebula reconnects.');
    const locked: Array<[HTMLElement, string]> = [
      [button(panel, 'Generate 2'), 'You can generate when Nebula reconnects.'],
      // GM, PR #200 r2 item 4 (the merge with #198): "send it to motion".
      [button(panel, 'Send to motion'), 'You can send it to motion when Nebula reconnects.'],
      [button(rail, '+ Add shot'), 'You can add shots when Nebula reconnects.'],
      [rail.querySelector('[aria-label="Move Shot 2 earlier"]') as HTMLElement, 'You can reorder shots when Nebula reconnects.'],
      [button(toolbar, 'Generate all'), 'You can generate when Nebula reconnects.'],
    ];
    for (const [control, title] of locked) {
      expect(control, title).toBeDisabled();
      expect(control, title).toHaveAttribute('data-offline-disabled');
      expect(control, title).toHaveAttribute('title', title);
    }
    const prompt = panel.querySelector('.cinema-shot-panel__prompt') as HTMLTextAreaElement;
    expect(prompt.readOnly).toBe(true);
    expect(prompt).toHaveAttribute('data-offline-disabled');
    // GM, PR #200 r2 item 4 (the merge with #198): a text field has no
    // tooltip offline; it goes read-only and the banner says why.
    expect(prompt).not.toHaveAttribute('title');
    // Dragging a shot to reorder it is off too.
    expect(rail.querySelector('.cinema-shots-rail__shot')).toHaveAttribute('draggable', 'false');
  });

  it('every locked Cinema control is in the one disabled look (the offline shot read them all as live)', () => {
    const shared = read('styles/disabled-buttons.css');
    for (const selector of ['.cinema-shot-panel__action', '.cinema-shot-panel__stepper-btn', '.cinema-shots-rail__add',
      '.cinema-shots-rail__move', '.cinema-shots-rail__remove', '.cinema-studio-toolbar__action', '.cinema-shot-panel__prompt']) {
      expect(shared, selector).toMatch(new RegExp(`${selector.replace(/[.]/g, '\\.')}\\b`));
    }
  });
});

// ── GM answer 6: one disabled colour treatment ──────────────────────────────

const walk = (dir: string, match: RegExp): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path, match) : match.test(name) && !/\.test\./.test(name) ? [path] : [];
});
function cssRules(css: string): Array<{ selector: string; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

describe('GM answer 6: one disabled colour treatment', () => {
  const rules = cssRules(read('styles/disabled-buttons.css'));
  const filled = rules.find(({ selector, body }) => /:disabled/.test(selector) && /background:\s*var\(--sr-disabled-fill/.test(body));
  const unfilled = rules.find(({ selector, body }) => /:disabled/.test(selector) && /background:\s*transparent/.test(body));

  it('a filled button keeps a fill, turned neutral grey; ghost and outline stay unfilled; no extra opacity', () => {
    expect(filled, 'the filled rule').toBeDefined();
    expect(unfilled, 'the unfilled rule').toBeDefined();
    for (const rule of [filled!, unfilled!]) {
      expect(rule.body).toMatch(/color:\s*var\(--sr-disabled-ink[^;]*!important/);
      expect(rule.body).toMatch(/opacity:\s*1\s*!important/);
      expect(rule.body).not.toMatch(/--sr-accent|--sr-danger|--sr-error|#ff5a1f/i);
    }
    // The outline stays neutral and never brighter than a live button's edge.
    expect(unfilled!.body).toMatch(/border-color:\s*var\(--sr-disabled-edge/);
  });

  it('white primaries, the danger confirms and the mask painter\'s Save are filled and covered', () => {
    for (const name of ['project-home__new', 'project-switch-toast__back', 'project-home__danger', 'prompt-dialog__danger', 'mask-painter__save']) {
      expect(filled!.selector, name).toMatch(new RegExp(`\\.${name}\\b`));
    }
  });

  it('the canvas toolbar\'s Run, Ask, Duplicate and Delete stay unfilled and grey', () => {
    expect(unfilled!.selector).toMatch(/\.selection-toolbar__button\b/);
    expect(filled!.selector).not.toMatch(/\.selection-toolbar__button/);
  });

  it('the lock\'s own 0.6 dimming is not stacked on a covered control', () => {
    // App.css dims lock-marked controls; the shared rule's opacity: 1 wins for every covered one.
    expect(read('App.css')).toMatch(/\[data-following-disabled\][^{]*\{[^}]*opacity/);
    expect(filled!.body).toMatch(/opacity:\s*1\s*!important/);
  });
});

// ── GM note: the selected shot card ─────────────────────────────────────────

describe('GM note: the selected shot card uses the shared selected style, never the accent', () => {
  it('no accent on the selected shot; the node category colour instead', () => {
    const selected = cssRules(read('styles/cinema-studio.css')).filter(({ selector }) => /cinema-shots-rail__shot--selected/.test(selector));
    expect(selected.length).toBeGreaterThan(0);
    for (const { body } of selected) expect(body).not.toMatch(/--sr-accent|#ff5a1f/i);
    expect(selected.map(({ body }) => body).join(' ')).toMatch(/--node-category-color/);
  });

  it('the rail carries the Cinema node\'s category colour', () => {
    const spec = cinemaScene();
    const rail = at(<CinemaShotsRail cinemaNodeId="n1" scene={spec} selectedShotId="a" onSelect={vi.fn()}
      onAddShot={vi.fn()} onRemoveShot={vi.fn()} onReorder={vi.fn()} />);
    const root = rail.querySelector('.cinema-shots-rail') as HTMLElement;
    expect(root.style.getPropertyValue('--node-category-color')).toBe('#d9a441');
  });
});

// ── Same titles: grouped, in canvas order ───────────────────────────────────

describe('GM answers 3 and 4, review L-6: repeated names grouped, in canvas order', () => {
  it('the failed-save line follows canvas order, not the order the saves came in', () => {
    const line = changesNotSavedLine([
      { nodeId: 'n3', node: 'Brief', setting: 'Text', order: 2 },
      { nodeId: 'n1', node: 'Text', setting: 'Text', order: 0 },
      { nodeId: 'n2', node: 'Text', setting: 'Text', order: 1 },
    ]);
    expect(line).toBe('Couldn’t save your changes to 2 “Text” nodes and “Brief”.');
  });

  const row = (nodeId: string, label: string): PlaceholderRunRow => ({ nodeId, name: `“${label}”`, model: null, modelKey: 'm',
    setting: null, price: '$0.04', agent: null } as PlaceholderRunRow);

  it('"… changed while this was open" groups same titles, in canvas order', () => {
    const rows = [row('n3', 'Text'), row('n1', 'Brief'), row('n2', 'Text')];
    expect(movedNodesLine(rows, ['n3', 'n2', 'n1'], ['n2', 'n3', 'n1']))
      .toBe('2 “Text” nodes and “Brief” changed while this was open.');
    expect(movedNodesLine(rows, ['n3', 'n2'])).toBe('2 “Text” nodes changed while this was open.');
  });

  it('nodeNameList keeps the order it is given (callers give canvas order)', () => {
    expect(nodeNameList(['Text', 'Brief', 'Text'])).toBe('2 “Text” nodes and “Brief”');
    expect(nodeNameList(['Brief', 'Text', 'Text'])).toBe('“Brief” and 2 “Text” nodes');
  });
});

// ── Review L-5: EditNode's Open Editor ──────────────────────────────────────

// Fix round 2 (review 2 L-6, GM 2026-10-28 answer 4): opening this node's
// own editor writes nothing, so it stays available while following and
// offline; the editor opens read-only (agentPresenceFollowups.r2).
describe('review L-5 and review 2 L-6: EditNode\'s Open Editor', () => {
  it('following: still enabled, unmarked (it opens the editor read-only)', () => {
    const props = { id: 'e1', data: { params: { clips: [] } }, selected: true } as never;
    const root = at(<ReactFlowProvider><EditNode {...(props as object)} /></ReactFlowProvider>);
    const open = button(root, 'Open Editor');
    expect(open).toBeEnabled();
    act(() => setFollowingSwitch({ projectName: 'beta', agent: 'Codex' }));
    expect(open).toBeEnabled();
    expect(open).not.toHaveAttribute('data-following-disabled');
  });
});
