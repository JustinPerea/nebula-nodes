import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * GM on PR #205, round 1:
 * - Answer 2: a refusal after a key press is the lock line alone, no
 *   "Couldn't …" sentence before it.
 * - Answer 3: Generate all says "the shots".
 * - Answer 6: a switch saving its own change follows the held rule (the
 *   SwitchRow tests here; Settings and Personal agents in their own suites).
 * - The fix: when the lock reason is already on screen beside a control, no
 *   tooltip; aria-describedby points at the line (canvasLock `shown`, a rule
 *   of the helper).
 * - The lines left alone move to the pattern: Cinema's shared inputs and
 *   shot lines, the import, the preparation, Commons' grade, and
 *   deleteProviderRecovery.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
    screenToFlowPosition: (p: unknown) => p, getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
  useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
    selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));

import { Toolbar } from '../src/components/panels/Toolbar';
import { CinemaStudioToolbar } from '../src/components/cinema-studio/CinemaStudioToolbar';
import { DeferredRunNotice } from '../src/components/canvas/DeferredRunNotice';
import { SwitchRow } from '../src/components/panels/settings/Switch';
import { canvasLockOf, lockedAction } from '../src/lib/canvasLock';
import { LOCK_WAITS, lockLine } from '../src/lib/runLock';
import { runLockedLine, runLockedWiresLine, scenesDeleteBlockTitle, sceneDeleteBlockTitle, shotRemovalBlockTitle } from '../src/lib/cinemaScene';
import { failureCopy } from '../src/lib/errorCopy';
import { HELD_LOOK_DELAY_MS } from '../src/hooks/useHeldLook';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { cascaded } from './helpers/cssCascade';

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
const INITIAL_PROPOSALS = { ...useCanvasProposalsStore.getState() };
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
  useCanvasProposalsStore.setState(INITIAL_PROPOSALS, true);
  document.body.className = '';
});

const textNode = (id: string, label: string) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label, definitionId: 'text-input', params: {}, outputs: {}, state: 'idle' } }) as unknown as Node<NodeData>;
const value = (element: Element, key: string) => cascaded(element).get(key)?.value ?? '';

describe('answer 2: a refusal after a key press is the lock line alone', () => {
  it('GM\'s five lines', () => {
    expect(runLockedLine('delete', 1, '“Brief”')).toBe('You can delete “Brief” when the run finishes.');
    expect(runLockedLine('delete', 3, undefined, ['A', 'B', 'C'])).toBe('You can delete “A”, “B” and “C” when the run finishes.');
    expect(runLockedLine('undo')).toBe('You can undo when the run finishes.');
    expect(runLockedLine('redo')).toBe('You can redo when the run finishes.');
    expect(runLockedWiresLine(1)).toBe('You can delete the connection when the run finishes.');
    for (const line of [runLockedLine('delete', 2, undefined, ['A', 'B']), runLockedLine('undo'), runLockedWiresLine(3)]) {
      expect(line).not.toMatch(/Couldn/);
    }
  });

  it('the Delete key on a node during this tab\'s run says it, and keeps the node', () => {
    useGraphStore.setState({ nodes: [{ ...textNode('n1', 'Brief'), selected: true }], edges: [], isExecuting: true });
    useGraphStore.getState().deleteNode('n1');
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1']);
    expect(useGraphStore.getState().undoNotice?.text ?? useGraphStore.getState().messageNotice?.text)
      .toBe('You can delete “Brief” when the run finishes.');
  });

  it('adding a connected node: "You can add “X” when the run finishes." (the import\'s: "… when the import finishes.")', async () => {
    const said: string[] = [];
    const connect = { source: 'n1', sourceHandle: 'text', target: 'new', targetHandle: 'text', newNodeIs: 'target' as const };
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: true, notify: (text: string) => { said.push(text); } } as never);
    await useGraphStore.getState().addNodeAndConnect('text-input', { x: 0, y: 0 }, connect);
    useGraphStore.setState({ isExecuting: false, isImportingGraph: true });
    await useGraphStore.getState().addNodeAndConnect('text-input', { x: 0, y: 0 }, connect);
    expect(said).toEqual(['You can add “Text Input” when the run finishes.', 'You can add “Text Input” when the import finishes.']);
  });
});

describe('answer 3: Generate all', () => {
  const scene = [{ id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
    data: { label: 'Opening', definitionId: 'cinema-scene', state: 'idle', outputs: {},
      params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{ id: 's1', prompt: 'a' }] } } } }];

  it('"You can generate the shots when the run finishes.", and the import\'s line during an import', () => {
    useGraphStore.setState({ isExecuting: true, nodes: scene as never });
    const view = render(<CinemaStudioToolbar cinemaNodeId="n1" />);
    expect(screen.getByRole('button', { name: /^Generat/ })).toHaveAttribute('title', 'You can generate the shots when the run finishes.');
    act(() => useGraphStore.setState({ isExecuting: false, isImportingGraph: true }));
    view.rerender(<CinemaStudioToolbar cinemaNodeId="n1" />);
    const generate = screen.getByRole('button', { name: /^Generat/ });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAttribute('title', 'You can generate the shots when the import finishes.');
  });
});

describe('the lines left alone, on the pattern', () => {
  it('one sentence for every wait (lib/runLock LOCK_WAITS)', () => {
    expect(lockLine('generate this shot', 'otherRun')).toBe('You can generate this shot when the other run finishes or after you stop it.');
    expect(lockLine('load a canvas', 'import')).toBe('You can load a canvas when the import finishes.');
    expect(lockLine('load a canvas', 'preparing')).toBe('You can load a canvas when Nebula finishes preparing the run.');
    expect(lockLine('save this review', 'grade')).toBe('You can save this review when the grade finishes.');
    expect(lockLine('delete them', 'runningShots')).toBe('You can delete them when the running shots finish.');
    expect(lockLine('remove “Shot 2”', { finishes: 'it' })).toBe('You can remove “Shot 2” when it finishes.');
    expect(Object.keys(LOCK_WAITS).sort()).toEqual(['grade', 'import', 'otherRun', 'preparing', 'run', 'runningShots']);
  });

  it('Cinema\'s shot lines take their control\'s verb; a Stop still says "Stop the run first."', () => {
    expect(shotRemovalBlockTitle('wait', 'Shot 2')).toBe('You can remove “Shot 2” when it finishes.');
    expect(shotRemovalBlockTitle('stop', 'Shot 2')).toBe('Stop the run first.');
    expect(scenesDeleteBlockTitle(false)).toBe('You can delete them when the running shots finish.');
    expect(sceneDeleteBlockTitle('Opening', { numbers: [2], stoppable: false })).toBe('You can delete “Opening” when it finishes.');
  });

  it.each([
    [{ isImportingGraph: true }, 'when the import finishes'],
    [{ createLaunchingIds: ['p'] }, 'when Nebula finishes preparing the run'],
  ])('the canvas actions panel %j: each control its own verb, the group line too', (state, when) => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], ...state } as never);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas actions' }));
    const panel = screen.getByRole('region', { name: 'Canvas actions' });
    expect(within(panel).getByRole('status')).toHaveTextContent(`You can save, load, import or clear the canvas ${when}.`);
    for (const [name, verb] of [['Save graph', 'save the canvas'], ['Load graph', 'load a canvas'],
      ['Import CLI graph', 'import a canvas'], ['Clear canvas…', 'clear the canvas']]) {
      expect(within(panel).getByRole('button', { name })).toHaveAttribute('title', `You can ${verb} ${when}.`);
    }
  });

  it('the canvas Run during an import: "You can run the graph when the import finishes."', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], isImportingGraph: true } as never);
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: /^Run\b/ })).toHaveAttribute('title', 'You can run the graph when the import finishes.');
  });

  it('a thrown refusal with no single control says the refused action, standing alone', async () => {
    useGraphStore.setState({ isImportingGraph: true });
    const generation = await useGraphStore.getState().authorGenerationCluster({ definitionId: 'flux-2-pro' } as never)
      .catch((caught: unknown) => caught);
    expect(failureCopy(generation)).toEqual({ heading: '', reason: 'You can start the generation when the import finishes.' });
    useGraphStore.setState({ isImportingGraph: false, isExecuting: true });
    const recovery = await useGraphStore.getState().deleteProviderRecovery('r1', 'n1').catch((caught: unknown) => caught);
    expect(failureCopy(recovery)).toEqual({ heading: '', reason: 'You can forget the recovery safeguard when the run finishes.' });
  });

  it('no code says the old lines', () => {
    const root = resolve(__dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const OLD = /Wait for the graph import to finish|Wait for generation preparation|Another run is using shared inputs|grade in progress to finish|Let the run finish, then try again|Wait for the running shots to finish|Couldn’t \$\{action\}\. \$\{runFinishesLine|Couldn’t delete \$\{what\}\. \$\{runFinishesLine/;
    const offenders = files.filter((file) => {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return OLD.test(code);
    }).map((file) => file.slice(root.length));
    expect(offenders).toEqual([]);
  });
});

describe('the fix: a reason already on screen beside the control is no tooltip (canvasLock `shown`)', () => {
  const free = canvasLockOf(null, false);
  const following = canvasLockOf({ projectName: 'Dusk' } as never, false);

  it('the reason on screen: no title, aria-describedby at the line', () => {
    expect(free.act({ disabled: true, title: 'Line' }, { shown: { id: 'l1', text: 'Line' } }))
      .toEqual({ disabled: true, title: undefined, 'aria-describedby': 'l1' });
    expect(free.act({}, { run: true, runTitle: 'Line', shown: { id: 'l1', text: 'Line' } }))
      .toEqual({ disabled: true, title: undefined, 'aria-describedby': 'l1' });
    expect(lockedAction(free, { disabled: true, title: 'Line' }, { shown: { id: 'l1', text: 'Line' } }))
      .toEqual({ disabled: true, title: undefined, 'aria-describedby': 'l1' });
  });

  it('any other reason keeps its tooltip: a different line, following, an enabled control, no line shown', () => {
    expect(free.act({ disabled: true, title: 'Other' }, { shown: { id: 'l1', text: 'Line' } }).title).toBe('Other');
    expect(following.act({ disabled: true, title: 'Line' }, { shown: { id: 'l1', text: 'Line' } }).title).toBe('Wait for “Dusk” to open.');
    expect(free.act({ title: 'Line' }, { shown: { id: 'l1', text: 'Line' } })).toEqual({ disabled: false, title: 'Line' });
    expect(free.act({ disabled: true, title: 'Line' }, { shown: { id: 'l1', text: undefined } }).title).toBe('Line');
  });

  it('the deferred run notice: [Run] has no tooltip and is described by the line; [Dismiss] shows and is enabled', () => {
    useGraphStore.setState({ nodes: [textNode('n3', 'Brief')], edges: [], isExecuting: true });
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n3'] } } as never);
    render(<DeferredRunNotice />);
    const run = screen.getByRole('button', { name: /Run/ });
    expect(run).toBeDisabled();
    expect(run).not.toHaveAttribute('title');
    expect(run).toHaveAccessibleDescription('You can run “Brief” when the current run finishes.');
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss).toBeVisible();
    expect(dismiss).toBeEnabled();
  });
});

describe('answer 6: a switch saving its own change follows the held rule', () => {
  beforeEach(() => { document.body.className = 'app-slava-restraint'; vi.useFakeTimers(); });
  const row = (saving: boolean, onChange = vi.fn()) => (
    <SwitchRow title="Demo zoom telemetry" checked saving={saving} onChange={onChange} />);
  const toggle = () => screen.getByRole('switch', { name: /Demo zoom telemetry/ });

  it('a slow save: the new position at once, the enabled look for 150 ms, then the locked look with the thumb where it was put', () => {
    const onChange = vi.fn();
    render(row(true, onChange));
    expect(toggle()).toBeChecked();
    expect(toggle()).toHaveAttribute('aria-disabled', 'true');
    expect(toggle()).toHaveAttribute('data-held-pending');
    expect(value(toggle(), '|background')).toBe('var(--sr-accent)');
    expect(value(toggle(), '::before|background')).toBe('#fff');
    fireEvent.click(toggle());
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS); });
    expect(toggle()).toHaveAttribute('data-held-look');
    expect(toggle()).toBeChecked();
    expect(value(toggle(), '|background')).toMatch(/^var\(--sr-disabled-fill/);
    expect(value(toggle(), '::before|background')).toMatch(/^var\(--disabled-label/);
    expect(value(toggle(), '::before|transform')).toBe('translateX(12px)');
  });

  it('a quick save never greys: answered before 150 ms, no held look ever, and the switch is enabled again', () => {
    const view = render(row(true));
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS - 20); });
    view.rerender(row(false));
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS * 2); });
    expect(toggle()).not.toHaveAttribute('data-held-look');
    expect(toggle()).not.toHaveAttribute('aria-disabled');
    expect(value(toggle(), '|background')).toBe('var(--sr-accent)');
  });
});
