import { lazy, Suspense, useEffect, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { CanvasTabs } from './components/CanvasTabs';
import { NoticeRegion } from './components/NoticeRegion';
import { NodeLibrary } from './components/panels/NodeLibrary';
// Closed or empty at the first paint, loaded after it (lib/deferredChunks.ts).
import {
  AgentLog, AgentNotes, AssetsPanel, ChatPanel, CommandPalette, NodeInspectorPopover, OnboardingOverlay, RunHistoryPanel,
} from './components/DeferredPanels';
import { Settings } from './components/panels/Settings';
import { Toolbar } from './components/panels/Toolbar';
import { GraphFileActions } from './components/GraphFileActions';
import { WorkspaceRail } from './components/WorkspaceRail';
import { ChatLauncher } from './components/ChatLauncher';
// The Agent log's store collects every agent's actions from page load, even
// before the panel mounts (store/agentLogStore.ts subscribes at import).
import './store/agentLogStore';
// The same for Updates (store/agentNotesStore.ts): the corner is deferred,
// its store counts from the first socket message.
import './store/agentNotesStore';
// Questions agents asked (store/agentQuestionsStore.ts): the form is deferred
// with the corner; the store keeps every set and its key from hello on.
import './store/agentQuestionsStore';
import { KeyboardShortcuts } from './components/KeyboardShortcuts';
import { BackendConnectionStatus } from './components/BackendConnectionStatus';
import { PersonRequiredBanner } from './components/PersonRequiredBanner';
import { ProviderRecoveryStatus } from './components/ProviderRecoveryStatus';
import { startWorkingBadge } from './lib/jobNotifications';
import { DEFERRED_PRELOADS } from './lib/deferredChunks';
import { preloadAll, whenIdle } from './lib/lazyWithPreload';
import { getSettings } from './lib/api';
import { applySavedRunCostConfirm } from './lib/runCostConfirm';
import { getKreaConnection, normalizeKreaMode, nodeKeyStatus } from './lib/kreaConnection';
import { useUIStore } from './store/uiStore';
import { usePricingStore } from './store/pricingStore';
import { useGraphStore } from './store/graphStore';
import { useCommonsCapability } from './hooks/useCommonsCapability';
import { useZoomManifest } from './hooks/useZoomManifest';
import { useMoodboardDeepLink } from './hooks/useMoodboardDeepLink';
import { NODE_DEFINITIONS } from './constants/nodeDefinitions';
import { ProjectCoordinator } from './components/projects/ProjectCoordinator';
import { ProjectSwitchToast } from './components/projects/ProjectSwitchToast';
import { ProjectHome } from './components/projects/ProjectHome';
// Asset proposals (a pinned cover, a board's Send notes) reach this tab on any screen.
import './store/assetProposalsSocket';
import { useHomeSettingsDock } from './components/projects/useHomeSettingsDock';
import { projectErrorDetails, projectRetryOffer, useProjectStore } from './store/projectStore';
import { listCoverChoices } from './lib/projects';
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
  // List prices for the Run estimate and the cost confirm, fetched once.
  useEffect(() => { void usePricingStore.getState().load(); }, []);

  // Run History, the tour, the chat, the Inspector, the palette, the mask
  // painter, the node mesh / world viewers and more live outside the startup
  // entry (lib/deferredChunks.ts). Fetch them once the first paint is done so
  // a later first open never waits on the network.
  useEffect(() => whenIdle(() => preloadAll(DEFERRED_PRELOADS)), []);

  // Fetch settings on mount to populate the API key cache used for warning badges
  useEffect(() => {
    let cancelled = false;
    const request = ++settingsCacheRequest.current;
    const initialCache = useUIStore.getState().settingsCache;
    getSettings()
      .then((settings) => {
        if (!cancelled) applySavedRunCostConfirm(settings);
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
          if (!cancelled) applySavedRunCostConfirm(settings);
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

  // `#moodboard/<id>` opens Moodboard Studio on that board, and follows the
  // board the Studio shows. After the brand route, so its hashchange runs first.
  useMoodboardDeepLink();

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

  const projects = useProjectStore();
  const viewMode = useUIStore((s) => s.viewMode);
  const assetsPanelVisible = useUIStore((s) => s.panels.assets.visible);

  const commonsEnabled = useUIStore((s) => s.commonsEnabled);
  const isHome = projects.screen === 'home' && viewMode !== 'brand-showcase';
  const isCommons = !isHome && viewMode === 'commons' && commonsEnabled;
  const isCanvas = !isHome && (viewMode === 'canvas' || (viewMode === 'commons' && !commonsEnabled));
  const isRemotion = viewMode === 'remotion-editor';
  const isCinema = viewMode === 'cinema-editor';
  const isCharacter = viewMode === 'character-editor';
  const isMoodboard = viewMode === 'moodboard-editor';
  const isCreate = viewMode === 'create';
  const isBrandShowcase = viewMode === 'brand-showcase';
  const homeSettings = useHomeSettingsDock(isHome);

  let mainView;
  if (isHome) {
    mainView = <ProjectHome projects={projects.projects} loading={projects.loading} busy={projects.busy}
      error={projects.error} errorDetails={projectErrorDetails(projects)} onCreate={(name) => void projects.createProject(name)}
      onOpen={(id) => void projects.open(id)} onRename={(id, name) => void projects.rename(id, name)}
      onDelete={(id) => void projects.remove(id)} trash={projects.trash} lastDeleted={projects.lastDeleted}
      onRestore={(id) => void projects.restore(id)} onPurge={(id) => void projects.purge(id)}
      onEmptyTrash={() => void projects.emptyTrash()} onDismissUndo={projects.dismissUndo}
      onRetry={() => void projects.retry()} retry={projectRetryOffer(projects)} settingsOpen={homeSettings.open} onToggleSettings={homeSettings.toggle}
      loadCoverChoices={listCoverChoices} onPinCover={(id, url) => void projects.pinCover(id, url)}
      unsavedEdits={projects.unsavedEdits} editsSavedAs={projects.editsSavedAs}
      onDownloadEdits={() => void projects.downloadUnsavedEdits()}
      onContinueWithoutEdits={() => void projects.continueWithoutEdits()}
      catalogRestore={projects.catalogRestore} onDismissCatalogRestore={projects.dismissCatalogRestore}
      canvasNotFiled={projects.canvasNotFiled} canvasSaved={projects.canvasSaved} onDismissCanvasSaved={projects.dismissCanvasSaved} />;
  } else if (isCanvas) {
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
      <BackendConnectionStatus placement={isHome ? 'home' : 'workspace'} />
      <PersonRequiredBanner />
      <ProviderRecoveryStatus />
      <ProjectCoordinator />
      <ProjectSwitchToast />
      {!isHome && <GraphFileActions />}
      {!isHome && <ZoomManifestRecorder />}
      {isCanvas && <CanvasTabs />}
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
      {!isHome && !isBrandShowcase && (
        <div className={`workspace-overlays${isCanvas ? '' : ' workspace-overlays--studio'}${isCommons ? ' workspace-overlays--hidden' : ''}`} inert={isCommons}>
          <Settings />
          <ChatPanel />
        </div>
      )}
      {isHome && <div className="workspace-overlays workspace-overlays--home"><Settings /></div>}
      {isCanvas && <WorkspaceRail />}
      {isCanvas && <ChatLauncher />}
      {isCanvas && <Toolbar />}
      {isCanvas && <AgentLog />}
      {/* Updates on every screen, with the open project's list (Q107 a); one
          mount, so the list, the card and the count carry across screens. */}
      {!isBrandShowcase && <AgentNotes />}
      {!isHome && !isBrandShowcase && !isCommons && <CommandPalette />}
      {/* The app's one notice region, above every panel and Studio (GM - Design,
          2026-10-23): the canvas's notices with their Undo or Redo and the
          proposal bar, the written lines on the other screens, and every
          toast on every screen ("One region, one stack, and nothing else
          draws toasts"). One mount, beside the screens. */}
      <NoticeRegion screen={isCanvas ? 'canvas' : isHome || isBrandShowcase ? 'home' : 'studio'} />
      {isCanvas && <OnboardingOverlay />}
      {isCanvas && <KeyboardShortcuts />}
    </ReactFlowProvider>
  );
}
