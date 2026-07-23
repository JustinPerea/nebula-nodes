import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RemotionEditorToolbar } from '../../src/components/video-editor/RemotionEditorToolbar';

const renderJobMock = vi.hoisted(() => ({
  job: null as null | {
    id: string;
    kind: 'remotion';
    status: 'running' | 'complete' | 'failed' | 'cancelled';
    progress: number;
    outputUrl: string | null;
    error: string | null;
  },
  error: null as string | null,
  begin: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('../../src/hooks/useRenderJob', () => ({
  useRenderJob: () => renderJobMock,
}));

const addMock = vi.fn();
const deleteMock = vi.fn();
const reorderMock = vi.fn();
let mockTimelineIds: string[] = [];

vi.mock('../../src/store/graphStore', () => ({
  useGraphStore: (selector: (s: {
    addTrackItemWithCanvasMirror: typeof addMock;
    deleteTrackItem: typeof deleteMock;
    reorderTrackItem: typeof reorderMock;
    nodes: Array<{
      id: string;
      data: { params: { manifest: { timeline: Array<{ id: string }> } } };
    }>;
  }) => unknown) =>
    selector({
      addTrackItemWithCanvasMirror: addMock,
      deleteTrackItem: deleteMock,
      reorderTrackItem: reorderMock,
      nodes: [
        {
          id: 'r1',
          data: {
            params: {
              manifest: {
                timeline: mockTimelineIds.map((id) => ({ id })),
              },
            },
          },
        },
      ],
    }),
}));

let mockSelectedId: string | null = null;
let mockIsRecording = false;
const setSelectedMock = vi.fn();
const toggleRecordingMock = vi.fn();
vi.mock('../../src/store/uiStore', () => ({
  useUIStore: (selector: (s: {
    selectedTrackItemId: string | null;
    setSelectedTrackItem: typeof setSelectedMock;
    isKeyframeRecording: boolean;
    toggleKeyframeRecording: typeof toggleRecordingMock;
  }) => unknown) =>
    selector({
      selectedTrackItemId: mockSelectedId,
      setSelectedTrackItem: setSelectedMock,
      isKeyframeRecording: mockIsRecording,
      toggleKeyframeRecording: toggleRecordingMock,
    }),
}));

describe('RemotionEditorToolbar', () => {
  beforeEach(() => {
    addMock.mockReset();
    deleteMock.mockReset();
    reorderMock.mockReset();
    setSelectedMock.mockReset();
    toggleRecordingMock.mockReset();
    mockSelectedId = null;
    mockIsRecording = false;
    mockTimelineIds = [];
    renderJobMock.job = null;
    renderJobMock.error = null;
    renderJobMock.begin.mockReset();
    renderJobMock.cancel.mockReset();
    renderJobMock.reset.mockReset();
  });

  it('renders six add buttons', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    expect(screen.getByRole('button', { name: /\+ text/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ svg/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ image/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ video/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ iso block/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ lottie/i })).toBeInTheDocument();
  });

  it('+ Text dispatches addTrackItemWithCanvasMirror with TextNode', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ text/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'TextNode' }));
  });

  it('+ Image dispatches with ImageAssetNode', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ image/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'ImageAssetNode' }));
  });

  it('+ Iso Block dispatches addTrackItemWithCanvasMirror with IsometricBlock', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ iso block/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'IsometricBlock' }));
  });

  it('+ Lottie dispatches addTrackItemWithCanvasMirror with LottieNode', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ lottie/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'LottieNode' }));
  });

  it('Delete button is disabled when nothing is selected', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const del = screen.getByRole('button', { name: /delete/i });
    expect(del).toBeDisabled();
  });

  it('Delete button dispatches deleteTrackItem AND clears selection when a TrackItem is selected', () => {
    mockSelectedId = 'track-1';
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const del = screen.getByRole('button', { name: /delete/i });
    expect(del).not.toBeDisabled();
    fireEvent.click(del);
    expect(deleteMock).toHaveBeenCalledWith('r1', 'track-1');
    expect(setSelectedMock).toHaveBeenCalledWith(null);
  });

  it('Z-order buttons are disabled when nothing is selected', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    expect(screen.getByRole('button', { name: /to back/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^back$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^forward$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /to front/i })).toBeDisabled();
  });

  it('Z-order buttons dispatch reorderTrackItem for the selected layer', () => {
    mockSelectedId = 'track-1';
    mockTimelineIds = ['track-0', 'track-1', 'track-2'];
    render(<RemotionEditorToolbar remotionNodeId="r1" />);

    fireEvent.click(screen.getByRole('button', { name: /^forward$/i }));

    expect(reorderMock).toHaveBeenCalledWith('r1', 'track-1', 'bring-forward');
  });

  it('Z-order buttons disable impossible endpoint moves', () => {
    mockSelectedId = 'track-0';
    mockTimelineIds = ['track-0', 'track-1', 'track-2'];
    const { rerender } = render(<RemotionEditorToolbar remotionNodeId="r1" />);
    expect(screen.getByRole('button', { name: /to back/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^back$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^forward$/i })).not.toBeDisabled();

    mockSelectedId = 'track-2';
    rerender(<RemotionEditorToolbar remotionNodeId="r1" />);
    expect(screen.getByRole('button', { name: /to front/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^forward$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^back$/i })).not.toBeDisabled();
  });

  it('REC button toggles keyframe recording', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const rec = screen.getByRole('button', { name: /rec/i });
    expect(rec).toHaveClass('remotion-editor-toolbar__record');
    expect(rec).not.toHaveClass('remotion-editor-toolbar__record--active');
    fireEvent.click(rec);
    expect(toggleRecordingMock).toHaveBeenCalledTimes(1);
  });

  it('REC button reflects active recording state', () => {
    mockIsRecording = true;
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const rec = screen.getByRole('button', { name: /rec/i });
    expect(rec).toHaveClass('remotion-editor-toolbar__record--active');
    expect(rec).toHaveAttribute('title', 'Recording keyframes - click to stop');
  });

  it('closing a running export popover does not orphan the job state', () => {
    renderJobMock.job = {
      id: 'job-1',
      kind: 'remotion',
      status: 'running',
      progress: 0.4,
      outputUrl: null,
      error: null,
    };
    render(<RemotionEditorToolbar remotionNodeId="r1" />);

    const exportButton = screen.getByRole('button', { name: /^export$/i });
    fireEvent.click(exportButton);
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();

    fireEvent.click(exportButton);
    expect(screen.queryByRole('dialog', { name: /remotion h\.264 export/i })).not.toBeInTheDocument();
    expect(renderJobMock.reset).not.toHaveBeenCalled();
  });

  it('offers an explicit reset after a completed render', () => {
    renderJobMock.job = {
      id: 'job-2',
      kind: 'remotion',
      status: 'complete',
      progress: 1,
      outputUrl: '/api/outputs/run/final.mp4',
      error: null,
    };
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));

    expect(screen.getByRole('link', { name: /download mp4/i })).toHaveAttribute(
      'href',
      '/api/outputs/run/final.mp4',
    );
    fireEvent.click(screen.getByRole('button', { name: /new render/i }));
    expect(renderJobMock.reset).toHaveBeenCalledTimes(1);
  });
});
