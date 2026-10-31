import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../src/lib/runHistory';
import type { EvaluationBatch } from '../src/lib/commonsEvaluationTypes';

/**
 * Round 17 of PR #114, GM's visual rulings and the draft rules they extend:
 * - A: the bottom toolbar's Stop dots sit in the icon slot.
 * - B: Run History's Stop is at full opacity while a run is going.
 * - C: on the home screen the offline banner sits under the top bar.
 * - Commons label drafts follow the rename-draft rules on reconnect.
 * - A dropped rename names who renamed the node only when its source is known.
 */

const socket = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler: (event: unknown) => void) => { socket.handlers.push(handler); return () => {}; }) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  backendAssetUrlSync: (url: string) => url,
}));
vi.mock('../src/lib/graphFile', () => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
    useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
      selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
    useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
  };
});
const api = vi.hoisted(() => ({ get: vi.fn(), prepare: vi.fn(), image: vi.fn(), accents: vi.fn(), labels: vi.fn(), seal: vi.fn() }));
vi.mock('../src/lib/commonsApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/commonsApi')>(),
  commonsEvaluationApi: api,
}));

import { Toolbar } from '../src/components/panels/Toolbar';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { BackendConnectionStatus } from '../src/components/BackendConnectionStatus';
import { NodeLabel } from '../src/components/nodes/NodeLabel';
import { ACCENTS_CHANGED_ELSEWHERE, CommonsEvaluation, LABELS_CHANGED_ELSEWHERE } from '../src/components/commons/CommonsEvaluation';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { setProjectContext } from '../src/lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const css = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (source: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetBackendConnectionForTests();
  useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
});
afterEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  setProjectContext(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function running(id: string): RunRecord {
  return { id, status: 'running', trigger: 'graph', startedAt: Date.now(),
    snapshot: { nodes: [{ id: 'n1', definitionId: 'text-input', params: {}, outputs: {} }], edges: [] } };
}

describe('A: the bottom Stop\'s dots sit in its icon slot', () => {
  it('the Stop icon is wrapped in a slot (16px since GM r18, G4), and the dots hang off that slot, not the button', () => {
    useGraphStore.setState({ isExecuting: true, isCancelling: false, nodes: [], edges: [] });
    render(<Toolbar />);
    const stop = screen.getByRole('button', { name: 'Stop' });
    const slot = stop.querySelector('.toolbar__icon-slot');
    expect(slot).not.toBeNull();
    expect(slot).toHaveAttribute('aria-hidden', 'true');
    expect(slot!.querySelector('.toolbar__icon')).not.toBeNull();
    const styles = css('styles/slava-restraint.css');
    expect(rule(styles, 'body.app-slava-restraint .toolbar__icon-slot')).toMatch(/width:\s*16px/);
    expect(rule(styles, 'body.app-slava-restraint .toolbar__icon-slot')).toMatch(/position:\s*relative/);
    expect(styles).toContain('.toolbar__button--executing .toolbar__icon-slot::before');
    expect(styles).not.toMatch(/\.toolbar__button--executing::before/);
  });
});

describe('B: Run History\'s Stop is at full opacity while a run is going', () => {
  it('the header Stop carries its own class, and that class is full opacity when enabled', () => {
    useGraphStore.setState({ runHistory: [running('r1')], isExecuting: true, isCancelling: false });
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
    noteBackendConnection('offline');
    render(<RunHistoryPanel />);
    const stop = screen.getByRole('button', { name: 'Stop the run' });
    expect(stop).toBeEnabled();
    expect(stop).toHaveClass('run-history__stop');
    const body = rule(css('styles/run-history.css'), 'body.app-slava-restraint .run-history__stop:not(:disabled)');
    expect(body).toMatch(/opacity:\s*1\s*;/);
    expect(body).toContain('var(--sr-ink');
  });
});

describe('C: on the home screen the offline banner sits under the top bar', () => {
  it('the banner says where it is, and the home placement is right under the 72px bar and its border', () => {
    noteBackendConnection('offline');
    const { rerender } = render(<BackendConnectionStatus placement="home" />);
    expect(document.querySelector('.backend-connection')).toHaveAttribute('data-placement', 'home');
    rerender(<BackendConnectionStatus />);
    expect(document.querySelector('.backend-connection')).toHaveAttribute('data-placement', 'workspace');
    expect(rule(css('App.css'), ".backend-connection[data-placement='home']")).toMatch(/top:\s*81px/);
  });

  it('App passes the home placement on the home screen', () => {
    const app = readFileSync(join(__dirname, '../src/App.tsx'), 'utf8');
    // GM, PR #198 r1: every screen but the canvas and home is a studio (tests/pr198Fix1Ui.test.tsx).
    expect(app).toMatch(/<BackendConnectionStatus placement=\{isHome \? 'home' : isCanvas \? 'workspace' : 'studio'\} \/>/);
  });
});

describe('Commons label drafts on reconnect (the rename-draft rules)', () => {
  const batch = (revision: number, locked = true, labels: EvaluationBatch['items'][number]['labels'] = null): EvaluationBatch => ({
    revision, state: 'open', denominator: 150, tuning_count: 30, manifest_hash: 'fixture', sealed: null, seal_hash: null,
    closed: null, close_hash: null, fields: { type_style: ['none'] }, axes: ['quiet_loud'], roles: ['accent'],
    keywords: ['geometric_type'], excluded_count: 0, assisted_reviews: 0,
    items: [{ position: 0, image_sha256: 'fixture-image', width: 40, height: 32, accent_locked: locked, labels,
      ...(locked ? { palette: [{ index: 0, hex: '#ff0000', share: 1 }] } : {}) }] });

  beforeEach(() => {
    api.image.mockResolvedValue(new Blob(['fixture']));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal('Image', class {
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
  });

  it('a draft whose reference nobody changed survives the reconnect and saves at the new revision', async () => {
    api.get.mockResolvedValueOnce(batch(4));
    render(<CommonsEvaluation />);
    await screen.findByText('Set neutral');
    fireEvent.click(screen.getByText('Set neutral'));
    expect(screen.getByLabelText('quiet loud').getAttribute('aria-valuetext')).toBe('0');
    act(() => noteBackendConnection('offline'));
    // Another item's save moved the batch's revision; this reference is the same.
    api.get.mockResolvedValueOnce(batch(5));
    act(() => noteBackendConnection('online'));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Save labels')).toBeEnabled());
    expect(screen.getByLabelText('quiet loud').getAttribute('aria-valuetext')).toBe('0');
    expect(screen.queryByText(LABELS_CHANGED_ELSEWHERE)).toBeNull();
    api.labels.mockResolvedValue(batch(6));
    fireEvent.click(screen.getByText('Save labels'));
    await waitFor(() => expect(api.labels).toHaveBeenCalledOnce());
    expect(api.labels.mock.calls[0][0]).toBe(0);
    expect(api.labels.mock.calls[0][1]).toBe(5);
  });

  it('a draft whose labels were saved in another window is dropped, with the line', async () => {
    api.get.mockResolvedValueOnce(batch(4));
    render(<CommonsEvaluation />);
    await screen.findByText('Set neutral');
    fireEvent.click(screen.getByText('Set neutral'));
    act(() => noteBackendConnection('offline'));
    const saved = batch(5, true, { tags: { type_style: 'none' }, axes: { quiet_loud: 2 }, palette_roles: {}, keywords: [],
      no_keywords: true, flagged: false });
    api.get.mockResolvedValueOnce(saved);
    act(() => noteBackendConnection('online'));
    expect(await screen.findByText(LABELS_CHANGED_ELSEWHERE)).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText('quiet loud').getAttribute('aria-valuetext')).not.toBe('0');
    expect(api.labels).not.toHaveBeenCalled();
  });

  it('an accents draft whose accents were saved in another window is dropped, with the accents line', async () => {
    api.get.mockResolvedValueOnce(batch(4, false));
    render(<CommonsEvaluation />);
    const none = await screen.findByLabelText('I don’t see any accent colors');
    await waitFor(() => expect((none as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(none);
    act(() => noteBackendConnection('offline'));
    api.get.mockResolvedValueOnce(batch(5, true));
    act(() => noteBackendConnection('online'));
    await screen.findByText(ACCENTS_CHANGED_ELSEWHERE);
    expect(api.accents).not.toHaveBeenCalled();
  });

  it('the lines, exactly', () => {
    expect(LABELS_CHANGED_ELSEWHERE).toBe("You changed this reference's labels in another window while Nebula was offline, so your changes here weren't saved.");
    // GM r18: "changed", like the labels line.
    expect(ACCENTS_CHANGED_ELSEWHERE).toBe("You changed this reference’s accents in another window while Nebula was offline, so your changes here weren’t saved.");
  });
});

describe('a dropped rename names who renamed the node only when its source is known (GM follow-up)', () => {
  const textNode = (label: string) => ({ id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label, definitionId: 'text-input', params: {}, state: 'idle', outputs: {} } });
  const sync = (edit: Record<string, unknown>) => {
    for (const handler of socket.handlers) handler({ type: 'graphSync', activeProjectId: 'A', workspaceRevision: 'a',
      paramsVersion: GRAPH_PARAMS_VERSION, empty: false, edges: [], nodes: [textNode('Hero shot')], edit });
  };

  it.each([
    ['an agent', { actor: { kind: 'agent', name: 'Codex', id: 'codex' } },
      'Codex renamed this node “Hero shot” while Nebula was offline, so your rename to “Brief draft” wasn’t saved.'],
    ['the person\'s other window', { tab: 'other-tab', actor: { kind: 'person' } },
      'You renamed this node “Hero shot” in another window while Nebula was offline, so your rename to “Brief draft” here wasn’t saved.'],
    ['an unknown source', {},
      'This node was renamed “Hero shot” while Nebula was offline, so your rename to “Brief draft” wasn’t saved.'],
  ])('renamed by %s', async (_who, edit, line) => {
    setProjectContext({ id: 'A', revision: 'a' });
    const notify = vi.fn();
    const renameNode = vi.fn();
    useGraphStore.setState({ nodes: [textNode('Text Input')] as never, edges: [], notify, renameNode });
    const { rerender } = render(<NodeLabel nodeId="n1" label="Text Input" displayName="Text Input" />);
    fireEvent.doubleClick(screen.getByText('Text Input'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Node name' }), { target: { value: 'Brief draft' } });
    act(() => noteBackendConnection('offline'));
    act(() => sync(edit));
    await waitFor(() => expect(useGraphStore.getState().nodes[0]?.data.label).toBe('Hero shot'));
    rerender(<NodeLabel nodeId="n1" label="Hero shot" displayName="Text Input" />);
    act(() => noteBackendConnection('online'));
    expect(renameNode).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(line, 'info');
  });
});
