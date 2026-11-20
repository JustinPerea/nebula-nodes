import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Cinema shot's failed lines (design): what the shot panel reads when a shot never started, when it started and
 * failed with nothing more said, and the World Labs refusal. `output.error` is the text agents read; the panel reads
 * `errorPerson` or the line in `error` itself, through nodeErrorCopy.
 */

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiFetchMock,
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/components/askPlaceholderRun', () => ({ askPlaceholderRun: vi.fn() }));
const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), setViewing: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {}; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {}; }) } }));

import { useGraphStore, resetDeletedSceneEditsForTests } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import * as api from '../src/lib/api';
import { nodeErrorCopy } from '../src/lib/nodeErrorCopy';
import { OTHER_NODE_LINE, SHOT_FAILED_LINE, SHOT_FAILED_TEXT, SHOT_NOT_STARTED_LINE, SHOT_OTHER_NODE_LINE } from '../src/lib/validationCopy';
import type { CinemaSceneSpec } from '../src/types';

afterEach(() => resetDeletedSceneEditsForTests());

const initialCache = useUIStore.getState().settingsCache;
const scene = { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9', shots: [{ id: 's1', prompt: 'a cat' }] };
const cinemaNode = () => ({ id: 'cine', type: 'cinema-scene', position: { x: 0, y: 0 },
  data: { definitionId: 'cinema-scene', label: 'Scene', params: { scene }, state: 'idle', outputs: {} } });
const output = () => (useGraphStore.getState().nodes.find((n) => n.id === 'cine')?.data.params as { scene: CinemaSceneSpec })
  .scene.shots[0].output;
const panelLine = () => {
  const out = output()!;
  return nodeErrorCopy({ raw: out.error, category: out.errorCategory, friendly: out.errorFriendly, person: out.errorPerson, surface: 'shot' }).reason;
};

describe('the Cinema shot failed lines', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [cinemaNode()] as never, edges: [], undoStack: [], redoStack: [], runHistory: [],
      isExecuting: false, backendFreshStartPending: false, providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null } as never);
    useUIStore.setState({ settingsCache: { apiKeys: { GOOGLE_API_KEY: 'set' }, loaded: true }, runCostConfirmUsd: null } as never);
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.localStorage.clear();
  });
  afterEach(() => {
    useGraphStore.getState().resetExecution();
    useUIStore.setState({ settingsCache: initialCache });
    vi.restoreAllMocks();
  });

  it('the words', () => {
    expect(SHOT_NOT_STARTED_LINE).toBe('Nebula couldn’t start the shot. Check the scene’s inputs and API keys, then generate it again.');
    expect(SHOT_OTHER_NODE_LINE).toBe('Nebula couldn’t start the shot because another node in this run needs a fix first.');
    // The canvas's own nodes keep theirs: OTHER_NODE_LINE is shared with every node's refusal, not only a shot's.
    expect(OTHER_NODE_LINE).toBe('Nothing ran. Another node in this run needs a fix first.');
    expect(SHOT_FAILED_TEXT).toBe('Shot generation failed.');
    expect(SHOT_FAILED_LINE).toBe('Nebula couldn’t generate the shot. Generate it again.');
  });

  it('row 6: a refusal that names no node says the shot did not start', async () => {
    vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'validation_error', errors: [] } as never);
    await useGraphStore.getState().executeShot('cine', 's1');
    expect(output()).toMatchObject({ status: 'error', error: SHOT_NOT_STARTED_LINE, errorPerson: SHOT_NOT_STARTED_LINE });
    expect(panelLine()).toBe('Nebula couldn’t start the shot. Check the scene’s inputs and API keys, then generate it again.');
  });

  it('row 6: a refusal that names only another node says that node needs a fix', async () => {
    vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'validation_error',
      errors: [{ nodeId: 'other', portId: 'prompt', message: 'prompt is required', person: 'Add a prompt.' }] } as never);
    await useGraphStore.getState().executeShot('cine', 's1');
    expect(output()).toMatchObject({ status: 'error', errorPerson: SHOT_OTHER_NODE_LINE });
    expect(panelLine()).toBe('Nebula couldn’t start the shot because another node in this run needs a fix first.');
  });

  it('row 7: a start Nebula answered with another status reads as one sentence, with no “because Try again”', async () => {
    vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'busy' } as never);
    await useGraphStore.getState().executeShot('cine', 's1');
    const said = 'Nebula couldn’t start the shot because the server didn’t accept it. Try again, or reload if it keeps happening.';
    expect(output()).toMatchObject({ status: 'error', error: said });
    expect(panelLine()).toBe(said);
    expect(output()!.error).not.toMatch(/because Try again/);
  });

  it('row 8: a shot whose World Labs environment has not run says so', async () => {
    useGraphStore.setState({
      nodes: [{ id: 'wl', type: 'model-node', position: { x: 0, y: 0 },
        data: { definitionId: 'worldlabs-environment', label: 'World', params: {}, state: 'idle', outputs: {} } }, cinemaNode()] as never,
      edges: [{ id: 'e1', source: 'wl', target: 'cine', sourceHandle: 'world', targetHandle: 'world' }] } as never);
    const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeShot('cine', 's1');
    expect(shot).not.toHaveBeenCalled();
    const said = 'Nebula couldn’t generate the shot because its World Labs environment hasn’t run yet. Run it on the canvas, then generate the shot.';
    expect(output()).toMatchObject({ status: 'error', error: said });
    expect(panelLine()).toBe(said);
  });

  it('row 9: a shot that failed with nothing more said reads “Generate it again.”, and agents still read “Shot generation failed.”', async () => {
    const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeShot('cine', 's1');
    expect(output()?.status).toBe('running');
    const runId = shot.mock.calls[0][6]!;
    useGraphStore.getState().hydrateExecutionStatuses([{ runId, status: 'failed' }]);
    expect(output()).toMatchObject({ status: 'error', error: 'Shot generation failed.', errorPerson: 'Nebula couldn’t generate the shot. Generate it again.' });
    expect(panelLine()).toBe('Nebula couldn’t generate the shot. Generate it again.');
  });

  it('row 9: a failure that came with the backend’s own line keeps it', async () => {
    const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeShot('cine', 's1');
    const runId = shot.mock.calls[0][6]!;
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((n) => (n.id !== 'cine' ? n : { ...n, data: { ...n.data, params: { scene: {
      ...scene, shots: [{ ...scene.shots[0], output: { status: 'running', error: 'fal said no', errorPerson: 'Nebula couldn’t generate the shot because fal said no.' } }] } } } })) } as never));
    useGraphStore.getState().hydrateExecutionStatuses([{ runId, status: 'failed' }]);
    expect(output()).toMatchObject({ error: 'fal said no', errorPerson: 'Nebula couldn’t generate the shot because fal said no.' });
  });

  it('row 9, the sync that arrives after the run settled: the shot still running there becomes the same failure', async () => {
    const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeShot('cine', 's1');
    const runId = shot.mock.calls[0][6]!;
    useGraphStore.getState().hydrateExecutionStatuses([{ runId, status: 'failed' }]);
    const running = { ...cinemaNode(), data: { ...cinemaNode().data, params: { scene: {
      ...scene, shots: [{ ...scene.shots[0], output: { status: 'running' } }] } } } };
    for (const handler of [...socket.handlers]) handler({ type: 'graphSync', nodes: [running], edges: [], empty: false });
    expect(output()).toMatchObject({ status: 'error', error: 'Shot generation failed.', errorPerson: 'Nebula couldn’t generate the shot. Generate it again.' });
  });
});
