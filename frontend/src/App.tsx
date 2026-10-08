import { lazy, Suspense, useEffect, useRef } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { CanvasTabs } from './components/CanvasTabs';
import { NodeLibrary } from './components/panels/NodeLibrary';
import { AssetsPanel } from './components/panels/AssetsPanel';
import { RunHistoryPanel } from './components/panels/RunHistoryPanel';
import { Settings } from './components/panels/Settings';
import { Toolbar } from './components/panels/Toolbar';
import { GraphFileActions } from './components/GraphFileActions';
import { WorkspaceRail } from './components/WorkspaceRail';
import { ChatLauncher } from './components/ChatLauncher';
import { NodeInspectorPopover } from './components/panels/NodeInspectorPopover';
import { ChatPanel } from './components/panels/ChatPanel';
import { AgentLog } from './components/panels/AgentLog';
import { CommandPalette } from './components/CommandPalette';
import { OnboardingOverlay } from './components/onboarding/OnboardingOverlay';
import { BackendConnectionStatus } from './components/BackendConnectionStatus';
import { ProviderRecoveryStatus } from './components/ProviderRecoveryStatus';
import { startWorkingBadge } from './lib/jobNotifications';
import { getSettings, fetchCLIGraph } from './lib/api';
import { getKreaConnection, normalizeKreaMode, nodeKeyStatus } from './lib/kreaConnection';
import { useUIStore } from './store/uiStore';
import { useGraphStore } from './store/graphStore';
import { useCommonsCapability } from './hooks/useCommonsCapability';
import { useZoomManifest } from './hooks/useZoomManifest';
import { NODE_DEFINITIONS } from './constants/nodeDefinitions';
import { computeCanvasFitPadding } from './lib/canvasFit';
import type { NodeData } from './types';
import './App.css';
import './styles/layouts.css';
// The single supported appearance is available to every workspace.
import './styles/slava-restraint.css';

// Alternate studios carry large, view-specific dependencies (Remotion,
// timeline editors, brand demos). Keep the canvas startup path lean and load
// each studio only when the user opens it.
const EditorView = lazy(() =>
  import('./components/editor/EditorView').then((module) => ({ default: module.EditorView })),
);
const RemotionEditorView = lazy(() =>
  import('./components/video-editor/RemotionEditorView').then((module) => ({
    default: module.RemotionEditorView,
  })),
);
const CinemaStudioView = lazy(() =>
  import('./components/cinema-studio/CinemaStudioView').then((module) => ({
    default: module.CinemaStudioView,
  })),
);
const CharacterStudioView = lazy(() =>
  import('./components/character-studio/CharacterStudioView').then((module) => ({
    default: module.CharacterStudioView,
  })),
);
const MoodboardStudioView = lazy(() =>
  import('./components/moodboard-studio/MoodboardStudioView').then((module) => ({
    default: module.MoodboardStudioView,
  })),
);
const CreateView = lazy(() =>
  import('./components/create-studio/CreateView').then((module) => ({ default: module.CreateView })),
);
const BrandShowcaseView = lazy(() =>
  import('./components/brand/BrandShowcaseView').then((module) => ({
    default: module.BrandShowcaseView,
  })),
);

const CommonsView = lazy(() =>
  import('./components/commons/CommonsView').then((module) => ({ default: module.CommonsView })),
);

/** Pull the backend's in-memory cli_graph onto the canvas on first mount —
 * saves a CLI-button click every time the user refreshes during a Daedalus
 * session. Scoped to "only when the canvas is empty" so an in-progress local
 * edit isn't clobbered. Lives inside ReactFlowProvider so it can fit the
 * viewport after painting; in StrictMode the effect runs twice, but the
 * hasRunRef guard makes the second pass a no-op. */
/** First-run onboarding only fires when (a) it's genuinely the first run and
 * (b) the canvas resolved to empty. The guard keeps it idempotent under the
 * StrictMode double-invoke of GraphHydrator's effect. */
function maybeStartOnboarding() {
  const ui = useUIStore.getState();
  if (!ui.hasOnboarded && !ui.onboardingActive) ui.startOnboarding();
}

function GraphHydrator() {
  const { fitView } = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    // A persisted running World Labs record owns the global paid-start lock
    // before the Canvas becomes interactive. Reconcile its client-owned run ID
    // independently of whether cli_graph is empty or reachable.
    void useGraphStore.getState().reconcilePersistedWorldLabsRun();
    (async () => {
      try {
        const data = await fetchCLIGraph();
        // Re-check after the await: in React StrictMode dev the effect runs
        // twice with a cleanup between, so the first run's cancelled flag is
        // always set before its fetch resolves. The store-state check lets a
        // mount-2 fetch successfully load, while mount-1's stale fetch sees
        // the populated store and bails.
        if (cancelled) return;
        // Paid-provider recovery is independent of cli_graph. Hydrate the
        // exact persisted run snapshot even when the backend graph is empty
        // or this browser has no live copy of a frontend-only UUID node.
        useGraphStore.getState().hydrateProviderRecoveries(data.providerRecoveries ?? []);
        useGraphStore.getState().hydrateProviderStartAmbiguities(
          data.providerStartAmbiguities ?? [],
        );
        if (data.executionStatuses !== undefined) {
          useGraphStore.getState().hydrateExecutionStatuses(data.executionStatuses);
        }
        if (useGraphStore.getState().nodes.length > 0) return;
        if (data.empty) {
          useUIStore.getState().resetPanelsForFreshCanvas();
          maybeStartOnboarding();
          return;
        }
        useGraphStore.getState().loadGraph(
          data.nodes as Node<NodeData>[],
          data.edges as Edge[],
          { allowDuringExecution: true, preserveCinemaUploads: true },
        );
        setTimeout(() => fitView({ padding: computeCanvasFitPadding(), duration: 300 }), 50);
      } catch {
        if (cancelled) return;
        // Backend down on first load: keep the blank canvas clean. The graph
        // store will clear stale cli_graph state before the first manual add.
        useUIStore.getState().resetPanelsForFreshCanvas();
        maybeStartOnboarding();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fitView]);

  return null;
}

/** Headless component that wires the zoom-manifest recorder. Lives inside
 * ReactFlowProvider because the hook uses `useReactFlow` for node lookups. */
function ZoomManifestRecorder() {
  useZoomManifest();
  return null;
}

export default function App() {
  useCommonsCapability();
  const credentialCache = useUIStore((s) => s.settingsCache);
  const settingsVisible = useUIStore((s) => s.panels.settings.visible
    && (s.viewMode === 'canvas' || s.viewMode === 'create'));
  const settingsCacheRequest = useRef(0);
  // Fetch settings on mount to populate the API key cache used for warning badges
  useEffect(() => {
    let cancelled = false;
    const request = ++settingsCacheRequest.current;
    const initialCache = useUIStore.getState().settingsCache;
    getSettings()
      .then((settings) => {
        const currentCache = useUIStore.getState().settingsCache;
        if (cancelled || request !== settingsCacheRequest.current
          || currentCache.apiKeys !== initialCache.apiKeys
          || currentCache.kreaConnectionMode !== initialCache.kreaConnectionMode) return;
        const apiKeys = (settings.apiKeys ?? {}) as Record<string, string>;
        useUIStore.getState().setSettingsCache(apiKeys, normalizeKreaMode(settings.kreaConnectionMode));
      })
      .catch((err) => console.warn('Failed to load settings for key check:', err));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialConnection = useUIStore.getState().settingsCache.kreaConnection;
    getKreaConnection().then((connection) => {
      if (!cancelled && useUIStore.getState().settingsCache.kreaConnection === initialConnection) {
        useUIStore.getState().setKreaConnection(connection);
      }
    }).catch(() => {
      if (!cancelled && useUIStore.getState().settingsCache.kreaConnection === initialConnection) {
        useUIStore.getState().setKreaConnection({ status: 'error' });
      }
    });
    return () => { cancelled = true; };
  }, []);

  // The Settings card polls while open; keep pending consent alive when closed.
  useEffect(() => {
    const connection = credentialCache.kreaConnection;
    if (settingsVisible || connection?.status !== 'connecting') return;
    let cancelled = false;
    const stillCurrent = () => !cancelled
      && useUIStore.getState().settingsCache.kreaConnection === connection;
    const timer = window.setTimeout(() => {
      getKreaConnection().then((state) => {
        if (stillCurrent()) useUIStore.getState().setKreaConnection(state);
      }).catch(() => {
        if (stillCurrent()) useUIStore.getState().setKreaConnection({ status: 'error' });
      });
    }, 2000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [credentialCache.kreaConnection, settingsVisible]);

  // Connection readiness only changes warnings, never node parameters or runs.
  useEffect(() => {
    const nodes = useGraphStore.getState().nodes;
    const updated = nodes.map((node) => {
      const keyStatus = nodeKeyStatus(NODE_DEFINITIONS[node.data.definitionId], node.data.params, credentialCache);
      return node.data.keyStatus === keyStatus ? node : { ...node, data: { ...node.data, keyStatus } };
    });
    if (updated.some((node, index) => node !== nodes[index])) useGraphStore.setState({ nodes: updated });
  }, [credentialCache]);

  // Re-check all node key statuses whenever settings are saved
  useEffect(() => {
    let cancelled = false;
    function handleSettingsSaved() {
      const request = ++settingsCacheRequest.current;
      const initialCache = useUIStore.getState().settingsCache;
      getSettings()
        .then((settings) => {
          const currentCache = useUIStore.getState().settingsCache;
          if (cancelled || request !== settingsCacheRequest.current
            || currentCache.apiKeys !== initialCache.apiKeys
            || currentCache.kreaConnectionMode !== initialCache.kreaConnectionMode) return;
          const apiKeys = (settings.apiKeys ?? {}) as Record<string, string>;
          useUIStore.getState().setSettingsCache(apiKeys, normalizeKreaMode(settings.kreaConnectionMode));
        })
        .catch(console.warn);
    }

    window.addEventListener('nebula:settings-saved', handleSettingsSaved);
    return () => {
      cancelled = true;
      window.removeEventListener('nebula:settings-saved', handleSettingsSaved);
    };
  }, []);

  // Hash route for the Dynamic Mark showcase. `#brand` (or `#dynamic-mark`)
  // opens the standalone brand demo surface; clearing the hash leaves it.
  // Kept out of the product toolbar on purpose — it's a reference/demo page.
  useEffect(() => {
    const BRAND_HASHES = new Set(['#brand', '#dynamic-mark']);
    const sync = () => {
      const ui = useUIStore.getState();
      const wantShowcase = BRAND_HASHES.has(window.location.hash);
      if (wantShowcase && ui.viewMode !== 'brand-showcase') {
        ui.enterBrandShowcase();
      } else if (!wantShowcase && ui.viewMode === 'brand-showcase') {
        ui.exitBrandShowcase();
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  // Job-notification "working" tab badge: flash the title while a run is in
  // flight and the tab is backgrounded. Completion notifications fire from the store.
  useEffect(() => {
    const unsub = useGraphStore.subscribe((s, p) => {
      if (s.isExecuting && !p.isExecuting) startWorkingBadge();
    });
    const onVis = () => {
      if (document.hidden && useGraphStore.getState().isExecuting) startWorkingBadge();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const viewMode = useUIStore((s) => s.viewMode);
  const assetsPanelVisible = useUIStore((s) => s.panels.assets.visible);

  const commonsEnabled = useUIStore((s) => s.commonsEnabled);
  const isCommons = viewMode === 'commons' && commonsEnabled;
  const isCanvas = viewMode === 'canvas' || (viewMode === 'commons' && !commonsEnabled);
  const isRemotion = viewMode === 'remotion-editor';
  const isCinema = viewMode === 'cinema-editor';
  const isCharacter = viewMode === 'character-editor';
  const isMoodboard = viewMode === 'moodboard-editor';
  const isCreate = viewMode === 'create';
  const isBrandShowcase = viewMode === 'brand-showcase';

  let mainView;
  if (isCanvas) {
    mainView = <Canvas />;
  } else if (isCommons) {
    mainView = <CommonsView />;
  } else if (isBrandShowcase) {
    mainView = <BrandShowcaseView />;
  } else if (isRemotion) {
    mainView = <RemotionEditorView />;
  } else if (isCinema) {
    mainView = <CinemaStudioView />;
  } else if (isCharacter) {
    mainView = <CharacterStudioView />;
  } else if (isMoodboard) {
    mainView = <MoodboardStudioView />;
  } else if (isCreate) {
    mainView = <CreateView />;
  } else {
    mainView = <EditorView />;
  }

  return (
    <ReactFlowProvider>
      <BackendConnectionStatus />
      <ProviderRecoveryStatus />
      <GraphHydrator />
      <GraphFileActions />
      <ZoomManifestRecorder />
      {!isBrandShowcase && !isCommons && <CanvasTabs />}
      <Suspense
        fallback={(
          <div className="workspace-loading" role="status" aria-live="polite">
            Loading workspace…
          </div>
        )}
      >
        {mainView}
      </Suspense>
      {/* Canvas chrome stays scoped; Settings and Chat are shared workspace docks. */}
      {isCanvas && <NodeLibrary />}
      {isCanvas && assetsPanelVisible && <AssetsPanel />}
      {isCanvas && <RunHistoryPanel />}
      {isCanvas && <NodeInspectorPopover />}
      {!isBrandShowcase && (
        <div className={`workspace-overlays${isCanvas ? '' : ' workspace-overlays--studio'}${isCommons ? ' workspace-overlays--hidden' : ''}`} inert={isCommons}>
          <Settings />
          <ChatPanel />
        </div>
      )}
      {isCanvas && <WorkspaceRail />}
      {isCanvas && <ChatLauncher />}
      {isCanvas && <Toolbar />}
      {isCanvas && <AgentLog />}
      {!isBrandShowcase && !isCommons && <CommandPalette />}
      {isCanvas && <OnboardingOverlay />}
    </ReactFlowProvider>
  );
}
