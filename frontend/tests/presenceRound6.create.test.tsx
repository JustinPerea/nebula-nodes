/**
 * PR #204 round 6, GM r6 (1): Save style refused only because this tab isn't connected as the
 * person says so in the "because" form, in the app's notice region (not Creator Studio's
 * toolbar row), and sends the same Style again on the promote, silently, once. Through the
 * real request path (fetch answers 403 person_required).
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
const { publishOpenProject } = await import('../src/lib/currentProject');

const answers = new Map<string, { status: number; body: unknown }>();
const sent: Array<{ path: string; body: unknown }> = [];
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
  sent.length = 0;
  publishOpenProject({ id: 'p1', name: 'Followups' });
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url), 'http://x').pathname;
    if (init?.method === 'POST') sent.push({ path, body: JSON.parse(String(init.body ?? 'null')) });
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

const BECAUSE = 'Nebula couldn’t save the style because this tab isn’t connected as you. Open the link Nebula printed when it started.';
const notice = () => { const state = useGraphStore.getState(); return state.messageNotice?.text ?? state.undoNotice?.text ?? ''; };
const presets = () => sent.filter((entry) => entry.path === '/api/presets');

async function saveStyle() {
  render(<CreateView />);
  fireEvent.click(screen.getByRole('button', { name: 'Styles' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save current style' })); });
}

describe('GM r6 (1): Save style retries on the promote, and says so in the notice region', () => {
  it('a refusal by the gate: the because line in the notice region, nothing in the toolbar row', async () => {
    answers.set('POST /api/presets', gate);
    session.reportPersonRequired();
    await saveStyle();
    await waitFor(() => expect(notice()).toBe(BECAUSE));
    expect(notice()).not.toMatch(/try again|needs your OK/i);
    expect(document.querySelector('.create-view__topbar [role="alert"]')).toBeNull();
    expect(alerts().join(' ')).not.toContain('isn’t connected');
  });

  it('on the promote the same Style is sent again, once, and the line goes', async () => {
    answers.set('POST /api/presets', gate);
    session.reportPersonRequired();
    await saveStyle();
    await waitFor(() => expect(presets()).toHaveLength(1));
    answers.delete('POST /api/presets');
    await act(async () => { session.notePersonPromoted(); });
    await waitFor(() => expect(presets()).toHaveLength(2));
    expect(presets()[1].body).toEqual(presets()[0].body);
    expect(notice()).not.toContain('isn’t connected');
    await act(async () => { session.notePersonPromoted(); });
    expect(presets()).toHaveLength(2);
  });

  it('a project switched before the promote: nothing is sent to the new one', async () => {
    answers.set('POST /api/presets', gate);
    session.reportPersonRequired();
    await saveStyle();
    await waitFor(() => expect(presets()).toHaveLength(1));
    publishOpenProject({ id: 'p2', name: 'Other' });
    await act(async () => { session.notePersonPromoted(); });
    await act(async () => { await Promise.resolve(); });
    expect(presets()).toHaveLength(1);
  });

  it('another failure keeps the heading form in the notice region, and nothing retries', async () => {
    answers.set('POST /api/presets', { status: 409, body: { detail: 'Preset storage unavailable.' } });
    await saveStyle();
    await waitFor(() => expect(notice()).toContain('Couldn\'t save the style.'));
    await act(async () => { session.notePersonPromoted(); });
    expect(presets()).toHaveLength(1);
  });
});
