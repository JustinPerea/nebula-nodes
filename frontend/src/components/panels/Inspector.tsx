import { useRef, useEffect, useState, useMemo } from 'react';
import { Brush, Copy, Info, Play, Plus, RefreshCw, Star, Trash2, Upload, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { storedAssetId } from '../../store/storedAssetsStore';
import { StoredAssetPicker } from './StoredAssetPicker';
import { useGraphStore } from '../../store/graphStore';
import { usesKreaAccount } from '../../lib/kreaConnection';
import { keysNeeded } from '../../lib/nodeKeys';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import { PORT_COLORS } from '../../lib/portCompatibility';
import type { NodeData, DynamicNodeData, DynamicParamDefinition, ParamDefinition } from '../../types';
import { fetchOpenRouterModels, fetchNousModels, fetchQuiverModels, getSettings, updateSettings, type OpenRouterModel, type QuiverModel } from '../../lib/api';
import { backendAssetUrlSync } from '../../lib/backend';
import { apiRequest } from '../../lib/apiRequest';
import { quoted } from '../../lib/canvasFileDrop';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import { MaskPainterModal } from '../DeferredPanels';
import { DeferredMaskPainterModal } from '../../lib/deferredChunks';
import { JevResultDetails } from './JevResultDetails';
import { StructuredOutputs } from '../nodes/StructuredValuePreview';
import { structuredOutputEntries } from '../../lib/structuredValue';
import { isJevNode, parseJevOutputs } from '../../lib/jev';
import { allParamDefinitions, paramDefinitionsForRun, providerLabel, routeById, routeSwitch, selectRoute, shownRouteId, visibleParams as visibleParamsFor, withWiredBlockers } from '../../lib/directRoute';
import { definitionSnap, definitionStartShapeNote, sizeNote } from '../../lib/makerSizes';
import { paramDefaultFor, snapParamDefaults, type DefaultSnapNote } from '../../lib/paramDefaults';
import { nodeWiredCounts, nodeWiredPorts } from '../../lib/runScope';
import { ProviderSwitcher } from '../nodes/ProviderSwitcher';
import { InspectorFoot } from './InspectorFoot';
import { useProviderNoteStore } from '../../store/providerNoteStore';
import { snapHidden } from '../../lib/providerSwitch';
import { skippedLabel } from '../../lib/gating';
import '../../styles/panels.css';
import '../../styles/mask-painter.css';
import { failureMessage } from '../../lib/errorCopy';
import { extractPaletteFromImage, paletteNotice } from '../../lib/paletteExtract';
import { fileNameParam, inputFileName } from '../../lib/fileName';
import { useCanvasLock } from '../../lib/canvasLock';

type InspectorParamDefinition = ParamDefinition | DynamicParamDefinition;

type InspectorProps = {
  embedded?: boolean;
};

// --- Palette param helpers -------------------------------------------------
// The 'palette' control stores a string[] of `#rrggbb` hex values. Extraction
// runs client-side (lib/paletteExtract.ts, k-means on a downscaled canvas).

/** Normalize arbitrary user/text input into a `#rrggbb` hex string. Returns
 *  null when the input can't be coerced to a valid 6-digit hex. */
function normalizeHex(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v) return null;
  if (!v.startsWith('#')) v = `#${v}`;
  // Expand shorthand #rgb -> #rrggbb
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

export function Inspector({ embedded = false }: InspectorProps) {
  // Offline is read-only (round 15 of PR #114), and so is following an
  // agent's switch (GM round 22, A: one state, lib/canvasLock): every field
  // and action that edits renders disabled from this, so the end of either
  // just re-renders. Run, Duplicate and Delete say "Wait for “<project>” to
  // open." while following.
  const lock = useCanvasLock();
  const readOnly = lock.locked;
  const panelVisible = useUIStore((s) => s.panels.inspector.visible);
  const position = useUIStore((s) => s.panels.inspector.position);
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const skin = useUIStore((s) => s.skin);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setPanelPosition = useUIStore((s) => s.setPanelPosition);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const executeNode = useGraphStore((s) => s.executeNode);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const deleteNode = useGraphStore((s) => s.deleteNode);
  const configureOpenRouterModel = useGraphStore((s) => s.configureOpenRouterModel);
  const fetchReplicateSchemaAndConfigure = useGraphStore((s) => s.fetchReplicateSchemaAndConfigure);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);
  const visible = embedded ? selectedNodeId !== null : panelVisible;
  const { shouldRender, exiting } = useDelayedUnmount(visible, 500);

  // OpenRouter model selector state
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');

  // Replicate schema fetch state
  const [schemaLoading, setSchemaLoading] = useState(false);

  // Palette extraction in-flight state, keyed by param key (a node may have
  // more than one 'palette' control). Null/absent = idle.
  const [paletteExtracting, setPaletteExtracting] = useState<Record<string, boolean>>({});

  // Quiver Arrow dynamic model list (cached for the session). Loaded on
  // first selection of any Quiver node so the `model` enum reflects
  // models added after this build (arrow-1.2, arrow-2, etc.) without
  // a frontend rebuild. Failure leaves it null and we fall through to
  // the hardcoded options baked into the node definition.
  const [quiverModels, setQuiverModels] = useState<QuiverModel[] | null>(null);

  // Info panel toggle
  const [showInfo, setShowInfo] = useState(false);
  // What the last model change did to a per-model default, shown under that
  // param until the next edit on the same node.
  const [defaultNotes, setDefaultNotes] = useState<{ nodeId: string; notes: DefaultSnapNote[] }>({ nodeId: '', notes: [] });
  const [maskPainterOpen, setMaskPainterOpen] = useState(false);

  // Favorites state
  const [favorites, setFavorites] = useState<Record<string, string[]>>({});

  // Load favorites from settings
  useEffect(() => {
    getSettings().then((settings: { favorites?: Record<string, string[]> }) => {
      setFavorites(settings.favorites ?? {});
    }).catch(() => setFavorites({}));
  }, []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selectedNodeData = selectedNode?.data as NodeData | undefined;
  const lastSelectionRef = useRef<{ node: NonNullable<typeof selectedNode>; data: NodeData } | null>(null);
  if (selectedNode && selectedNodeData) {
    lastSelectionRef.current = { node: selectedNode, data: selectedNodeData };
  }
  const renderNode = selectedNode ?? (exiting ? lastSelectionRef.current?.node : undefined);
  const nodeData = selectedNodeData ?? (exiting ? lastSelectionRef.current?.data : undefined);
  const definition = nodeData ? NODE_DEFINITIONS[nodeData.definitionId] : undefined;

  // Resolve params: dual-route nodes show sharedParams plus the params of the
  // route this run takes (lib/directRoute.ts selectRoute, the backend's rule):
  // directParams on the maker's key, falParams on the fal or Krea copy and on
  // the Krea plan. With the maker key set but a direct param still missing
  // (Ideogram Reframe without `resolution`), that param shows unset so the
  // person can opt in. Until settings load, no key counts as set.
  // A Krea-only input that arrives by wire keeps the run on the copy
  // (withWiredBlockers, as the backend router reads it), so show that route's params.
  const settingsCache = useUIStore((s) => s.settingsCache);
  const nodeParams = nodeData?.params;
  const renderNodeId = renderNode?.id;
  const wiredKey = useMemo(() => (renderNodeId ? nodeWiredPorts(renderNodeId, edges).join('\n') : ''), [renderNodeId, edges]);
  const resolvedParams: ParamDefinition[] = useMemo(() => {
    if (!definition) return [];
    const routed = withWiredBlockers(definition, nodeParams, wiredKey ? wiredKey.split('\n') : []);
    return paramDefinitionsForRun(definition, routed, settingsCache.loaded ? settingsCache.apiKeys : {}, { seedOptIn: false });
  }, [definition, nodeParams, wiredKey, settingsCache.loaded, settingsCache.apiKeys]);

  // A maker that takes a fixed size list (Ideogram 3, Ideogram 2a, Runway
  // Gen-4 Image) gets the nearest one on its route, and Seedance 2.5 on
  // BytePlus makes a start-image run in the start image's shape
  // (lib/makerSizes.ts, the backend's rules). Say so under the size or the
  // aspect ratio when that isn't what was asked; on the Krea copy it is sent
  // as given, so nothing is said.
  const makerSizeNote = useMemo((): { param: string; text: string } | null => {
    const route = definition?.directRoute;
    if (!definition || !(route?.snap || route?.startShape) || !settingsCache.loaded) return null;
    const wired = wiredKey ? wiredKey.split('\n') : [];
    const routed = withWiredBlockers(definition, nodeParams, wired);
    if (selectRoute(definition, routed, settingsCache.apiKeys).kind !== 'direct') return null;
    if (route.snap) {
      const text = sizeNote(definitionSnap(definition, nodeParams));
      return text ? { param: route.snap.heightParam, text } : null;
    }
    if (!route.startShape) return null;
    const text = definitionStartShapeNote(definition, nodeParams, wired);
    return text ? { param: route.startShape.ratioParam, text } : null;
  }, [definition, nodeParams, wiredKey, settingsCache.loaded, settingsCache.apiKeys]);

  // A route-table node (ProviderSwitcher): the provider whose options the
  // list shows, for the "not on <provider>" label of a saved value it doesn't
  // take, and the edges into each port for the switcher's port rules.
  const switchable = routeSwitch(definition);
  const shownProvider = useMemo(() => {
    if (!definition || !switchable) return null;
    const routed = withWiredBlockers(definition, nodeParams, wiredKey ? wiredKey.split('\n') : []);
    const route = routeById(definition, shownRouteId(definition, routed, settingsCache.loaded ? settingsCache.apiKeys : {}));
    return route ? providerLabel(route.provider) : null;
  }, [definition, switchable, nodeParams, wiredKey, settingsCache.loaded, settingsCache.apiKeys]);
  const wiredCounts = useMemo(
    () => (renderNodeId && switchable ? nodeWiredCounts(renderNodeId, edges) : new Map<string, number>()),
    [renderNodeId, switchable, edges],
  );

  // Filter params by visibleWhen conditions
  // Hidden params are editor-managed internal state (e.g. cinema-scene's
  // `scene` spec, authored via the Cinema Studio): never an editable field
  // here. The rest follow paramShown (lib/directRoute.ts visibleParams), the
  // predicate Create's pills and the backend router read too.
  const visibleParams = useMemo(() => {
    if (!nodeData || !definition) return resolvedParams;
    return visibleParamsFor(definition, nodeData.params, resolvedParams);
  }, [resolvedParams, nodeData, definition]);

  // Universal-model nodes (OpenRouter, Nous Portal) share the modality-driven
  // model-picker UX. Map definitionId → favorites bucket + loader so we can
  // drive both with one effect and one render branch.
  const universalProvider: 'openrouter' | 'nous' | null =
    nodeData?.definitionId === 'openrouter-universal'
      ? 'openrouter'
      : nodeData?.definitionId === 'nous-portal-universal'
        ? 'nous'
        : null;
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);

  // Fetch the right model list for the selected universal node
  useEffect(() => {
    if (!universalProvider) {
      setModelLoadError(null);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    setModelLoadError(null);
    const loader = universalProvider === 'openrouter' ? fetchOpenRouterModels : fetchNousModels;
    loader()
      .then((data) => {
        if (!cancelled) setOpenRouterModels(data.models);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setModelLoadError(failureMessage(err, universalProvider === 'openrouter'
          ? "Couldn't load the OpenRouter models." : "Couldn't load the Nous models."));
        setOpenRouterModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [universalProvider]);

  const isQuiverNode = nodeData?.definitionId === 'quiver-arrow-generate' || nodeData?.definitionId === 'quiver-arrow-vectorize';

  // Fetch Quiver model catalog the first time a Quiver node is selected.
  // Failure is silent — the hardcoded enum options in the node definition
  // remain usable as a fallback.
  useEffect(() => {
    if (!isQuiverNode || quiverModels !== null) return;
    let cancelled = false;
    fetchQuiverModels()
      .then((data) => {
        if (!cancelled) setQuiverModels(data.models);
      })
      .catch(() => {
        // Leave quiverModels null — getVisibleOptions falls through to static options.
      });
    return () => {
      cancelled = true;
    };
  }, [isQuiverNode, quiverModels]);

  // Filter models by search query — cap at 50 to avoid huge dropdowns, favorites sorted to top
  const filteredModels = useMemo(() => {
    const favIds = (universalProvider && favorites[universalProvider]) ?? [];
    let models = openRouterModels;
    if (modelSearch.trim()) {
      const lower = modelSearch.toLowerCase();
      models = models.filter((m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower));
    }
    const sorted = [...models].sort((a, b) => {
      const aFav = favIds.includes(a.id) ? 0 : 1;
      const bFav = favIds.includes(b.id) ? 0 : 1;
      return aFav - bFav;
    });
    return sorted.slice(0, 50);
  }, [openRouterModels, modelSearch, favorites, universalProvider]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPanelPosition('inspector', {
        x: dragRef.current.panelX + dx,
        y: dragRef.current.panelY + dy,
      });
    }
    function onMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [setPanelPosition]);

  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const resolvedX = position.x < 0 ? viewportWidth + position.x : position.x;
  const isSlavaSkin = skin === 'slava-restraint';

  function handleHeaderMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panelX: resolvedX,
      panelY: position.y,
    };
  }

  if (!shouldRender) return null;

  if (!renderNode || !nodeData) {
    if (embedded) return null;
    if (!isSlavaSkin) return null;
    return (
      <div
        className={`panel panel--inspector panel--inspector-empty${exiting ? ' panel--exiting' : ''}`}
        style={{ left: resolvedX, top: position.y }}
      >
        <div className="panel__header" onMouseDown={handleHeaderMouseDown}>
          <span className="panel__title">Inspector</span>
          <button
            type="button"
            className="panel__header-action panel__close"
            onClick={() => togglePanel('inspector')}
            aria-label="Close inspector panel"
            title="Close"
          >
            <X
              className="panel__close-icon"
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
        </div>

        <div className="panel__body panel__body--empty" key="inspector-empty">
          <div className="inspector__empty" data-inspector-empty="true">
            <span className="inspector__empty-grid" aria-hidden="true" />
            <span className="inspector__empty-title">No node selected</span>
            <span className="inspector__empty-status">standby</span>
          </div>
        </div>
      </div>
    );
  }

  // For dynamic nodes, definition may be a shell — that's fine
  if (!definition && !(nodeData as unknown as DynamicNodeData)?.isDynamic) return null;
  const activeNode = renderNode;
  const activeNodeData = nodeData;

  // A person's edit. On a route-table node, a setting the edit now hides on
  // the shown provider, at a value another provider would honor (rule H),
  // goes back to its default with one card note (lib/providerSwitch.ts
  // snapHidden): "Safety 5 isn't on fal.ai with FLUX.2 [klein] 9B: back to 2".
  // Returns the params it wrote.
  function writeEdit(params: Record<string, unknown>, key: string): Record<string, unknown> {
    if (!definition || !switchable) {
      updateNodeData(activeNode.id, { params });
      return params;
    }
    const routed = withWiredBlockers(definition, params, wiredKey ? wiredKey.split('\n') : []);
    const routeId = shownRouteId(definition, routed, settingsCache.loaded ? settingsCache.apiKeys : {});
    const snapped = snapHidden(definition, params, routeId, key);
    updateNodeData(activeNode.id, { params: snapped.params });
    if (snapped.notes.length) useProviderNoteStore.getState().show(activeNode.id, snapped.notes);
    return snapped.params;
  }

  function onParamChange(key: string, value: unknown) {
    const next = { ...activeNodeData.params, [key]: value };
    // A model change moves a per-model default (Max Tokens) that wasn't edited,
    // and says so under that param (lib/paramDefaults.ts). A default the
    // provider snap then moved again keeps no note.
    const snap = definition ? snapParamDefaults(definition, activeNodeData.params, next) : { params: next, notes: [] };
    const written = writeEdit(snap.params, key);
    setDefaultNotes({
      nodeId: activeNode.id,
      notes: snap.notes.filter((note) => Object.is(written[note.param], snap.params[note.param])),
    });
  }

  function clearParam(key: string) {
    setDefaultNotes({ nodeId: activeNode.id, notes: [] });
    const params = { ...activeNodeData.params };
    delete params[key];
    writeEdit(params, key);
  }

  // The keys this node needs with its current params: its own, or for a
  // local node that calls a provider (Cinema Scene, vision-llm QC), the
  // keys of the base model or mode it picks.
  const requiredKeys = definition
    ? (keysNeeded(definition, activeNodeData.params) ?? []).flatMap(({ definition: need }) =>
      Array.isArray(need.envKeyName) ? need.envKeyName : [need.envKeyName])
    : [];
  const usesKreaMcp = usesKreaAccount(definition, activeNodeData.params);
  // A route-table node says what it needs in its Provider section instead.
  const missingApiKeys = activeNodeData.keyStatus === 'missing' && !usesKreaMcp && !switchable
    ? requiredKeys.filter(Boolean)
    : [];

  function getVisibleOptions(param: InspectorParamDefinition) {
    let baseOptions = param.options ?? [];

    // Quiver Arrow: union the static enum with any dynamically discovered
    // models from /api/quiver/models. Static options stay first (so the
    // current default lands where users expect); newly discovered models
    // append below with credit cost shown in the label when known.
    if (isQuiverNode && param.key === 'model' && quiverModels) {
      const isGenerate = activeNodeData.definitionId === 'quiver-arrow-generate';
      const opKey = isGenerate ? 'svg_generate' : 'svg_vectorize';
      const staticIds = new Set(baseOptions.map((o) => String(o.value)));
      const extra = quiverModels
        .filter((m) => m.supported_operations.includes(opKey) && !staticIds.has(m.id))
        .map((m) => {
          const credits = m.pricing_credits?.[opKey];
          const label = credits != null ? `${m.name} (${credits} credits)` : m.name;
          return { label, value: m.id };
        });
      baseOptions = [...baseOptions, ...extra];
    }

    return baseOptions.filter((opt) => {
      if (!('visibleWhen' in opt) || !opt.visibleWhen) return true;
      return Object.entries(opt.visibleWhen).every(([key, allowedValues]) => {
        const currentValue = activeNodeData.params[key] ?? resolvedParams.find((p) => p.key === key)?.default;
        if (currentValue === undefined || currentValue === null) return true;
        return allowedValues.includes(currentValue as string | number | boolean);
      });
    });
  }

  function renderUniversalModelControl() {
    if (!universalProvider) return null;

    const selectedModel = String(activeNodeData.params.model ?? '');
    const favoriteIds = favorites[universalProvider] ?? [];
    const isFavorite = selectedModel !== '' && favoriteIds.includes(selectedModel);

    return (
      <div className="inspector__control-stack">
        <input
          className="inspector__field"
          type="text"
          placeholder={
            modelsLoading
              ? 'Loading models...'
              : modelLoadError
                ? "Couldn't load the models."
                : 'Search models...'
          }
          value={modelSearch}
          onChange={(e) => setModelSearch(e.target.value)}
        />
        <select
          className="inspector__field"
          value={selectedModel}
          disabled={readOnly} {...lock.mark}
          onChange={(e) => {
            const selected = openRouterModels.find((m) => m.id === e.target.value);
            if (selected) {
              configureOpenRouterModel(activeNode.id, selected.id, selected);
            }
          }}
        >
          <option value="">Select a model</option>
          {filteredModels.map((model) => (
            <option key={model.id} value={model.id}>
              {favoriteIds.includes(model.id) ? '* ' : ''}{model.name} ({model.id})
            </option>
          ))}
        </select>
        {modelLoadError && universalProvider === 'nous' && (
          <div className="inspector__model-error">
            {modelLoadError}
          </div>
        )}
        {selectedModel !== '' && (
          <div className="inspector__model-selection">
            <span className="inspector__model-selection-text">Selected: {selectedModel}</span>
            <button
              type="button"
              className={
                isFavorite
                  ? 'inspector__favorite-button inspector__favorite-button--active'
                  : 'inspector__favorite-button'
              }
              title={isFavorite ? 'Remove favorite' : 'Add favorite'}
              aria-label={isFavorite ? 'Remove model from favorites' : 'Add model to favorites'}
              aria-pressed={isFavorite}
              disabled={readOnly} {...lock.mark}
              onClick={() => {
                const updated = isFavorite
                  ? favoriteIds.filter((modelId: string) => modelId !== selectedModel)
                  : [...favoriteIds, selectedModel];
                const newFavorites = { ...favorites, [universalProvider]: updated };
                setFavorites(newFavorites);
                updateSettings({ favorites: newFavorites }).catch(() => undefined);
              }}
            >
              <Star
                className="inspector__favorite-icon"
                size={14}
                strokeWidth={1.75}
                fill={isFavorite ? 'currentColor' : 'none'}
                aria-hidden="true"
                focusable="false"
              />
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderParamControl(param: InspectorParamDefinition) {
    // A value the node doesn't store shows its model's default (lib/paramDefaults.ts).
    const fallback = definition && 'defaultBy' in param && param.defaultBy
      ? paramDefaultFor(definition, param, activeNodeData.params)
      : param.default;
    const value = activeNodeData.params[param.key] ?? fallback ?? '';

    if ('disabledReason' in param && param.disabledReason) {
      return <input className="inspector__field" aria-label={param.label} value={String(value)} disabled />;
    }

    if (universalProvider && param.key === 'model') {
      return renderUniversalModelControl();
    }

    if (param.type === 'moodboard' || param.type === 'character') {
      return (
        <StoredAssetPicker
          kind={param.type}
          label={param.label}
          value={storedAssetId(param.type, activeNodeData.params)}
          readOnly={readOnly}
          onChange={(id) => onParamChange(param.key, id)}
        />
      );
    }

    if (param.type === 'enum') {
      const options = getVisibleOptions(param);
      const hasEmptyOption = options.some((opt) => opt.value === '');
      const unavailableChoice = value !== '' && !options.some((opt) => String(opt.value) === String(value));
      // A route-table node's list is cut to the shown provider's values; the
      // saved one keeps its label from the full list.
      const storedLabel = (definition ? allParamDefinitions(definition).find((p) => p.key === param.key) : param)
        ?.options?.find((opt) => String(opt.value) === String(value))?.label
        ?? param.options?.find((opt) => String(opt.value) === String(value))?.label ?? 'Saved choice';
      const unavailableNote = switchable && shownProvider ? `not on ${shownProvider}` : 'unavailable for selected model';
      return (
        <select
          className="inspector__field"
          aria-label={param.label}
          value={String(value)}
          disabled={options.length === 0 || readOnly}
          {...lock.mark}
          onChange={(e) => {
            const option = options.find((opt) => String(opt.value) === e.target.value);
            if (!param.required && param.default == null && e.target.value === '' && !option) {
              clearParam(param.key);
              return;
            }
            onParamChange(param.key, option?.value ?? e.target.value);
          }}
        >
          {unavailableChoice && <option value={String(value)} disabled>{storedLabel} ({unavailableNote})</option>}
          {options.length === 0 ? (
            <option value="">No options available</option>
          ) : (
            <>
              {param.default == null && !hasEmptyOption && <option value="">{param.required ? 'Choose…' : 'Default'}</option>}
              {options.map((opt) => (
                <option key={String(opt.value)} value={String(opt.value)}>
                  {opt.label}
                </option>
              ))}
            </>
          )}
        </select>
      );
    }

    if (param.type === 'textarea') {
      return (
        <textarea
          className="inspector__field"
          rows={3}
          value={String(value)}
          disabled={readOnly} {...lock.mark}
          onChange={(e) => onParamChange(param.key, e.target.value)}
          placeholder={param.placeholder}
        />
      );
    }

    if (param.type === 'integer' || param.type === 'float') {
      return (
        <input
          className="inspector__field"
          type="number"
          aria-label={param.label}
          value={String(value)}
          disabled={readOnly} {...lock.mark}
          onChange={(e) => {
            const next = e.target.value;
            onParamChange(param.key, next === '' ? '' : Number(next));
          }}
          onBlur={(e) => {
            if (e.target.value === '') return;
            const raw = Number(e.target.value);
            if (Number.isNaN(raw)) return;
            let clamped = raw;
            if (typeof param.min === 'number' && clamped < param.min) clamped = param.min;
            if (typeof param.max === 'number' && clamped > param.max) clamped = param.max;
            if (clamped !== raw) onParamChange(param.key, clamped);
          }}
          min={param.min}
          max={param.max}
          step={param.step ?? (param.type === 'float' ? 0.1 : 1)}
        />
      );
    }

    if (param.type === 'palette') {
      const raw = activeNodeData.params[param.key] ?? param.default ?? [];
      const swatches: string[] = Array.isArray(raw)
        ? raw.filter((s): s is string => typeof s === 'string')
        : [];
      const extracting = Boolean(paletteExtracting[param.key]);

      const writeSwatches = (next: string[]) => onParamChange(param.key, next);

      return (
        <div className="inspector__control-stack inspector__palette">
          {swatches.length === 0 ? (
            <div className="inspector__palette-empty">No swatches yet</div>
          ) : (
            <div className="inspector__palette-list">
              {swatches.map((hex, idx) => {
                const safeHex = normalizeHex(hex) ?? '#000000';
                return (
                  <div key={idx} className="inspector__palette-row">
                    <input
                      type="color"
                      className="inspector__palette-color"
                      value={safeHex}
                      disabled={readOnly} {...lock.mark}
                      aria-label={`Swatch ${idx + 1} color`}
                      onChange={(e) => {
                        const next = [...swatches];
                        next[idx] = e.target.value;
                        writeSwatches(next);
                      }}
                    />
                    <input
                      type="text"
                      className="inspector__field inspector__palette-hex"
                      value={hex}
                      disabled={readOnly} {...lock.mark}
                      spellCheck={false}
                      aria-label={`Swatch ${idx + 1} hex`}
                      onChange={(e) => {
                        const next = [...swatches];
                        next[idx] = e.target.value;
                        writeSwatches(next);
                      }}
                      onBlur={(e) => {
                        const normalized = normalizeHex(e.target.value);
                        if (normalized && normalized !== swatches[idx]) {
                          const next = [...swatches];
                          next[idx] = normalized;
                          writeSwatches(next);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="inspector__palette-remove"
                      title="Remove swatch"
                      aria-label={`Remove swatch ${idx + 1}`}
                      disabled={readOnly} {...lock.mark}
                      onClick={() => writeSwatches(swatches.filter((_, i) => i !== idx))}
                    >
                      <X
                        className="inspector__action-icon"
                        size={13}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        focusable="false"
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="inspector__palette-actions">
            <button
              type="button"
              className="inspector__action-button"
              title="Add a swatch"
              disabled={readOnly} {...lock.mark}
              onClick={() => writeSwatches([...swatches, '#808080'])}
            >
              <Plus
                className="inspector__action-icon"
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                focusable="false"
              />
              <span>Add</span>
            </button>
            <label className="inspector__file-button" title="Extract a palette from an image">
              <Upload
                className="inspector__action-icon"
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                focusable="false"
              />
              <span>{extracting ? 'Extracting...' : 'Extract from reference'}</span>
              <input
                type="file"
                accept="image/*"
                className="inspector__file-input"
                disabled={extracting || readOnly}
                {...lock.mark}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  // Reset the input so the same file can be picked again later.
                  e.target.value = '';
                  const paramKey = param.key;
                  setPaletteExtracting((prev) => ({ ...prev, [paramKey]: true }));
                  const notify = (text: string) => useGraphStore.getState().notify(text, 'error');
                  // The colours come from the picked file itself, so nothing
                  // is uploaded (it was stored in output/ only to be read
                  // back). A file the browser can't decode says so below.
                  void (async () => {
                    try {
                      // GM: "Couldn't find colors in {filename}." over why,
                      // when Nebula can tell; the heading alone otherwise.
                      const extracted = await extractPaletteFromImage(file);
                      if (extracted.ok && extracted.colors.length > 0) writeSwatches(extracted.colors);
                      else notify(paletteNotice(file.name, extracted.ok ? 'other' : extracted.reason));
                    } finally {
                      setPaletteExtracting((prev) => {
                        const next = { ...prev };
                        delete next[paramKey];
                        return next;
                      });
                    }
                  })();
                }}
              />
            </label>
          </div>
        </div>
      );
    }

    if (param.type === 'file') {
      const fileValue = String(value);
      // The name it was uploaded with (the stored copy's name is a hash).
      const loadedFilename = fileValue
        ? (param.key === 'filePath' ? inputFileName(activeNodeData.params) : null) ?? fileValue.split(/[\\/]/).pop() ?? fileValue
        : null;
      const isVideoNode = activeNodeData.definitionId === 'video-input' || activeNodeData.definitionId === 'audio-input';
      const isDocNode = activeNodeData.definitionId === 'document-input';
      const acceptAttr = isDocNode
        ? '.pdf,.txt,.md,.markdown,.csv,.json,.log,.rst,.tsv,application/pdf,text/*'
        : isVideoNode
          ? 'video/*,audio/*'
          : 'image/*,video/*,audio/*';
      return (
        <div className="inspector__control-stack">
          <label className="inspector__file-button">
            <Upload
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>{loadedFilename ?? 'Choose File'}</span>
            <input
              type="file"
              accept={acceptAttr}
              disabled={readOnly} {...lock.mark}
              className="inspector__file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const formData = new FormData();
                formData.append('file', file);
                // GM, error-copy round 2: "Couldn't upload {filename}." then the
                // reason, in the canvas notice (as a canvas drop says it).
                const heading = `Couldn't upload ${quoted(file.name)}.`;
                apiRequest(heading, '/api/uploads', { method: 'POST', body: formData })
                  .then((r) => r.json())
                  .then((data: { filePath: string; url: string }) => {
                    // filePath's card names the file (lib/fileName.ts), as
                    // /api/uploads keeps it for a node it creates.
                    const kept = param.key === 'filePath' ? fileNameParam(data.filePath, file.name) : null;
                    updateNodeData(activeNode.id, {
                      params: { ...activeNodeData.params, [param.key]: data.filePath, _previewUrl: backendAssetUrlSync(data.url),
                        ...(kept ? { _fileName: kept } : {}) },
                    });
                  })
                  .catch((err) => useGraphStore.getState().notify(failureMessage(err, heading), 'error'));
              }}
            />
          </label>
          {!isDocNode && !isVideoNode && typeof activeNodeData.params._previewUrl === 'string' && (
            <img
              src={String(activeNodeData.params._previewUrl)}
              alt="Preview"
              className="inspector__file-preview"
            />
          )}
        </div>
      );
    }

    if (param.type === 'boolean') {
      if (!param.required && param.default == null) {
        return (
          <select
            className="inspector__field"
            aria-label={param.label}
            value={value === true ? 'true' : value === false ? 'false' : ''}
            disabled={readOnly} {...lock.mark}
            onChange={(e) => {
              if (e.target.value === '') clearParam(param.key);
              else onParamChange(param.key, e.target.value === 'true');
            }}
          >
            <option value="">Default</option>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        );
      }
      return (
        <label className="inspector__checkbox-row">
          <input
            type="checkbox"
            checked={Boolean(activeNodeData.params[param.key] ?? param.default)}
            disabled={readOnly} {...lock.mark}
            onChange={(e) => onParamChange(param.key, e.target.checked)}
          />
          <span className="inspector__checkbox-copy">{param.label}</span>
        </label>
      );
    }

    return (
      <input
        className="inspector__field"
        type="text"
        value={String(value)}
        disabled={readOnly} {...lock.mark}
        onChange={(e) => onParamChange(param.key, e.target.value)}
        placeholder={param.placeholder}
      />
    );
  }

  function renderParamSection(param: InspectorParamDefinition, source: 'definition' | 'dynamic') {
    const showLabel = param.type !== 'boolean' || (!param.required && param.default == null);
    return (
      <div
        key={`${source}-${param.key}`}
        className="inspector__section inspector__section--param"
        data-inspector-param={param.key}
        data-inspector-kind={param.type}
        data-inspector-source={source}
      >
        {showLabel && <div className="inspector__label">{param.label}</div>}
        {renderParamControl(param)}
        {'disabledReason' in param && param.disabledReason && (
          <div className="inspector__notice" role="note">{param.disabledReason}</div>
        )}
        {source === 'definition' && makerSizeNote && param.key === makerSizeNote.param && (
          <div className="inspector__notice" role="note" data-inspector-size-note="true">{makerSizeNote.text}</div>
        )}
        {source === 'definition' && defaultNotes.nodeId === activeNode.id
          && defaultNotes.notes.filter((note) => note.param === param.key).map((note) => (
            <div key={note.text} className="inspector__notice" role="note" data-inspector-default-note="true">{note.text}</div>
          ))}
        {activeNodeData.definitionId === 'replicate-universal' && param.key === 'model_id' && (
          <button
            type="button"
            className="inspector__action-button inspector__action-button--full inspector__action-button--stacked"
            disabled={schemaLoading || !activeNodeData.params.model_id || readOnly}
            {...lock.mark}
            onClick={async () => {
              const modelId = String(activeNodeData.params.model_id ?? '');
              if (!modelId.includes('/')) return;
              const [owner, name] = modelId.split('/', 2);
              setSchemaLoading(true);
              try {
                await fetchReplicateSchemaAndConfigure(activeNode.id, owner, name);
              } finally {
                setSchemaLoading(false);
              }
            }}
          >
            <RefreshCw
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>{schemaLoading ? 'Fetching...' : (activeNodeData.params._schema_fetched ? 'Refresh Schema' : 'Fetch Schema')}</span>
          </button>
        )}
      </div>
    );
  }

  const body = (
    <div className={embedded ? 'inspector__body' : 'panel__body inspector__body'} key={renderNode.id}>
      <div className="inspector__node-header">
        <span
          className="inspector__node-dot"
          style={{
            backgroundColor: CATEGORY_COLORS[definition?.category ?? 'universal'],
          }}
        />
        <span className="inspector__node-name">{nodeData.label}</span>
        {definition && (
          <button
            type="button"
            className="inspector__info-button"
            onClick={() => setShowInfo(!showInfo)}
            title="Node info — inputs, outputs, and settings"
            aria-label={showInfo ? 'Hide node info' : 'Show node info'}
            aria-expanded={showInfo}
          >
            {showInfo ? (
              <X
                className="inspector__info-icon"
                size={13}
                strokeWidth={1.75}
                aria-hidden="true"
                focusable="false"
              />
            ) : (
              <Info
                className="inspector__info-icon"
                size={13}
                strokeWidth={1.75}
                aria-hidden="true"
                focusable="false"
              />
            )}
          </button>
        )}
      </div>

      {definition && switchable && (
        <ProviderSwitcher definition={definition} params={activeNodeData.params} variant="inspector" wired={wiredCounts}
          onPick={(next, notes) => {
            updateNodeData(activeNode.id, { params: next });
            useProviderNoteStore.getState().show(activeNode.id, notes);
          }} />
      )}

      {missingApiKeys.length > 0 && (
        <div className="inspector__notice inspector__notice--warning" role="status">
          Missing API key: {missingApiKeys.join(', ')}
        </div>
      )}
      {usesKreaMcp && activeNodeData.keyStatus === 'missing' && !switchable && (
        <div className="inspector__notice inspector__notice--warning" role="status">
          Krea sign-in required. Connect or check Krea in Settings.
        </div>
      )}

      {definition?.capabilityNote && (
        <div className="inspector__notice" role="note">
          {definition.capabilityNote}
        </div>
      )}

        {showInfo && definition && (
          <div className="inspector__info-panel">
            <div className="inspector__info-section">
              <div className="inspector__info-heading">Inputs</div>
              {definition.inputPorts.length === 0 ? (
                <div className="inspector__info-row">None</div>
              ) : (
                definition.inputPorts.map((p) => (
                  <div key={p.id} className="inspector__info-row">
                    <span className="inspector__info-dot" style={{ backgroundColor: PORT_COLORS[p.dataType as keyof typeof PORT_COLORS] ?? '#9E9E9E' }} />
                    <span className="inspector__info-name">{p.label}</span>
                    <span className="inspector__info-type">{p.dataType}{p.required ? '' : ' (optional)'}{p.multiple ? ' +' : ''}</span>
                  </div>
                ))
              )}
            </div>
            <div className="inspector__info-section">
              <div className="inspector__info-heading">Outputs</div>
              {definition.outputPorts.length === 0 ? (
                <div className="inspector__info-row">None</div>
              ) : (
                definition.outputPorts.map((p) => (
                  <div key={p.id} className="inspector__info-row">
                    <span className="inspector__info-dot" style={{ backgroundColor: PORT_COLORS[p.dataType as keyof typeof PORT_COLORS] ?? '#9E9E9E' }} />
                    <span className="inspector__info-name">{p.label}</span>
                    <span className="inspector__info-type">{p.dataType}</span>
                  </div>
                ))
              )}
            </div>
            <div className="inspector__info-section">
              <div className="inspector__info-heading">Settings</div>
              {visibleParams.length === 0 ? (
                <div className="inspector__info-row">None</div>
              ) : (
                visibleParams.map((p) => (
                  <div key={p.key} className="inspector__info-row">
                    <span className="inspector__info-name">{p.label}</span>
                    <span className="inspector__info-type">
                      {p.type}{p.default !== undefined && p.default !== '' ? ` = ${p.default}` : ''}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="inspector__info-meta">
              Provider: {definition.apiProvider} &middot; {definition.executionPattern}
            </div>
          </div>
        )}

        {/* A Jev node's result comes first: it's what the node is for. */}
        {nodeData.state === 'complete' && isJevNode(nodeData.definitionId) && (() => {
          const jevResult = parseJevOutputs(nodeData.definitionId, nodeData.outputs);
          return jevResult ? <JevResultDetails result={jevResult} params={nodeData.params} /> : null;
        })()}

        {visibleParams.map((param) => renderParamSection(param, 'definition'))}

        {/* The run's values that aren't media (a Moodboard bundle, a list, an
            object...), whole: the card shows them clamped, and this is where
            the full brief or JSON can be read and copied. */}
        {nodeData.state === 'complete' && !(isJevNode(nodeData.definitionId) && parseJevOutputs(nodeData.definitionId, nodeData.outputs)) && (() => {
          const entries = structuredOutputEntries(nodeData.outputs);
          if (entries.length === 0) return null;
          const labels = Object.fromEntries([...(definition?.displayOutputs ?? []), ...(definition?.outputPorts ?? [])]
            .map((port) => [port.id, port.label]));
          return (
            <section className="inspector__section inspector__last-output" aria-label="Last output">
              <div className="inspector__label">Last output</div>
              <StructuredOutputs outputs={entries} variant="full" labels={labels} definitionId={nodeData.definitionId} />
            </section>
          );
        })()}

        {/* What the last run said beside its outputs (the executed event's
            notes), e.g. the size a maker made when it couldn't make the one
            asked for. */}
        {nodeData.runNotes && nodeData.runNotes.length > 0 && (
          <div className="inspector__section" data-inspector-run-notes="true">
            <div className="inspector__label">Last run</div>
            {nodeData.runNotes.map((note) => (
              <div key={note} className="inspector__notice" role="note">{note}</div>
            ))}
          </div>
        )}

        {/* Mask Painter: paint the mask over the connected upstream image. The
            painted data rides params._maskData (white = painted; polarity is
            applied at execution by the backend mask-painter branch). */}
        {nodeData.definitionId === 'mask-painter' && (() => {
          const imageEdge = edges.find(
            (e) => e.target === renderNode.id && (e.targetHandle ?? 'image') === 'image',
          );
          const sourceNode = imageEdge ? nodes.find((n) => n.id === imageEdge.source) : undefined;
          const sourceOutputs = (sourceNode?.data as NodeData | undefined)?.outputs ?? {};
          const sourceParams = (sourceNode?.data as NodeData | undefined)?.params ?? {};
          const upstreamImage = (() => {
            const out = Object.values(sourceOutputs).find(
              (o) => o && o.type === 'Image' && typeof o.value === 'string' && o.value,
            );
            if (out) return backendAssetUrlSync(String(out.value));
            // image-input nodes carry their picked file as a preview param
            // before any execution has happened.
            if (sourceParams._previewUrl) return backendAssetUrlSync(String(sourceParams._previewUrl));
            return null;
          })();
          const maskData = typeof nodeData.params._maskData === 'string' ? nodeData.params._maskData : null;
          const maskOutEdge = edges.find(
            (edge) => edge.source === renderNode.id && (edge.sourceHandle ?? 'mask') === 'mask',
          );
          const editTarget = maskOutEdge
            ? nodes.find((node) => node.id === maskOutEdge.target)
            : undefined;
          const editDefId = (editTarget?.data as NodeData | undefined)?.definitionId;
          const editDef = editDefId ? NODE_DEFINITIONS[editDefId] : undefined;
          const editNeedsBaseImage = Boolean(
            editDef?.inputPorts.some((port) => port.id === 'image')
            && editDef?.inputPorts.some((port) => port.id === 'mask'),
          );
          const editHasBaseImageWire = editNeedsBaseImage && editTarget && edges.some(
            (edge) => edge.target === editTarget.id && (edge.targetHandle ?? 'image') === 'image',
          );
          return (
            <div className="inspector__section">
              <div className="inspector__label">Mask</div>
              <div className="mask-painter__inspector-row">
                <button
                  type="button"
                  className="mask-painter__paint-btn"
                  disabled={readOnly} {...lock.mark}
                  onClick={() => setMaskPainterOpen(true)}
                  onPointerEnter={() => void DeferredMaskPainterModal.preload().catch(() => {})}
                  onFocus={() => void DeferredMaskPainterModal.preload().catch(() => {})}
                >
                  <Brush size={13} /> {maskData ? 'Edit Mask' : 'Paint Mask'}
                </button>
                <span className="mask-painter__status">
                  {maskData ? 'Mask painted' : 'No mask yet'}
                </span>
              </div>
              {maskData && <img src={maskData} alt="Painted mask" className="mask-painter__thumb" />}
              {editNeedsBaseImage && !editHasBaseImageWire && (
                <p className="mask-painter__hint">
                  Connect the source image to the edit node&apos;s Image port too — mask-painter only passes the mask.
                  Reconnect the mask, and Nebula connects the base image for you.
                </p>
              )}
              {maskPainterOpen && (
                <MaskPainterModal
                  imageUrl={upstreamImage}
                  initialMask={maskData}
                  onSave={(dataUri) => {
                    onParamChange('_maskData', dataUri);
                    setMaskPainterOpen(false);
                  }}
                  onClose={() => setMaskPainterOpen(false)}
                />
              )}
            </div>
          );
        })()}

        {/* Dynamic params for dynamic nodes */}
        {(() => {
          const dynData = nodeData as unknown as DynamicNodeData;
          const hasDynamicParams = dynData?.isDynamic && dynData.dynamicParams?.length > 0;
          if (!hasDynamicParams) return null;
          return dynData.dynamicParams.map((param) => renderParamSection(param, 'dynamic'));
        })()}

        <div className="inspector__section inspector__section--separated">
          <div className="inspector__label">State</div>
          <div className="inspector__state-value">{nodeData.state}</div>
          {nodeData.state === 'skipped' && (
            <div className="inspector__state-value inspector__state-reason">{skippedLabel(nodeData.skipReason)}</div>
          )}
        </div>

        {/* Actions: in the floating Inspector's foot, outside its scrolling
            body, so the row is always whole (GM - Design, 2026-10-23). */}
        <InspectorFoot>
        <div className="inspector__section inspector__actions">
          <button
            type="button"
            className="inspector__action-button"
            {...lock.act({ title: 'Run this node and its dependencies', kept: 'run' })}
            onClick={() => executeNode(renderNode.id)}
          >
            <Play
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>Run</span>
          </button>
          <button
            type="button"
            className="inspector__action-button"
            {...lock.act({ title: 'Duplicate this node', kept: 'live' })}
            onClick={() => duplicateNode(renderNode.id)}
          >
            <Copy
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>Duplicate</span>
          </button>
          <button
            type="button"
            className="inspector__action-button inspector__action-button--danger"
            {...lock.act({ title: 'Delete this node', kept: 'delete' })}
            onClick={() => {
              // A World Labs hold refuses, with its notice; otherwise it deletes at
              // once and says "Deleted the node." with Undo (GM, 2026-10-23).
              if (useGraphStore.getState().allowCanvasDelete([renderNode.id])) deleteNode(renderNode.id);
            }}
          >
            <Trash2
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>Delete</span>
          </button>
        </div>
        </InspectorFoot>
      </div>
  );

  if (embedded) {
    return (
      <div
        className={`inspector inspector--embedded inspector-shell${exiting ? ' inspector--exiting' : ''}`}
        data-inspector-embedded="true"
      >
        {body}
      </div>
    );
  }

  return (
    <div
      className={`panel panel--inspector inspector-shell${exiting ? ' panel--exiting' : ''}`}
      style={{ left: resolvedX, top: position.y }}
    >
      <div
        className="panel__header"
        onMouseDown={handleHeaderMouseDown}
      >
        <span className="panel__title">Inspector</span>
        <button
          type="button"
          className="panel__header-action panel__close"
          onClick={() => togglePanel('inspector')}
          aria-label="Close inspector panel"
          title="Close"
        >
          <X
            className="panel__close-icon"
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            focusable="false"
          />
        </button>
      </div>

      {body}
    </div>
  );
}
