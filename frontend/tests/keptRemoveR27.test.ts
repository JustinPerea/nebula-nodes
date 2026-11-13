/**
 * PR #199 round 27 (final review, HIGH-1): while the canvas is kept, the store never deletes the project it
 * is on or the one its edits came from, so no caller (the chooser, Projects home, anything) can release
 * the kept canvas through remove(). Other projects delete as always.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}),
  disconnect: vi.fn(), send: vi.fn(), setViewing: vi.fn(), notePersonAct: vi.fn(), setKeptEdits: vi.fn() } }));
vi.mock('../src/lib/projects', async (original) => ({ ...await original<typeof import('../src/lib/projects')>(), deleteProject: vi.fn() }));
import { resetProjectStoreForTests, useProjectStore } from '../src/store/projectStore';
import { keepCanvasLocally, useGraphStore } from '../src/store/graphStore';
import { isCanvasKept, resetKeptCanvasForTests } from '../src/lib/keptCanvas';
import { setProjectContext } from '../src/lib/projectContext';
import { KEPT_SOURCE_DELETE_LINE } from '../src/components/projects/restoreCopyCore';
import * as projects from '../src/lib/projects';

const summary = (id: string, name: string) => ({ id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
  lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null });

function keptCanvas(sourceId: string) {
  vi.mocked(projects.deleteProject).mockResolvedValue({ trashedProject: { ...summary('x', 'X'), deletedAt: '2026-10-09T10:00:00Z', purgeAt: '2026-11-09T10:00:00Z' }, workspaceRevision: 'r2' } as never);
  setProjectContext({ id: 'p', projectId: 'p', revision: 'x' } as never);
  useGraphStore.setState({ nodes: [{ id: 'tab-1', type: 'model', position: { x: 0, y: 0 }, data: { label: 'unsaved edit' } } as never], edges: [] });
  keepCanvasLocally();
  useProjectStore.setState({ initialized: true, busy: false, screen: 'workspace', workspaceRevision: 'r1',
    activeProject: summary('p', 'Dunes') as never, projects: [summary('p', 'Dunes'), summary('q', 'Glass'), summary('s', 'Source')] as never,
    keptEdits: { sourceId, sourceName: 'Dunes', lead: null, saving: false, error: 'limit', chooseToDelete: 'projects', limitCounts: { count: 3, limit: 3, deletes: 1 } } });
}

beforeEach(() => { vi.clearAllMocks(); resetProjectStoreForTests(); resetKeptCanvasForTests(); setProjectContext(null); });

describe('remove() while the canvas is kept', () => {
  it('refuses the active project: nothing is sent, the canvas and kept mode stay, and the line says why', async () => {
    keptCanvas('p');
    await useProjectStore.getState().remove('p');
    const state = useProjectStore.getState();
    expect(projects.deleteProject).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(isCanvasKept()).toBe(true);
    expect(state.keptEdits?.sourceId).toBe('p');
    expect(state.activeProject?.id).toBe('p');
    expect(state.projects).toHaveLength(3);
    expect(state.error).toBe(`Couldn’t delete the project. ${KEPT_SOURCE_DELETE_LINE}`);
    expect(state.errorRetry).toBeNull();
    expect(state.busy).toBe(false);
  });

  it('refuses the project the edits came from even when another project is the active one', async () => {
    keptCanvas('s');
    await useProjectStore.getState().remove('s');
    expect(projects.deleteProject).not.toHaveBeenCalled();
    expect(isCanvasKept()).toBe(true);
    expect(useProjectStore.getState().projects.map((project) => project.id)).toContain('s');
    expect(useProjectStore.getState().error).toContain(KEPT_SOURCE_DELETE_LINE);
  });

  it('still deletes any other project, and the kept canvas keeps its edits', async () => {
    keptCanvas('p');
    await useProjectStore.getState().remove('q');
    const state = useProjectStore.getState();
    expect(projects.deleteProject).toHaveBeenCalledTimes(1);
    expect(state.projects.map((project) => project.id)).toEqual(['p', 's']);
    expect(state.lastDeleted?.id).toBe('q');
    expect(isCanvasKept()).toBe(true);
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(state.keptEdits).not.toBeNull();
  });

  it('deletes the open project as before when nothing is kept', async () => {
    keptCanvas('p');
    resetKeptCanvasForTests();
    useGraphStore.getState().releaseGraphImport?.({ discardSuspended: true });
    useProjectStore.setState({ keptEdits: null });
    await useProjectStore.getState().remove('p');
    expect(projects.deleteProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().activeProject).toBeNull();
  });
});
