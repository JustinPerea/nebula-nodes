import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fix round 6 of PR #199 (GM r7, "attribute the row to the agent"; review 6,
// N-3): the waiting canvas's held and refused lines are the agent's own rows
// in the Agent log, with its name and colour, so filtering the log to Codex
// shows what Codex tried. An unnamed agent's stays Nebula's. And the
// listing's restore verdict, counted lines and saved names reach the store.

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  listProjects: vi.fn(),
}));

import * as api from '../lib/projects';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import { useAgentLogStore } from './agentLogStore';
import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';

const listProjects = vi.mocked(api.listProjects);

const send = (event: Record<string, unknown>) => {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  handler(event as never);
};

beforeEach(() => {
  resetProjectStoreForTests();
  useAgentLogStore.getState().clear();
  listProjects.mockReset().mockResolvedValue({ projects: [], trash: [], activeProjectId: null, workspaceRevision: 'r1',
    paramsVersion: GRAPH_PARAMS_VERSION, projectLimit: 3 } as never);
  useProjectStore.setState({ screen: 'home', initialized: true, busy: false, activeProject: null, workspaceRevision: 'r1',
    projects: [], trash: [], dirty: false, saveStatus: 'saved', error: null, projectLimit: 3 } as never);
  subscribeProjectAutosave();
});

describe("N-3: the Agent log row is the agent's", () => {
  it("files Codex's refused change under Codex", () => {
    send({ type: 'projectsChanged', change: 'canvasHoldRefused', projectId: null,
      canvasHeld: { action: 'change', agent: 'Codex', agentId: 'ext:codex', color: '#5B9DFF' } });
    const codex = useAgentLogStore.getState().entries.filter((entry) => entry.agent?.id === 'ext:codex');
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({ source: 'agent', agent: { id: 'ext:codex', name: 'Codex', color: '#5B9DFF' },
      message: "Codex tried to change the canvas you had open. Nebula stopped it because that canvas isn't saved as a project yet." });
  });

  it("files Codex's held change under Codex too", () => {
    send({ type: 'projectsChanged', change: 'canvasHeld', projectId: null,
      canvasHeld: { action: 'changed', agent: 'Codex', agentId: 'ext:codex', color: 'not-a-colour' } });
    const [entry] = useAgentLogStore.getState().entries;
    expect(entry.agent?.name).toBe('Codex');
    expect(entry.agent?.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(entry.message).toBe('Codex changed the canvas. The one you had open is kept until Nebula can save it as a project.');
  });

  it("keeps an unnamed agent's line as Nebula's", () => {
    send({ type: 'projectsChanged', change: 'canvasHoldRefused', projectId: null, canvasHeld: { action: 'clear', agent: null } });
    const [entry] = useAgentLogStore.getState().entries;
    expect(entry.source).toBe('system');
    expect(entry.agent).toBeUndefined();
  });
});

describe("the listing's round 6 fields reach the store", () => {
  it('keeps the restore verdict, the waiting canvases, the unreadable note and every filed name', async () => {
    listProjects.mockResolvedValueOnce({ projects: [], trash: [], activeProjectId: null, workspaceRevision: 'r2',
      paramsVersion: GRAPH_PARAMS_VERSION, projectLimit: 3,
      restoreRoom: { refused: 'projects', deletes: 2, heldTakesPlace: false, waiting: 1 },
      canvasNotFiled: { reason: 'projects', projectLimit: 3, live: true, held: 1, canvases: [{ name: 'Delta' }, { name: null }] },
      canvasHeldUnreadable: { count: null, kept: ['canvas-held.json.damaged-x'], at: '2026-10-28T10:00:00Z' },
      canvasSaved: { id: 'b', name: 'Recovered canvas 2', filed: [{ id: 'a', name: 'Recovered canvas' }, { id: 'b', name: 'Recovered canvas 2' }] },
    } as never);
    send({ type: 'projectsChanged', change: 'deleted', projectId: 'x' });
    await vi.waitFor(() => expect(useProjectStore.getState().restoreRoom).not.toBeNull());
    const state = useProjectStore.getState();
    expect(state.restoreRoom).toEqual({ refused: 'projects', deletes: 2, heldTakesPlace: false, waiting: 1 });
    expect(state.canvasNotFiled?.canvases).toEqual([{ name: 'Delta' }, { name: null }]);
    // `at` keys the person's × (GM r9, fix round 8).
    expect(state.canvasHeldUnreadable).toEqual({ count: null, at: '2026-10-28T10:00:00Z' });
    expect(state.canvasSaved?.filed?.map((row) => row.name)).toEqual(['Recovered canvas', 'Recovered canvas 2']);
  });
});
