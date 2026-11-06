import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

// GM PR #205 r11 (the limit-load shot read "Saving…"): a refused load changes
// nothing, so nothing saves. Nothing in the tab starts a save for it, and a
// save racing the refusal can't write over the open project. The real Load
// path (GraphFileActions → lib/graphFile loadFromFile), the real project
// store with its autosave, and a fetch that records every request.

vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  holdsPersonCredential: () => true,
}));
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(),
  openProject: vi.fn(), createProject: vi.fn(), recoverProject: vi.fn(),
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ fitView: vi.fn(), getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    screenToFlowPosition: (position: { x: number; y: number }) => position }),
  useStore: () => [0, 0, 1],
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));

import { GraphFileActions } from '../src/components/GraphFileActions';
import { requestGraphLoad } from '../src/lib/graphFileActions';
import { subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import type { SavedProject } from '../src/lib/projects';
import * as execution from '../src/lib/api';
import { getBackendBaseUrl } from '../src/lib/backend';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const LOAD = 'Nebula couldn’t load the canvas.';

function brief() {
  return { id: 'brief', type: 'model-node', position: { x: 10, y: 20 },
    data: { definitionId: 'text-input', label: 'Brief', params: { value: 'brief' }, state: 'idle' } };
}

function project(): SavedProject {
  return {
    id: 'alpha', name: 'alpha', createdAt: '2026-10-31T10:00:00Z', updatedAt: '2026-10-31T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [brief()] as never, edges: [], runHistory: [], viewport: { x: 0, y: 0, zoom: 1 }, createSessionId: null },
  };
}

function plainFile(text: string): File {
  return new File([text], 'refused.nebula', { type: 'application/json' });
}

function bundleFile(): File {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])], 'refused.nebula.zip', { type: 'application/zip' });
}

function graphText(raw: string): string {
  return `{"version":3,"name":"x","createdAt":"2026-10-31T00:00:00.000Z","nodes":[],"edges":[],"extra":${raw}}`;
}

const initialProjects = useProjectStore.getState();
let unsubscribe: (() => void) | null = null;
let requests: string[] = [];
let said: string[] = [];
const onNotice = (event: Event) => said.push((event as CustomEvent<CanvasNoticeDetail>).detail.text);

beforeAll(async () => { await getBackendBaseUrl(); });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], providerRecoveries: [], providerStartAmbiguities: [],
    isExecuting: false, isImportingGraph: false, createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initialProjects, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION } as never);
  vi.mocked(projects.getProject).mockImplementation(async () => project());
  vi.mocked(projects.saveProject).mockImplementation(async (_id, snapshot) => ({ ...project(), snapshot }));
  requests = [];
  said = [];
  window.addEventListener(CANVAS_NOTICE_EVENT, onNotice);
});

afterEach(async () => {
  window.removeEventListener(CANVAS_NOTICE_EVENT, onNotice);
  cleanup();
  unsubscribe?.(); unsubscribe = null;
  await Promise.resolve();
  setProjectContext(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'showOpenFilePicker');
});

async function refusedLoad(file: File, restoreAnswer?: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
    if (url.includes('/api/outputs/restore') && restoreAnswer) return restoreAnswer();
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  await useProjectStore.getState().initialize();
  unsubscribe = subscribeProjectAutosave();
  await vi.waitFor(() => expect(useProjectStore.getState().saveStatus).toBe('saved'));
  const before = JSON.stringify(useGraphStore.getState().nodes);
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
  });
  render(<GraphFileActions />);
  await act(async () => { requestGraphLoad(); });
  await vi.waitFor(() => expect(said.length).toBe(1));
  // Past the autosave wait (600 ms), so a save it started would have gone.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
  return { before };
}

function expectNothingSaved(before: string) {
  expect(JSON.stringify(useGraphStore.getState().nodes)).toBe(before);
  expect(projects.saveProject).not.toHaveBeenCalled();
  expect(requests.filter((request) => !request.startsWith('GET ') && !request.startsWith('POST /api/outputs/restore'))).toEqual([]);
  expect(useProjectStore.getState()).toMatchObject({ saveStatus: 'saved', dirty: false });
}

describe('a refused load starts no save (GM PR #205 r11)', () => {
  it('a plain file too complex to open', async () => {
    const { before } = await refusedLoad(plainFile(graphText('['.repeat(80) + ']'.repeat(80))));
    expect(said).toEqual([`${LOAD} This file is too complex to open.`]);
    expectNothingSaved(before);
  });

  it('a plain file with a value Nebula can’t read', async () => {
    const { before } = await refusedLoad(plainFile(graphText('1e999')));
    expect(said).toEqual([`${LOAD} Part of this file holds a value Nebula can’t read.`]);
    expectNothingSaved(before);
  });

  it('a bundle the restore refuses as too complex', async () => {
    const { before } = await refusedLoad(bundleFile(), () => new Response(JSON.stringify(
      { detail: 'graph.json is nested too deeply', code: 'graph_too_complex' }), { status: 400 }));
    expect(said).toEqual([`${LOAD} This file is too complex to open.`]);
    expect(requests).toContain('POST /api/outputs/restore');
    expectNothingSaved(before);
  });

  it('a bundle the restore refuses for a value it can’t read', async () => {
    const { before } = await refusedLoad(bundleFile(), () => new Response(JSON.stringify(
      { detail: 'graph.json contains a non-finite number', code: 'graph_unreadable_value' }), { status: 400 }));
    expect(said).toEqual([`${LOAD} Part of this file holds a value Nebula can’t read.`]);
    expectNothingSaved(before);
  });

  it('control: an edit does save, through the same autosave', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await useProjectStore.getState().initialize();
    unsubscribe = subscribeProjectAutosave();
    act(() => {
      useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) => ({ ...node, position: { x: 300, y: 40 } })) });
    });
    await vi.waitFor(() => expect(projects.saveProject).toHaveBeenCalledTimes(1));
  });
});
