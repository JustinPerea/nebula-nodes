import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore, type ViewMode } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import { useCreateDraftStore } from '../../src/store/createDraftStore';
import { useSettingsDraftStore, type SettingsDraft } from '../../src/store/settingsDraftStore';
import type { NodeData } from '../../src/types';
import type { Node } from '@xyflow/react';
import type { RunRecord } from '../../src/lib/runHistory';
import { ONBOARDING_TOUR } from '../../src/lib/onboarding';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const initialCreate = useCreateDraftStore.getState();
const initialSettings = useSettingsDraftStore.getState();
const originalOnboarded = localStorage.getItem('nebula:onboarded');

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  useCreateDraftStore.setState(initialCreate, true);
  useSettingsDraftStore.setState(initialSettings, true);
  localStorage.removeItem('nebula:onboarded');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  useCreateDraftStore.setState(initialCreate, true);
  useSettingsDraftStore.setState(initialSettings, true);
  if (originalOnboarded === null) localStorage.removeItem('nebula:onboarded');
  else localStorage.setItem('nebula:onboarded', originalOnboarded);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('onboarding navigation without authoring changes', () => {
  it.each<ViewMode>(['canvas', 'create', 'cinema-editor', 'editor', 'remotion-editor', 'character-editor', 'moodboard-editor', 'commons'])(
    'opens the current Canvas tour from %s while preserving work and selection', (viewMode) => {
    const nodes = freeze<Node<NodeData>[]>([{ id: 'logo', type: 'model-node', selected: true, position: { x: 123, y: 456 }, data: {
      definitionId: 'krea-image-openai-gpt-image-2', label: 'Retained logo', state: 'complete',
      params: { prompt: 'Saved logo prompt', _kreaAuth: 'mcp' }, outputs: { image: { type: 'Image', value: '/api/outputs/retained.png' } },
    } }]);
    const edges = freeze([{ id: 'connection', source: 'source', target: 'logo', targetHandle: 'prompt', selected: true }]);
    const history = freeze<RunRecord[]>([{ id: 'prior-run', trigger: 'node', startedAt: 1, status: 'complete',
      snapshot: { nodes: [{ id: 'logo', definitionId: 'krea-image-openai-gpt-image-2', params: { prompt: 'Earlier logo', _kreaAuth: 'mcp' }, outputs: {} }], edges: [] },
      resultOutputs: { logo: { image: { type: 'Image', value: '/api/outputs/earlier.png' } } },
    }]);
    useGraphStore.setState({ nodes, edges, runHistory: history, undoStack: [], redoStack: [] });
    const draft = freeze({ revision: 'draft-revision', modelId: 'krea-image-openai-gpt-image-2',
      prompt: 'Unsent composer draft', params: { _kreaAuth: 'mcp', aspect_ratio: '16:9' },
      refs: [{ filePath: '/api/outputs/reference.png', previewUrl: '/api/outputs/reference.png' }],
      quantity: 2, uploads: [{ id: 'upload', name: 'reference', attempt: 'attempt', status: 'error' as const, error: 'Retry attachment' }],
    });
    useCreateDraftStore.setState({ drafts: { 'kept-session': draft } });
    const settings: SettingsDraft = freeze({ apiKeys: { OPENAI_API_KEY: 'fixture-unsaved' }, routing: {},
      kreaConnectionMode: 'mcp', outputPath: '', exportFolder: '', zoomTelemetryEnabled: false });
    useSettingsDraftStore.setState({ draft: settings, baseline: { ...settings, apiKeys: {} } });
    useUIStore.setState({ viewMode, selectedNodeId: 'logo', createSessionId: 'kept-session',
      cinemaEditorNodeId: 'scene', editorTargetNodeId: 'video', remotionEditorTargetNodeId: 'remotion',
      characterEditorId: 'character', moodboardEditorId: 'moodboard', onboardingStep: 4, isPlaying: true });
    const load = vi.spyOn(useGraphStore.getState(), 'loadSampleGraph');
    const run = vi.spyOn(useGraphStore.getState(), 'executeGraph');

    useUIStore.getState().startOnboarding();

    expect(useUIStore.getState()).toMatchObject({ viewMode: 'canvas', onboardingActive: true, onboardingStep: 0,
      selectedNodeId: 'logo', createSessionId: 'kept-session', isPlaying: false,
      cinemaEditorNodeId: 'scene', editorTargetNodeId: 'video', remotionEditorTargetNodeId: 'remotion',
      characterEditorId: 'character', moodboardEditorId: 'moodboard' });
    expect(useGraphStore.getState().nodes).toBe(nodes);
    expect(useGraphStore.getState().edges).toBe(edges);
    expect(useGraphStore.getState().runHistory).toBe(history);
    expect(useGraphStore.getState().undoStack).toEqual([]);
    expect(useCreateDraftStore.getState().drafts['kept-session']).toBe(draft);
    expect(useSettingsDraftStore.getState().draft).toBe(settings);
    expect(localStorage.getItem('nebula:onboarded')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps cancellation terminal despite stale advance and back callbacks', () => {
    useUIStore.getState().startOnboarding();
    const { nextOnboardingStep, prevOnboardingStep, finishOnboarding } = useUIStore.getState();
    nextOnboardingStep();
    nextOnboardingStep();
    finishOnboarding();
    nextOnboardingStep();
    prevOnboardingStep();
    nextOnboardingStep();
    expect(useUIStore.getState()).toMatchObject({ hasOnboarded: true, onboardingActive: false, onboardingStep: 0 });
    expect(localStorage.getItem('nebula:onboarded')).toBe('1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('restarts an optional tour predictably and does not mark it complete until dismissal', () => {
    useUIStore.setState({ hasOnboarded: false });
    useUIStore.getState().startOnboarding();
    useUIStore.getState().nextOnboardingStep();
    useUIStore.getState().startOnboarding();
    expect(useUIStore.getState()).toMatchObject({ onboardingActive: true, onboardingStep: 0, hasOnboarded: false });
    expect(localStorage.getItem('nebula:onboarded')).toBeNull();
    useUIStore.getState().finishOnboarding();
    useUIStore.getState().finishOnboarding();
    expect(useUIStore.getState()).toMatchObject({ onboardingActive: false, onboardingStep: 0, hasOnboarded: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds repeated navigation to the current tour without advancing after cancellation', () => {
    useUIStore.getState().startOnboarding();
    const { nextOnboardingStep, prevOnboardingStep, finishOnboarding } = useUIStore.getState();
    for (let index = 0; index < ONBOARDING_TOUR.length * 3; index++) nextOnboardingStep();
    expect(useUIStore.getState().onboardingStep).toBe(ONBOARDING_TOUR.length);
    for (let index = 0; index < ONBOARDING_TOUR.length * 3; index++) prevOnboardingStep();
    expect(useUIStore.getState().onboardingStep).toBe(0);
    finishOnboarding();
    for (let index = 0; index < ONBOARDING_TOUR.length * 3; index++) nextOnboardingStep();
    expect(useUIStore.getState()).toMatchObject({ onboardingActive: false, onboardingStep: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
