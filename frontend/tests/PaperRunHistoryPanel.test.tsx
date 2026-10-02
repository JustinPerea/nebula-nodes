import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import type { RunRecord } from '../src/lib/runHistory';
import type { PaperSourceSnapshot } from '../src/lib/paperSource';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const input: PaperSourceSnapshot = {
  id: 'input-a', hash: 'immutable-input-hash-a', capturedAt: '2026-10-01T10:00:00Z', width: 240, height: 180,
  hasAlpha: true, hasTransparency: true, filePath: '/snapshots/a.png', previewUrl: '/api/outputs/paper/input-a.png',
  identity: { fileId: 'file-a', pageId: 'page-a', objectId: 'logo-a', fileName: 'Logo', pageName: 'Page', objectName: 'Logo A', openUrl: 'https://app.paper.design/file-a', navigation: 'file' },
  exportSettings: { format: 'png', scale: '2x', bounds: 'object', background: 'artwork' },
};
const run: RunRecord = {
  id: 'run-a', status: 'complete', trigger: 'graph', startedAt: Date.now(),
  snapshot: { nodes: [
    { id: 'paper-node', definitionId: 'paper-source', params: { _paperSource: { id: 'source-a', identity: input.identity, snapshot: input } }, outputs: {} },
    { id: 'fixture', definitionId: 'image-compare', params: {}, outputs: {} },
  ], edges: [{ id: 'edge-a', source: 'paper-node', sourceHandle: 'image', target: 'fixture', targetHandle: 'image' }] },
  paperInputs: [{ nodeId: 'paper-node', sourceId: 'source-a', snapshot: input }],
  recipeRevision: 'saved-recipe-revision-a', outOfDateReasons: ['Paper source paper-node updated after this input was captured.'],
  resultOutputs: { fixture: { image: { type: 'Image', value: '/api/outputs/result-a.png' } } },
};

describe('Paper run history inspection and explicit latest-source replay', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    useUIStore.setState(INITIAL_UI_STATE, true);
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
    useGraphStore.setState({ nodes: [{ id: 'paper-node', position: { x: 0, y: 0 }, data: { label: 'Paper source', definitionId: 'paper-source', params: { _paperSource: { id: 'source-a', state: 'current', identity: input.identity, snapshot: input } }, state: 'complete', outputs: {} } }] });
  });

  it('displays the prior run input/output and recipe while the current source has changed', () => {
    useGraphStore.setState({
      runHistory: [run],
      nodes: [{ id: 'paper-node', position: { x: 0, y: 0 }, data: { label: 'Paper source', definitionId: 'paper-source', params: { _paperSource: { id: 'source-a', identity: input.identity, snapshot: { ...input, hash: 'current-hash-b', previewUrl: '/api/outputs/paper/input-b.png' } } }, state: 'idle', outputs: {} } }],
    });
    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByText('Inspect saved input and output snapshots'));
    expect(screen.getByText('Out of date')).toBeInTheDocument();
    expect(screen.getByText('saved-recipe-revision-a')).toBeInTheDocument();
    expect(screen.getByText('SHA-256: immutable-input-hash-a')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Saved Paper input Logo A for run run-a' })).toHaveAttribute('src', expect.stringContaining('/paper/input-a.png'));
    expect(screen.getByRole('img', { name: 'Saved output fixture for run run-a' })).toHaveAttribute('src', expect.stringContaining('/result-a.png'));
    expect(screen.queryByText('current-hash-b')).not.toBeInTheDocument();
  });

  it('keeps exact replay distinct from explicitly using the latest source', () => {
    const rerunHistoryRecord = vi.fn(async () => undefined);
    const rerunHistoryWithLatestPaperSource = vi.fn(async () => undefined);
    useGraphStore.setState({ runHistory: [run], rerunHistoryRecord, rerunHistoryWithLatestPaperSource, isExecuting: false });
    render(<RunHistoryPanel />);
    expect(rerunHistoryRecord).not.toHaveBeenCalled();
    expect(rerunHistoryWithLatestPaperSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rerun Full graph' }));
    expect(rerunHistoryRecord).toHaveBeenCalledWith('run-a');
    expect(rerunHistoryWithLatestPaperSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rerun Full graph with latest source' }));
    expect(rerunHistoryWithLatestPaperSource).toHaveBeenCalledWith('run-a');
  });

  it('disables latest-source replay while the captured prior run is still executing', () => {
    const rerunHistoryWithLatestPaperSource = vi.fn(async () => undefined);
    useGraphStore.setState({ runHistory: [run], rerunHistoryWithLatestPaperSource, isExecuting: true });
    render(<RunHistoryPanel />);
    const action = screen.getByRole('button', { name: 'Rerun Full graph with latest source' });
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(rerunHistoryWithLatestPaperSource).not.toHaveBeenCalled();
  });

  it('requires reconnection or refresh before replaying with an unavailable source', () => {
    const rerunHistoryWithLatestPaperSource = vi.fn(async () => undefined);
    useGraphStore.setState({ runHistory: [run], rerunHistoryWithLatestPaperSource, nodes: [], isExecuting: false });
    render(<RunHistoryPanel />);
    const action = screen.getByRole('button', { name: 'Rerun Full graph with latest source' });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('title', 'Refresh or reconnect the Paper source before using its latest artwork');
    fireEvent.click(action);
    expect(rerunHistoryWithLatestPaperSource).not.toHaveBeenCalled();
  });
});
