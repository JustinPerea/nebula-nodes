/**
 * Error copy round 3f (GM - Design): GM's general line split by surface, the
 * Cinema shot panel's heading, and the shared lines GM rewrote.
 *
 * GM: "Couldn't run the node." followed by "That didn't work." says the same
 * thing twice, and reloading doesn't fix a provider failure.
 * - On node cards and the Cinema shot panel → "Run the node again. If it
 *   keeps failing, Details shows what {Provider} said." With no provider:
 *   "Run the node again. If it keeps failing, open Details."
 * - Under any other heading (Projects, graph file, Commons…), drop "That
 *   didn't work." → "Try again, or reload if it keeps happening."
 *
 * The card knows the provider from the run (the backend's ErrorEvent
 * `provider`, from the route the node called; node data `errorProvider`),
 * never from the error's text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData } from '../src/types';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({ ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../src/lib/commonsApi', () => ({ commonsApi: {}, commonsEvaluationApi: {}, commonsReviewApi: {}, filtersToRequest: vi.fn() }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import * as errorCopy from '../src/lib/errorCopy';
import { nodeErrorCopy } from '../src/lib/nodeErrorCopy';
import { NodeError } from '../src/components/nodes/NodeError';
import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { StatusLine } from '../src/components/commons/CommonsView';
import type { CommonsStatus } from '../src/lib/commonsTypes';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCinemaMotionStore } from '../src/store/cinemaMotionStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { RUNTIME_FIELDS } from '../src/lib/canvasUndo';
import { NOTHING_RAN_LINE } from '../src/lib/validationCopy';
import { notReadyLine } from '../src/lib/canvasProposals';
import { WORLD_LABS_RECONNECTING_NOTE } from '../src/lib/runHistory';
import { saveToFolder } from '../src/lib/createFiles';

const RUN_HEADING = "Couldn't run the node.";
const SHOT_HEADING = "Couldn't generate the shot.";
const CARD_PROVIDER = 'Run the node again. If it keeps failing, Details shows what fal.ai said.';
const CARD_PLAIN = 'Run the node again. If it keeps failing, open Details.';
const ELSEWHERE = 'Try again, or reload if it keeps happening.';
const SERVER = "Nebula's server isn't answering. Make sure it's running, then try again.";
const RAW = 'FAL submit failed (500): {"detail":"upstream exploded","request_id":"req_123"}';

const heading = (root: ParentNode) => root.querySelector('.failure-lines__heading')?.textContent ?? null;
const reason = (root: ParentNode) => root.querySelector('.failure-lines__reason')?.textContent ?? null;

const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };
afterEach(() => {
  cleanup();
  useCinemaMotionStore.getState().clear();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUi, true);
  mocks.fetch.mockReset();
});

describe('GM\'s general line under any other heading', () => {
  it('drops "That didn\'t work."', () => {
    expect(errorCopy.REFUSED_FALLBACK_COPY).toBe(ELSEWHERE);
    expect(errorCopy.copyForError(new Error('internal'))).toBe(ELSEWHERE);
  });

  it('a request with no answer says the server on this computer isn\'t answering', () => {
    expect(errorCopy.CONNECTION_LOST_COPY).toBe(SERVER);
    expect(errorCopy.copyForError(new errorCopy.ConnectionLostError(new TypeError('Failed to fetch')))).toBe(SERVER);
    // typeerror (2026-10-24): a TypeError nothing classified is a browser-side failure, not no answer.
    expect(errorCopy.copyForError(new TypeError('Failed to fetch'))).toBe(ELSEWHERE);
    // GM's WRAP rule: beside a Try again button, the line drops its "try again".
    expect(errorCopy.shortReason(SERVER)).toBe("Nebula's server isn't answering. Make sure it's running.");
    expect(errorCopy.shortLine(`Couldn't load the board. ${SERVER}`))
      .toBe("Couldn't load the board. Nebula's server isn't answering. Make sure it's running.");
  });
});

describe('the node card\'s general line', () => {
  it('names the provider the run called, from the run', () => {
    expect(nodeErrorCopy({ raw: RAW, category: 'unknown', friendly: RAW.slice(0, 40), provider: 'fal.ai' }))
      .toEqual({ heading: RUN_HEADING, reason: CARD_PROVIDER, details: RAW });
  });

  it('says "open Details" when the run named no provider', () => {
    expect(nodeErrorCopy({ raw: RAW, category: 'unknown' }))
      .toEqual({ heading: RUN_HEADING, reason: CARD_PLAIN, details: RAW });
  });

  it('never reads the provider from the error\'s text', () => {
    expect(nodeErrorCopy({ raw: 'Replicate prediction failed', category: 'unknown' }).reason).toBe(CARD_PLAIN);
  });

  it('keeps a line the person can act on', () => {
    const person = 'Add your fal.ai API key in Settings, then run the node again.';
    expect(nodeErrorCopy({ raw: RAW, category: 'auth', person, provider: 'fal.ai' }).reason).toBe(person);
    const friendly = 'fal.ai is having trouble right now. Try again in a few minutes.';
    expect(nodeErrorCopy({ raw: RAW, category: 'network', friendly, provider: 'fal.ai' }).reason).toBe(friendly);
  });

  it('renders on the card with the provider\'s words behind a closed Details', () => {
    const { container } = render(<NodeError raw={RAW} category="unknown" provider="fal.ai" />);
    expect(heading(container)).toBe(RUN_HEADING);
    expect(reason(container)).toBe(CARD_PROVIDER);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('req_123');
  });
});

describe('the store carries the run\'s provider with its error, and never past it', () => {
  const node = (id: string, extra: Partial<NodeData> = {}): Node<NodeData> => ({
    id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: id, definitionId: 'flux-2-pro', params: {}, state: 'idle', outputs: {}, ...extra },
  });
  const send = (event: Record<string, unknown>) =>
    useGraphStore.getState().handleExecutionEvent(event as unknown as ExecutionEvent);
  const data = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.data;

  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [node('n2')], edges: [] });
  });

  it('comes with the error event', () => {
    send({ type: 'error', nodeId: 'n2', error: RAW, category: 'unknown', provider: 'fal.ai', retryable: false });
    expect(data('n2')).toMatchObject({ errorProvider: 'fal.ai' });
  });

  it('a later error without one drops it', () => {
    send({ type: 'error', nodeId: 'n2', error: RAW, category: 'unknown', provider: 'fal.ai', retryable: false });
    send({ type: 'error', nodeId: 'n2', error: 'No mask painted yet', category: 'unknown', retryable: false });
    expect(data('n2').errorProvider).toBeUndefined();
  });

  it("a pre-run check's message drops it", () => {
    send({ type: 'error', nodeId: 'n2', error: RAW, category: 'unknown', provider: 'fal.ai', retryable: false });
    send({ type: 'validationError', errors: [{ nodeId: 'n2', portId: '', message: 'Missing API key: FAL_KEY' }] });
    expect(data('n2').errorProvider).toBeUndefined();
  });

  it("a reload's graph sync brings it back with the error, whole", () => {
    const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, edges: [], empty: false,
      nodes: [node('n2', { state: 'error', error: RAW, errorCategory: 'unknown', errorProvider: 'fal.ai' })] };
    for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event as unknown as ExecutionEvent);
    expect(data('n2')).toMatchObject({ errorProvider: 'fal.ai' });
  });

  it('is part of the run state canvas undo leaves alone', () => {
    expect(RUNTIME_FIELDS as readonly string[]).toContain('errorProvider');
  });
});

// -- the Cinema shot panel -------------------------------------------------------

function scene(output: NonNullable<CinemaSceneSpec['shots'][number]['output']>): CinemaSceneSpec {
  return { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{ id: 'a', prompt: 'Logo', output }] };
}
function shotPanel(output: NonNullable<CinemaSceneSpec['shots'][number]['output']>) {
  const spec = scene(output);
  const node: Node<NodeData> = { id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 }, data: { label: 'Scene',
    definitionId: 'cinema-scene', params: { scene: spec }, state: 'error', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [], isImportingGraph: false, isShotAdmissionBlocked: () => false });
  useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
  return render(<CinemaShotPanel cinemaNodeId="n1" scene={spec} shot={spec.shots[0]} onChangeShot={vi.fn()} />);
}

describe('the Cinema shot panel', () => {
  it('heads a failed shot "Couldn\'t generate the shot." over the provider\'s general line', () => {
    const { container } = shotPanel({ status: 'error', error: RAW.slice(0, 40), errorCategory: 'unknown',
      errorRaw: RAW, errorProvider: 'BytePlus' });
    const error = container.querySelector('.cinema-shot-panel__error')!;
    expect(heading(error)).toBe(SHOT_HEADING);
    // Round 3g (GM): the shot panel's own wording.
    expect(reason(error)).toBe('Generate the shot again. If it keeps failing, Details shows what BytePlus said.');
    expect(error.querySelector('details')!.textContent).toContain('req_123');
  });

  it('keeps the handler\'s line under the shot heading', () => {
    const line = 'Connect a prompt to this node, then run it again.';
    const { container } = shotPanel({ status: 'error', error: 'prompt is required', errorCategory: 'unknown', errorPerson: line });
    const error = container.querySelector('.cinema-shot-panel__error')!;
    expect(heading(error)).toBe(SHOT_HEADING);
    expect(reason(error)).toBe(line);
  });

  it('the motion handoff with no answer says Nebula didn\'t respond, without a second "Couldn\'t"', async () => {
    mocks.fetch.mockImplementationOnce(async () => { throw new errorCopy.ConnectionLostError(new TypeError('Failed to fetch')); });
    shotPanel({ status: 'done', imageUrl: '/api/outputs/a.png' });
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, data: { ...node.data,
      state: 'complete', outputs: { shot_a: { type: 'Image', value: '/api/outputs/a.png' } } } })) }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to motion' })); });
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't confirm the video connection. Nebula didn't respond.");
  });
});

// -- other shared lines ---------------------------------------------------------

describe('the shared lines GM rewrote', () => {
  it('a refused run says "run the node again" (rule 8)', () => {
    expect(NOTHING_RAN_LINE).toBe('Nothing ran. Check the inputs and API keys, then run the node again.');
  });

  it('World Labs: you can\'t run it again until Nebula hears back', () => {
    expect(WORLD_LABS_RECONNECTING_NOTE).toBe('Reconnecting to this World Labs run. You can\'t run it again until Nebula hears back about it.');
  });

  it('a proposal\'s node that can\'t run here reads the person\'s line, not find_nodes\' words', () => {
    expect(notReadyLine({ ref: '+img', nodeId: null, name: 'GPT Image 2', missing: 'needs OPENAI_API_KEY in Settings > Providers',
      person: 'GPT Image 2 needs your OpenAI API key. Add it in Settings.' }))
      .toBe('GPT Image 2 needs your OpenAI API key. Add it in Settings.');
  });

  it('Create Studio saves "the output"', async () => {
    // apiFetch says "no answer" as a ConnectionLostError (lib/backend.ts).
    mocks.fetch.mockImplementationOnce(async () => { throw new errorCopy.ConnectionLostError(new TypeError('Failed to fetch')); });
    const error = await saveToFolder('/api/outputs/a.png').catch((caught: unknown) => caught);
    expect(errorCopy.failureCopy(error)).toEqual({ heading: "Couldn't save the output.", reason: SERVER });
  });

  it('Create Studio can\'t start a generation during a graph import', async () => {
    useGraphStore.setState({ isImportingGraph: true });
    const error = await useGraphStore.getState().authorGenerationCluster({ definitionId: 'flux-2-pro' } as never)
      .catch((caught: unknown) => caught);
    // GM, PR #205 r1: the refused action's lock line, standing alone.
    expect(errorCopy.failureCopy(error)).toEqual({ heading: '',
      reason: 'You can start the generation when the import finishes.' });
  });
});

// -- the Commons tooltips ---------------------------------------------------------

describe('the Commons status tooltips', () => {
  const status = (patch: Partial<CommonsStatus>): CommonsStatus => ({
    worker: { state: 'idle', running: true, budget_used: 0, budget: null },
    meter: { calls: 0, cap: 20, remaining: 20, resets_at: '2026-09-28T00:00:00Z' },
    queue: { queued: 0, analyzing: 0, analysis_failed: 0, held: 0, ready: 0 }, load: 1, load_threshold: 8, ...patch,
  });
  const title = (value: CommonsStatus) => {
    const { container } = render(<StatusLine status={value} onStart={vi.fn()} onStop={vi.fn()} />);
    const label = container.querySelector<HTMLElement>('.commons-status__text')!;
    return { text: label.textContent ?? '', title: label.getAttribute('title') ?? '' };
  };

  it.each([
    [new Date(2026, 8, 28, 0, 0), '12:00 AM'],
    [new Date(2026, 8, 28, 13, 5), '1:05 PM'],
    [new Date(2026, 8, 28, 12, 30), '12:30 PM'],
  ])('the daily cap resumes at local time written like "12:00 AM" (%s)', (resets, written) => {
    const line = title(status({ worker: { state: 'cap_reached', running: true, budget_used: 0, budget: null },
      meter: { calls: 20, cap: 20, remaining: 0, resets_at: resets.toISOString() } }));
    expect(line.title).toBe(`Library analysis is paused. It made 20 analysis calls today, and Settings has “Analysis calls per day” at 20. It resumes on its own at ${written}.`);
    expect(line.text).toBe(`Paused until ${written} · daily cap`);
  });

  it('writes the time the same way in every locale', () => {
    // The browser's own format is "00:00" in many locales, and "12:00\u202fAM"
    // (a narrow space) in newer ones: neither is GM's "12:00 AM".
    vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('00:00');
    const line = title(status({ worker: { state: 'cap_reached', running: true, budget_used: 0, budget: null },
      meter: { calls: 20, cap: 20, remaining: 0, resets_at: new Date(2026, 8, 28, 0, 0).toISOString() } }));
    expect(line.title).toMatch(/It resumes on its own at 12:00 AM\.$/);
    vi.restoreAllMocks();
  });

  it('a busy computer: GM\'s words, no "load average"', () => {
    const line = title(status({ worker: { state: 'paused_load', running: true, budget_used: 0, budget: null }, load: 41.5, load_threshold: 32 }));
    expect(line.title).toBe('Library analysis is paused while this computer is busy. Its load is 41.5, above the 32 set in “Pause above load” in Settings. It resumes on its own when the load drops.');
  });
});
