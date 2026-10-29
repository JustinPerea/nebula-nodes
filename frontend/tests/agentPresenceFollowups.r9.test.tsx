/**
 * Fix round 9 of PR #200 (GM r13): a shot's × stays neutral because Undo puts
 * the shot back whole. Cinema Studio replaces the canvas (whose Cmd+Z isn't
 * mounted there), so the studio steps the canvas history itself. The shot's
 * run media coming back is the backend's half
 * (backend/tests/test_cinema_scene_authoring_persistence.py, test_r9_*).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CinemaStudioView } from '../src/components/cinema-studio/CinemaStudioView';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import type { CinemaSceneSpec, NodeData } from '../src/types';
import type { Node } from '@xyflow/react';

vi.mock('../src/components/cinema-studio/CinemaSharedControls', () => ({ CinemaSharedControls: () => null }));
vi.mock('../src/components/cinema-studio/CinemaShotPanel', () => ({ CinemaShotPanel: () => <textarea aria-label="Shot prompt" /> }));
vi.mock('../src/components/cinema-studio/CinemaShotsRail', () => ({ CinemaShotsRail: () => null }));
vi.mock('../src/components/cinema-studio/CinemaStudioToolbar', () => ({ CinemaStudioToolbar: () => null }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };
const spec: CinemaSceneSpec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{ id: 'a', prompt: 'A' }] };
const sceneNode: Node<NodeData> = { id: 'scene-local', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
  data: { label: 'Scene', definitionId: 'cinema-scene', params: { scene: spec }, state: 'idle', outputs: {} } };

describe('GM r13: Undo in Cinema Studio', () => {
  const undo = vi.fn();
  const redo = vi.fn();
  beforeEach(() => {
    undo.mockReset(); redo.mockReset();
    useGraphStore.setState({ ...initialGraph, nodes: [sceneNode], edges: [], undo, redo }, true);
    useUIStore.setState({ ...initialUi, cinemaEditorNodeId: 'scene-local' }, true);
  });
  afterEach(() => {
    cleanup();
    useGraphStore.setState(initialGraph, true);
    useUIStore.setState(initialUi, true);
  });

  it('Cmd+Z undoes and Shift+Cmd+Z redoes the canvas history (a shot\'s × among it)', () => {
    render(<CinemaStudioView />);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'Z', metaKey: true, shiftKey: true });
    expect(redo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(2);
  });

  it('a prompt being typed keeps its own text undo, and Alt+Cmd+Z or a plain z does nothing', () => {
    const { getByLabelText } = render(<CinemaStudioView />);
    fireEvent.keyDown(getByLabelText('Shot prompt'), { key: 'z', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: 'z' });
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    // The same studio does answer Cmd+Z on the page (review 9 NIT-3: without
    // the handler this test passed too), so the field's own undo was a choice.
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('leaves the keys once the studio closes', () => {
    const { unmount } = render(<CinemaStudioView />);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
