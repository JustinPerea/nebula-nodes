import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetDetail, CommonsStatus } from '../src/lib/commonsTypes';
import type { RunRecord } from '../src/lib/runHistory';

/**
 * Round 16 of PR #114, offline read-only (review 15 and GM's round-16
 * rulings): what only stops or reduces work stays usable offline (M1), and
 * the controls that still wrote or showed an error line offline are disabled
 * with the offline mark and stay silent (L3, L4, L5); a rename draft gets its
 * focus back on reconnect, or is dropped with GM's line when an agent renamed
 * the node meanwhile (nit).
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
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
const commons = vi.hoisted(() => ({ asset: vi.fn(), patchMembership: vi.fn(), reanalyze: vi.fn() }));
vi.mock('../src/lib/commonsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/commonsApi')>();
  return { ...actual, commonsApi: { ...actual.commonsApi, asset: commons.asset, blob: () => new Promise(() => {}),
    patchMembership: commons.patchMembership, reanalyze: commons.reanalyze } };
});

import { Toolbar } from '../src/components/panels/Toolbar';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { PermissionCard, type PermissionRequestPart } from '../src/components/panels/PermissionCard';
import { NodeLabel } from '../src/components/nodes/NodeLabel';
import { StatusLine } from '../src/components/commons/CommonsView';
import { CommonsDetail } from '../src/components/commons/CommonsDetail';
import { droppedRenameLine } from '../src/lib/canvasUndo';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };

beforeEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
});
afterEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  vi.restoreAllMocks();
});

function running(id: string): RunRecord {
  return { id, status: 'running', trigger: 'graph', startedAt: Date.now(),
    snapshot: { nodes: [{ id: 'n1', definitionId: 'text-input', params: {}, outputs: {} }], edges: [] } };
}

describe('M1: Stop works while offline (a false offline must never trap a spending run)', () => {
  it('the toolbar\'s Stop stays enabled, unmarked, and calls Stop', () => {
    const cancelExecution = vi.fn(async () => undefined);
    useGraphStore.setState({ isExecuting: true, isCancelling: false, cancelExecution, nodes: [], edges: [] });
    noteBackendConnection('offline');
    render(<Toolbar />);
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toBeEnabled();
    expect(stop).not.toHaveAttribute('data-offline-disabled');
    expect(stop).toHaveAttribute('title', 'Stop the run');
    fireEvent.click(stop);
    expect(cancelExecution).toHaveBeenCalledOnce();
  });

  it('Run History\'s header Stop stays enabled, unmarked, and calls Stop', () => {
    const cancelExecution = vi.fn(async () => undefined);
    useGraphStore.setState({ runHistory: [running('r1')], isExecuting: true, isCancelling: false, cancelExecution });
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
    noteBackendConnection('offline');
    render(<RunHistoryPanel />);
    const stop = screen.getByRole('button', { name: 'Stop the run' });
    expect(stop).toBeEnabled();
    expect(stop).not.toHaveAttribute('data-offline-disabled');
    expect(stop).toHaveAttribute('title', 'Stop the run');
    fireEvent.click(stop);
    expect(cancelExecution).toHaveBeenCalledOnce();
  });

  it('with nothing running, the header Stop says why it is disabled (GM tooltip rule)', () => {
    useGraphStore.setState({ runHistory: [], isExecuting: false, isCancelling: false });
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
    render(<RunHistoryPanel />);
    const stop = screen.getByRole('button', { name: 'Stop the run' });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute('title', 'Nothing is running.');
  });
});

describe('the toolbar\'s disabled Run is neutral (GM, round 16)', () => {
  it('the selection toolbar\'s primary button has a neutral disabled style, not orange', () => {
    const css = readFileSync(join(__dirname, '../src/styles/canvas.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.selection-toolbar__button--primary:disabled\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('var(--sr-surface-control-active');
    expect(rule).toContain('var(--sr-ink-bold');
    expect(rule).not.toMatch(/accent/);
  });
});

describe('L5: a chat permission while offline', () => {
  const part: PermissionRequestPart = { kind: 'permission', requestId: 'p1', title: 'Edit the canvas', toolKind: 'edit',
    input: null, canAllow: true, timeoutSeconds: 60, receivedAt: Date.now(), status: 'pending' };

  it('"Allow once" is disabled with the mark; Deny still answers', () => {
    const onDecision = vi.fn();
    noteBackendConnection('offline');
    render(<PermissionCard part={part} agentName="Codex" onDecision={onDecision} />);
    const allow = screen.getByRole('button', { name: 'Allow once' });
    expect(allow).toBeDisabled();
    expect(allow).toHaveAttribute('data-offline-disabled');
    fireEvent.click(allow);
    expect(onDecision).not.toHaveBeenCalled();
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(deny).toBeEnabled();
    fireEvent.click(deny);
    expect(onDecision).toHaveBeenCalledWith('p1', 'deny');
  });

  it('the request stays pending, and Allow comes back on reconnect', () => {
    const onDecision = vi.fn();
    noteBackendConnection('offline');
    render(<PermissionCard part={part} agentName="Codex" onDecision={onDecision} />);
    act(() => noteBackendConnection('online'));
    const allow = screen.getByRole('button', { name: 'Allow once' });
    expect(allow).toBeEnabled();
    fireEvent.click(allow);
    expect(onDecision).toHaveBeenCalledWith('p1', 'allow');
  });
});

describe('a rename draft after reconnect (review 15 nit, GM follow-up)', () => {
  it('gets its focus back when nobody renamed the node meanwhile', () => {
    render(<NodeLabel nodeId="n1" label="Text Input" displayName="Text Input" />);
    fireEvent.doubleClick(screen.getByText('Text Input'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Node name' }), { target: { value: 'Brief draft' } });
    act(() => noteBackendConnection('offline'));
    // A browser blurs a field as it becomes disabled; jsdom doesn't, so the
    // focus moves away by hand.
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    act(() => elsewhere.focus());
    expect(screen.getByRole('textbox', { name: 'Node name' })).not.toHaveFocus();
    act(() => noteBackendConnection('online'));
    const input = screen.getByRole('textbox', { name: 'Node name' });
    expect(input).toHaveValue('Brief draft');
    expect(input).toHaveFocus();
    elsewhere.remove();
  });

  it('is dropped, with GM\'s line and no refocus, when an agent renamed the node while offline', () => {
    const renameNode = vi.fn();
    const notify = vi.fn();
    useGraphStore.setState({ renameNode, notify });
    const { rerender } = render(<NodeLabel nodeId="n1" label="Text Input" displayName="Text Input" />);
    fireEvent.doubleClick(screen.getByText('Text Input'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Node name' }), { target: { value: 'Brief draft' } });
    act(() => noteBackendConnection('offline'));
    rerender(<NodeLabel nodeId="n1" label="Hero shot" displayName="Text Input" />);
    act(() => noteBackendConnection('online'));
    expect(screen.queryByRole('textbox', { name: 'Node name' })).toBeNull();
    expect(screen.getByText('Hero shot')).toBeInTheDocument();
    expect(renameNode).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'An agent renamed this node “Hero shot” while Nebula was offline, so your rename to “Brief draft” wasn\'t saved.',
      'info');
  });

  it.each([
    ['Codex', 'Codex renamed this node “Hero shot” while Nebula was offline, so your rename to “Brief draft” wasn\'t saved.'],
    [null, 'An agent renamed this node “Hero shot” while Nebula was offline, so your rename to “Brief draft” wasn\'t saved.'],
  ])('GM\'s exact line (agent %s)', (agent, line) => {
    expect(droppedRenameLine(agent, 'Hero shot', 'Brief draft')).toBe(line);
  });
});

describe('L4: the Commons is read-only offline', () => {
  const status: CommonsStatus = {
    worker: { state: 'stopped', running: false, budget_used: 0, budget: null },
    meter: { calls: 0, cap: 20, remaining: 20, resets_at: '2026-10-28T00:00:00Z' },
    queue: { queued: 0, analyzing: 0, analysis_failed: 0, held: 0, ready: 0 }, load: 1, load_threshold: 8,
  };

  it('the worker\'s Start is disabled with the mark; a running worker\'s Stop stays enabled', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    noteBackendConnection('offline');
    const { rerender } = render(<StatusLine status={status} onStart={onStart} onStop={onStop} />);
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('data-offline-disabled');
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();
    rerender(<StatusLine status={{ ...status, worker: { state: 'idle', running: true, budget_used: 0, budget: null } }}
      onStart={onStart} onStop={onStop} />);
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toBeEnabled();
    expect(stop).not.toHaveAttribute('data-offline-disabled');
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();
  });

  function detail(): AssetDetail {
    return {
      asset: { id: 'ast_1', media: 'image', width: 24, height: 24, made_by: 'unknown', analysis_state: 'ready',
        last_error: null, measurements: null },
      effective: { fields: { summary: { value: 'A loud poster' } }, sources: {}, corrected_paths: [], analysis: null },
      corrections: [], regions: [],
      memberships: [{ id: 'mem_1', collection: 'col_1', collection_name: 'Open refs', brand: null, role: 'neutral',
        why: 'loud poster', actor: 'human:justin', in_inbox: 0, sightings: [], comments: [] }],
      borrowings: [], blob_url: '/api/commons/blobs/x.png',
    } as unknown as AssetDetail;
  }

  it('a reference\'s writes are disabled in one fieldset (Close stays), and a field\'s blur offline sends nothing', async () => {
    commons.asset.mockReset().mockResolvedValue(detail());
    commons.patchMembership.mockReset();
    const onClose = vi.fn();
    render(<CommonsDetail assetId="ast_1" onClose={onClose} onChanged={() => {}} onDeleted={() => {}} />);
    const why = await screen.findByDisplayValue('loud poster');
    fireEvent.change(why, { target: { value: 'an edit typed before the drop' } });
    act(() => noteBackendConnection('offline'));
    const fieldset = document.querySelector('fieldset.commons-fieldset')!;
    expect(fieldset).toBeDisabled();
    expect(fieldset).toHaveAttribute('data-offline-disabled');
    expect(screen.getByRole('button', { name: 'Re-analyze' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete and purge' })).toBeDisabled();
    fireEvent.blur(why);
    expect(commons.patchMembership).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByDisplayValue('an edit typed before the drop')).toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Close detail' });
    expect(close).toBeEnabled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
    act(() => noteBackendConnection('online'));
    expect(document.querySelector('fieldset.commons-fieldset')).not.toBeDisabled();
  });

  it('the fieldset doesn\'t dim twice: its own mark has full opacity, each control dims once', () => {
    const css = readFileSync(join(__dirname, '../src/styles/commons.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/\.commons-fieldset\[data-offline-disabled\]\s*\{\s*opacity:\s*1;\s*\}/.test(css)).toBe(true);
    expect(/\.commons-fieldset\s*\{[^}]*display:\s*contents/.test(css)).toBe(true);
  });
});
