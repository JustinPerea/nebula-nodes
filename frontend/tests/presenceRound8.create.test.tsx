/**
 * PR #204 round 8, review 6 LOW-6 (M18): Generate's line goes with its own refusal's stamp. A
 * cluster sent while this tab was held, refused, and answered after the promote, has nothing left
 * to wait for: its line goes at once, not at the next promote. Through the real request path.
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
// GM r8 (3), #204 round 7: Generate's line is in the app's notice region (graphStore notify).
const runNotices = () => { const state = useGraphStore.getState(); return [state.messageNotice?.text, state.undoNotice?.text].filter((text): text is string => Boolean(text)); };

describe('review 6 LOW-6: Generate\'s line carries its own refusal', () => {
  it('a refusal sent before the promote and answered after it: the line goes at once', async () => {
    session.reportPersonRequired();
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url), 'http://x').pathname;
      if (path === '/api/graph/cluster' && String(init?.method).toUpperCase() === 'POST') {
        // The promote lands while the refused request is in flight.
        session.notePersonPromoted();
        return json(gate.status, gate.body);
      }
      return json(200, path === '/api/presets' ? [] : {});
    });
    vi.stubGlobal('fetch', fetch);
    render(<CreateView />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate' })); });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/graph/cluster'))).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(runNotices().some((line) => line.includes(PERSON_LINE))).toBe(false);
    expect(pendingPromoteClears()).toBe(0);
  });
});
