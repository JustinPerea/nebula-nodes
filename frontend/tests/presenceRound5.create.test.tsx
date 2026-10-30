/**
 * PR #204 round 5, review 3 MEDIUM-1: Create's two lines, Generate's and Save style's, refused
 * only because this tab isn't connected as the person, clear on the promote. Through the real
 * request path: fetch answers 403 person_required, the cluster's FailureNotice carries the
 * refusal's code (and when it was sent), CreateView registers the line. A line with another
 * reason stays.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}) } }));
vi.mock('../src/components/create-studio/CreateComposer', () => ({
  CreateComposer: ({ onGenerate, onOpenStyles }: { onGenerate: () => void; onOpenStyles: () => void }) => (
    <><button type="button" onClick={onGenerate}>Generate</button><button type="button" onClick={onOpenStyles}>Styles</button></>
  ),
}));
vi.mock('../src/components/create-studio/PresetLibrary', () => ({
  PresetLibrary: ({ onSaveCurrent }: { onSaveCurrent: () => void }) => <button type="button" onClick={onSaveCurrent}>Save current style</button>,
}));
vi.mock('../src/components/create-studio/ReferenceTray', () => ({ ReferenceTray: () => null }));
vi.mock('../src/components/create-studio/ResultsGallery', () => ({ ResultsGallery: () => null }));
vi.mock('../src/hooks/usePrompt', () => ({ usePrompt: () => [async () => 'My style', null] }));

const { CreateView } = await import('../src/components/create-studio/CreateView');
const { useGraphStore } = await import('../src/store/graphStore');
const { useUIStore } = await import('../src/store/uiStore');
const { useCreateDraftStore } = await import('../src/store/createDraftStore');
const session = await import('../src/lib/personSession');
const { pendingPromoteClears } = await import('../src/lib/clearsOnPromote');
const { publishOpenProject } = await import('../src/lib/currentProject');

const PERSON_LINE = 'isn’t connected as you';
const answers = new Map<string, { status: number; body: unknown }>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const initialUI = { ...useUIStore.getState() };

beforeEach(() => {
  session.resetPersonSessionForTests();
  useGraphStore.getState().resetExecution();
  localStorage.clear();
  useCreateDraftStore.setState({ drafts: {} });
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], providerStartAmbiguities: [], createLaunchingIds: [], undoNotice: null, messageNotice: null });
  useUIStore.setState({ createSessionId: 'create-session', viewMode: 'create' });
  answers.clear();
  publishOpenProject({ id: 'p1', name: 'Followups' });
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url), 'http://x').pathname;
    const answer = answers.get(`${String(init?.method ?? 'GET').toUpperCase()} ${path}`);
    return answer ? json(answer.status, answer.body) : json(200, path === '/api/presets' ? [] : {});
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  publishOpenProject(null);
  session.notePersonPromoted();
  useGraphStore.getState().resetExecution();
  useUIStore.setState(initialUI, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const gate = { status: 403, body: { detail: 'Only the person can do this.', code: 'person_required' } };
const alerts = () => screen.queryAllByRole('alert').map((node) => node.textContent ?? '');

describe('review 3 MEDIUM-1: Create\'s lines clear on the promote', () => {
  it('Generate refused by the gate: the line shows, and goes on the promote', async () => {
    answers.set('POST /api/graph/cluster', gate);
    session.reportPersonRequired();
    render(<CreateView />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate' })); });
    await waitFor(() => expect(alerts().some((line) => line.includes(PERSON_LINE))).toBe(true));
    expect(pendingPromoteClears()).toBeGreaterThan(0);
    act(() => { session.notePersonPromoted(); });
    await waitFor(() => expect(alerts().some((line) => line.includes(PERSON_LINE))).toBe(false));
  });

  it('Generate refused for another reason keeps its line through the promote', async () => {
    answers.set('POST /api/graph/cluster', { status: 400, body: { detail: 'That model is retired.' } });
    render(<CreateView />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate' })); });
    await waitFor(() => expect(alerts().length).toBe(1));
    const [line] = alerts();
    act(() => { session.notePersonPromoted(); });
    await act(async () => { await Promise.resolve(); });
    expect(alerts()).toEqual([line]);
  });

  it('Save style refused by the gate: the line shows, and goes on the promote', async () => {
    answers.set('POST /api/presets', gate);
    session.reportPersonRequired();
    render(<CreateView />);
    fireEvent.click(screen.getByRole('button', { name: 'Styles' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save current style' })); });
    // GM r6: the line is in the notice region now (graphStore notify), not the toolbar.
    const notice = () => { const state = useGraphStore.getState(); return state.messageNotice?.text ?? state.undoNotice?.text ?? ''; };
    await waitFor(() => expect(notice()).toContain(PERSON_LINE));
    act(() => { session.notePersonPromoted(); });
    await waitFor(() => expect(notice()).not.toContain(PERSON_LINE));
  });
});
