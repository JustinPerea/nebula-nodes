import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { PaperSourceNode } from '../src/components/nodes/PaperSourceNode';
import { useGraphStore } from '../src/store/graphStore';
import {
  getPaperSelection, inspectPaperObject, openPaperSource, linkPaperSource, refreshPaperSource, reconnectPaperSource,
  paperObjectLinks, PaperSourceError, type PaperSourceRecord,
} from '../src/lib/paperSource';
import { isDesktopMode, openExternalUrl } from '../src/lib/paperDesktop';

vi.mock('../src/lib/paperSource', async (original) => ({
  ...await original<typeof import('../src/lib/paperSource')>(),
  getPaperSelection: vi.fn(), linkPaperSource: vi.fn(), refreshPaperSource: vi.fn(), reconnectPaperSource: vi.fn(),
  inspectPaperObject: vi.fn(), openPaperSource: vi.fn(),
}));
vi.mock('../src/lib/paperDesktop', () => ({ isDesktopMode: vi.fn(), openExternalUrl: vi.fn() }));

const INITIAL_STATE = { ...useGraphStore.getState() };
const identity = { fileId: 'file-a', pageId: 'page-a', objectId: 'logo-a', fileName: 'Logo file', pageName: 'Page 1', objectName: 'Editable A', openUrl: 'https://app.paper.design/file-a', navigation: 'file' as const };
const exportSettings = { format: 'png' as const, scale: '2x' as const, bounds: 'object' as const, background: 'artwork' as const };
const snapshot = { id: 'snapshot-a', hash: 'hash-a', capturedAt: '2026-10-01T10:00:00Z', width: 400, height: 200, hasAlpha: true, hasTransparency: true, filePath: '/safe/snapshot-a.png', previewUrl: '/api/outputs/paper/a.png', identity, exportSettings };
const source: PaperSourceRecord = { id: 'source-a', identity, exportSettings, snapshot, snapshots: [snapshot], state: 'current', sequence: 1, lastSuccessfulRefresh: snapshot.capturedAt };

function Harness() {
  const data = useGraphStore((state) => state.nodes[0].data);
  return <ReactFlowProvider><PaperSourceNode {...{ id: 'paper-node', data, selected: false } as NodeProps} /></ReactFlowProvider>;
}

function seed(linked?: PaperSourceRecord) {
  useGraphStore.setState({
    nodes: [{ id: 'paper-node', type: 'paperSourceNode', position: { x: 0, y: 0 }, data: { label: 'Paper source', definitionId: 'paper-source', params: linked ? { _paperSource: linked } : {}, state: 'idle', outputs: {} } }],
    edges: [{ id: 'edge-kept', source: 'paper-node', sourceHandle: 'image', target: 'downstream', targetHandle: 'image' }],
  });
}

describe('Paper source explicit UI lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDesktopMode).mockReturnValue(false);
    vi.mocked(openExternalUrl).mockResolvedValue();
    useGraphStore.setState(INITIAL_STATE, true);
  });

  it('freezes selected object identity and confirms bounds and export settings before linking', async () => {
    seed();
    vi.mocked(getPaperSelection).mockResolvedValue({ file: { id: 'file-a', name: 'Logo file' }, pageId: 'page-a', pageName: 'Page 1', selection: [{ id: 'logo-a', name: 'Editable A', width: 200, height: 100 }] });
    vi.mocked(linkPaperSource).mockResolvedValue(source);
    const executeGraph = vi.fn();
    useGraphStore.setState({ executeGraph });
    render(<Harness />);

    expect(getPaperSelection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Link selected object' }));
    await screen.findByText('Object bounds: 200 × 100 · logo-a');
    expect(linkPaperSource).not.toHaveBeenCalled();
    expect(screen.getByText('PNG · chosen object bounds · Paper artwork transparency')).toBeInTheDocument();
    // Changing Paper's current selection after confirmation is irrelevant.
    vi.mocked(getPaperSelection).mockResolvedValue({ file: { id: 'other-file', name: 'Other file' }, pageId: 'other-page', pageName: 'Elsewhere', selection: [{ id: 'other-logo', name: 'Other logo', width: 1, height: 1 }] });
    fireEvent.click(screen.getByRole('button', { name: 'Export and link' }));
    await screen.findByRole('img', { name: 'Editable A exported from Paper' });
    expect(linkPaperSource).toHaveBeenCalledWith({ fileId: 'file-a', pageId: 'page-a', objectId: 'logo-a', scale: '2x' });
    expect(getPaperSelection).toHaveBeenCalledOnce();
    expect(useGraphStore.getState().edges[0].id).toBe('edge-kept');
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it('refreshes the saved source and updates the preview without generation or selection reads', async () => {
    seed(source);
    const newer = { ...snapshot, id: 'snapshot-b', hash: 'hash-b', previewUrl: '/api/outputs/paper/b.png' };
    vi.mocked(refreshPaperSource).mockResolvedValue({ ...source, snapshot: newer, snapshots: [snapshot, newer], changed: true, sequence: 2 });
    const executeGraph = vi.fn();
    const executeNode = vi.fn();
    useGraphStore.setState({ executeGraph, executeNode });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh source' }));
    await screen.findByText(/Source updated\. Previous results are out of date/);
    expect(screen.getByRole('img')).toHaveAttribute('src', expect.stringContaining('/paper/b.png'));
    expect(refreshPaperSource).toHaveBeenCalledWith('source-a');
    expect(getPaperSelection).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
    expect(useGraphStore.getState().edges[0].id).toBe('edge-kept');
    expect(screen.getByText('Source snapshots (2)')).toBeInTheDocument();
  });

  it('labels unchanged refresh without inventing a new snapshot', async () => {
    seed(source);
    vi.mocked(refreshPaperSource).mockResolvedValue({ ...source, changed: false, sequence: 2 });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh source' }));
    await screen.findByText('Artwork unchanged. No new snapshot.');
    expect(screen.getByText('Source snapshots (1)')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', expect.stringContaining('/paper/a.png'));
  });

  it('retains and labels last-good pixels when the linked object is missing', async () => {
    seed(source);
    vi.mocked(refreshPaperSource).mockRejectedValue(new PaperSourceError('Linked object was deleted.', { ...source, state: 'missing', lastError: 'Linked object was deleted.', sequence: 2 }));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh source' }));
    await screen.findByText('Object missing');
    expect(screen.getByText(/Last good snapshot/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Last good artwork retained.');
    expect(screen.getByRole('img')).toHaveAttribute('src', expect.stringContaining('/paper/a.png'));
    expect(reconnectPaperSource).not.toHaveBeenCalled();
  });

  it('reconnects only after confirming another exact object and preserves old snapshots', async () => {
    seed({ ...source, state: 'missing' });
    vi.mocked(getPaperSelection).mockResolvedValue({ file: { id: 'file-a', name: 'Logo file' }, pageId: 'page-a', pageName: 'Page 1', selection: [{ id: 'logo-b', name: 'Editable B', width: 120, height: 80 }] });
    const newer = { ...snapshot, id: 'snapshot-b', hash: 'hash-b', identity: { ...identity, objectId: 'logo-b', objectName: 'Editable B' } };
    vi.mocked(reconnectPaperSource).mockResolvedValue({ ...source, state: 'current', identity: newer.identity, snapshot: newer, snapshots: [snapshot, newer], sequence: 2 });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect object' }));
    await screen.findByText('Object bounds: 120 × 80 · logo-b');
    expect(reconnectPaperSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export and reconnect' }));
    await screen.findByRole('img', { name: 'Editable B exported from Paper' });
    expect(reconnectPaperSource).toHaveBeenCalledWith('source-a', { fileId: 'file-a', pageId: 'page-a', objectId: 'logo-b', scale: '2x' });
    expect(screen.getByText('Source snapshots (2)')).toBeInTheDocument();
    expect(useGraphStore.getState().edges[0].id).toBe('edge-kept');
  });

  it('offers the exact bound object in desktop and browser links without relying on an imported URL', () => {
    seed(source);
    render(<Harness />);
    expect(screen.getByRole('link', { name: 'Open in Paper' })).toHaveAttribute('href', 'paper://file/file-a/page-a/logo-a');
    expect(screen.getByRole('link', { name: 'Open source link' })).toHaveAttribute('href', 'https://app.paper.design/file/file-a/page-a/logo-a');
    expect(screen.getByRole('link', { name: 'Open source link' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(openPaperSource).not.toHaveBeenCalled();
    expect(getPaperSelection).not.toHaveBeenCalled();
    expect(refreshPaperSource).not.toHaveBeenCalled();
  });

  it('hands the exact desktop route to the native bridge within the click and preserves graph state', async () => {
    seed(source);
    vi.mocked(isDesktopMode).mockReturnValue(true);
    const executeGraph = vi.fn();
    const executeNode = vi.fn();
    useGraphStore.setState({ executeGraph, executeNode });
    const before = useGraphStore.getState();
    render(<Harness />);
    expect(fireEvent.click(screen.getByRole('link', { name: 'Open in Paper' }))).toBe(false);
    // No awaited API call precedes OS routing, preserving browser user activation.
    expect(openExternalUrl).toHaveBeenCalledWith('paper://file/file-a/page-a/logo-a');
    await screen.findByText('Opening this object in Paper Desktop. If it does not open, use Open source link.');
    expect(fireEvent.click(screen.getByRole('link', { name: 'Open source link' }))).toBe(false);
    expect(openExternalUrl).toHaveBeenLastCalledWith('https://app.paper.design/file/file-a/page-a/logo-a');
    expect(screen.queryByText(/Opening this object/)).not.toBeInTheDocument();
    expect(useGraphStore.getState().nodes).toBe(before.nodes);
    expect(useGraphStore.getState().edges).toBe(before.edges);
    expect(useGraphStore.getState().runHistory).toBe(before.runHistory);
    expect(openPaperSource).not.toHaveBeenCalled();
    expect(getPaperSelection).not.toHaveBeenCalled();
    expect(refreshPaperSource).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('lets browsers follow both anchors in the click gesture without an asynchronous transport', () => {
    seed(source);
    const prevented: boolean[] = [];
    render(<div onClick={(event) => {
      prevented.push(event.defaultPrevented);
      // Observe the component's decision, then stop jsdom trying to navigate.
      event.preventDefault();
    }}><Harness /></div>);
    fireEvent.click(screen.getByRole('link', { name: 'Open in Paper' }));
    fireEvent.click(screen.getByRole('link', { name: 'Open source link' }));
    expect(prevented).toEqual([false, false]);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(openPaperSource).not.toHaveBeenCalled();
    expect(refreshPaperSource).not.toHaveBeenCalled();
  });

  it('keeps a usable web fallback after the native handler fails without marking the source unavailable', async () => {
    seed(source);
    vi.mocked(isDesktopMode).mockReturnValue(true);
    vi.mocked(openExternalUrl).mockRejectedValue(new Error('No protocol handler'));
    render(<Harness />);
    fireEvent.click(screen.getByRole('link', { name: 'Open in Paper' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not open Paper Desktop. Use Open source link.'));
    expect(screen.queryByText(/Opening this object/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open source link' })).toHaveAttribute('href', 'https://app.paper.design/file/file-a/page-a/logo-a');
    expect(useGraphStore.getState().nodes[0].data.params._paperSource).toBe(source);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(refreshPaperSource).not.toHaveBeenCalled();
  });

  it('uses the explicitly reconnected identity while earlier snapshot links retain their original identity', () => {
    seed({ ...source, identity: { ...identity, objectId: 'logo-b' } });
    render(<Harness />);
    expect(screen.getByRole('link', { name: 'Open in Paper' })).toHaveAttribute('href', 'paper://file/file-a/page-a/logo-b');
    expect(source.snapshots[0].identity.objectId).toBe('logo-a');
  });

  it.each(['../other', 'logo/a', 'logo?redirect=evil', 'logo#evil', 'logo%2Fa', 'logo\n', '', 'a'.repeat(129)])('rejects invalid route identity %s without exposing an external target', (objectId) => {
    seed({ ...source, identity: { ...identity, objectId, openUrl: 'javascript:alert(1)' } });
    render(<Harness />);
    expect(paperObjectLinks({ ...identity, objectId })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open in Paper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open source link' })).not.toBeInTheDocument();
    expect(screen.getByText(/Source links unavailable/)).toBeInTheDocument();
  });

  it('inspects exact IDs before confirmation when Paper has no selection', async () => {
    seed();
    vi.mocked(inspectPaperObject).mockResolvedValue({ file: { id: 'file-a', name: 'Logo file' }, pageId: 'page-a', pageName: 'Page 1', selection: [{ id: 'logo-a', name: 'Editable A', width: 200, height: 100 }] });
    vi.mocked(linkPaperSource).mockResolvedValue(source);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Link object by ID' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Paper fileId' }), { target: { value: 'file-a' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Paper pageId' }), { target: { value: 'page-a' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Paper objectId' }), { target: { value: 'logo-a' } });
    expect(linkPaperSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect exact object' }));
    await screen.findByText('Object bounds: 200 × 100 · logo-a');
    expect(inspectPaperObject).toHaveBeenCalledWith({ fileId: 'file-a', pageId: 'page-a', objectId: 'logo-a' });
    expect(getPaperSelection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export and link' }));
    await screen.findByRole('img', { name: 'Editable A exported from Paper' });
    expect(linkPaperSource).toHaveBeenCalledWith({ fileId: 'file-a', pageId: 'page-a', objectId: 'logo-a', scale: '2x' });
  });
});
