export * from './spatial';
import type {
  CameraPose, CameraPath, SpatialContext, DepthMap, DepthSequence,
  PointCloud, SensorRig, SensorStream, SpatialSessionMetadata, WorldValueV2,
} from './spatial';
import type { PaperSourceSnapshot } from '../lib/paperSource';

export type PortDataType =
  | 'Text'
  | 'Image'
  | 'Video'
  | 'Audio'
  | 'Mask'
  | 'Array'
  | 'SVG'
  | 'Mesh'
  | 'World'
  | 'CameraPose'
  | 'CameraPath'
  | 'SpatialContext'
  | 'DepthMap'
  | 'DepthSequence'
  | 'PointCloud'
  | 'SensorRig'
  | 'SensorStream'
  | 'SpatialSession'
  | 'Character'
  | 'Moodboard'
  | 'CameraRig'
  | 'ReferenceSet'
  | 'Any';

export type NodeCategory =
  | 'image-gen'
  | 'video-gen'
  | 'text-gen'
  | 'audio-gen'
  | '3d-gen'
  | 'transform'
  | 'analyzer'
  | 'utility'
  | 'universal'
  | 'cinematic'
  | 'character'
  | 'moodboard';

export type NodeState = 'idle' | 'queued' | 'executing' | 'complete' | 'error';

export type ExecutionPattern = 'sync' | 'async-poll' | 'stream';

export type APIProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'runway'
  | 'kling'
  | 'elevenlabs'
  | 'replicate'
  | 'fal'
  | 'bytedance'
  | 'minimax'
  | 'luma'
  | 'xai'
  | 'recraft'
  | 'ideogram'
  | 'openrouter'
  | 'bfl'
  | 'higgsfield'
  | 'meshy'
  | 'quiver'
  | 'krea'
  | 'worldlabs'
  | 'nous'
  | 'utility';

export interface PortDefinition {
  id: string;
  label: string;
  dataType: PortDataType;
  required: boolean;
  multiple?: boolean;
  maxConnections?: number;
  /** Semantic reference role (one of REFERENCE_ROLES: style, identity,
   *  composition, pose, lighting, subject, background). Advisory metadata only
   *  — never affects port compatibility. Drives UI role badges and handler
   *  intelligence for image reference ports. */
  role?: string;
  /** Advisory reference weight, 0.0-1.0. Absent behaves as 1.0. Displayed as a
   *  filled bar indicator; consumed by reference-bundle packing. */
  weight?: number;
}

export interface ParamOption {
  label: string;
  value: string | number;
  /** Show this option only when another param's value is in the given list. */
  visibleWhen?: Record<string, (string | number | boolean)[]>;
}

export interface ParamDefinition {
  key: string;
  label: string;
  type: 'string' | 'integer' | 'float' | 'boolean' | 'enum' | 'textarea' | 'file' | 'palette';
  required: boolean;
  default?: unknown;
  options?: ParamOption[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  condition?: string;
  /** Show this param only when another param's value is in the given list.
   *  e.g. { model: ['gemini-3.1-flash-image', 'gemini-3-pro-image'] } */
  visibleWhen?: Record<string, (string | number | boolean)[]>;
  /** Internal/editor-managed param. Declared so the backend validator accepts
   *  it as a known key (see backend/main.py::_valid_param_keys), but never
   *  rendered as an editable field in the Inspector. Used for complex state
   *  that has a dedicated editor surface — e.g. cinema-scene's `scene` spec,
   *  authored via the Cinema Studio rather than a generic param control. */
  hidden?: boolean;
  /** Stored for compatibility, but unavailable in the current model adapter. */
  disabledReason?: string;
}

export interface ModelNodeDefinition {
  id: string;
  displayName: string;
  category: NodeCategory;
  apiProvider: APIProvider;
  apiEndpoint: string;
  envKeyName: string | string[];
  executionPattern: ExecutionPattern;
  /** Short, user-facing provider limitation shown in both Canvas and Create. */
  capabilityNote?: string;
  inputPorts: PortDefinition[];
  outputPorts: PortDefinition[];
  params: ParamDefinition[];
  /** Dual-route nodes: a fal or Krea copy that also runs on its maker's API
   *  with the person's key. Inspector and Create render sharedParams plus the
   *  group of the route the run takes (lib/directRoute.ts selectRoute, the
   *  backend's services/node_route.py): directParams on the maker key,
   *  falParams on the fal or Krea copy (for a Krea node, its Krea-only
   *  fields) and on the Krea plan. A Krea node keeps its full list in
   *  `params` too; other dual-route nodes leave `params` empty. */
  sharedParams?: ParamDefinition[];
  falParams?: ParamDefinition[];
  directParams?: ParamDefinition[];
  /** Which env key name selects the "direct" route (vs fal or Krea). e.g.
   *  'MESHY_API_KEY' or 'GOOGLE_API_KEY'. A list means any of them, tried in
   *  order (Veo: Vertex, then Gemini API). */
  directKeyName?: string | string[];
  /** A dual-route node's maker-route rules (lib/directRoute.ts directBlock,
   *  backend services/node_route.py direct_block, one rule set on both). A
   *  generated Krea node (scripts/sync-krea-catalog.py DIRECT_ROUTES) names
   *  the backend translation and the maker's model id; a fal node may carry
   *  only the rules. What keeps a run on the copy:
   *  - `blockedBy`: copy-only params the maker can't honor, set or wired;
   *  - `accepts`: the values the maker takes for a param (any other blocks);
   *  - `rejects`: values of a param the maker doesn't take;
   *  - `rejectsWhen`: combinations it doesn't take ("(set)" = set or wired,
   *    "(unset)" = neither);
   *  - `size`: the maker's documented output size limits.
   *  `snap` isn't a rule: a maker that takes a fixed size list gets the
   *  nearest entry on its route (lib/makerSizes.ts).
   *  A rule never blocks a param's default. `setup: 'fallback'` points setup
   *  at the copy's key when no key is set (BytePlus, which doesn't serve the
   *  United States and needs each model activated, is not the key to suggest
   *  first; lib/providerReadiness.ts). */
  directRoute?: {
    translation?: string; model?: string; blockedBy?: string[]; setup?: 'fallback';
    accepts?: Record<string, DirectAcceptRule>;
    rejects?: Record<string, ReadonlyArray<string | number | boolean>>;
    rejectsWhen?: DirectRejectsWhenRule[];
    size?: DirectSizeLimits;
    snap?: DirectSizeSnap;
  };
  docUrl?: string;
  /** A local (utility) node that still calls a provider. `utility` only means
   *  "no top-level key"; this says what the node really needs. Readiness, the
   *  missing-key badge, the run estimate and the agent surfaces all read it
   *  (lib/nodeKeys.ts, backend services/node_readiness.py). */
  providerVia?: ProviderVia;
}

/** The values a maker takes for one param (directRoute.accepts); any other
 * saved or default value keeps the run on the copy. */
export interface DirectAcceptRule {
  values?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  integer?: boolean;
}

/** A combination of param values the maker doesn't take
 * (directRoute.rejectsWhen): it blocks when every `match` entry holds, where
 * "(set)" means saved non-empty or wired into its port and "(unset)" means
 * neither. `label` says what it
 * is in readiness ("1080p at 10 seconds"). */
export interface DirectRejectsWhenRule {
  match: Readonly<Record<string, string | number | boolean>>;
  label: string;
}

/** A maker that takes a fixed size list on its direct route (backend
 *  services/maker_sizes.py SNAPS, copied here by scripts/sync-krea-catalog.py).
 *  `kind` 'size': the choices are exact pixel sizes (Ideogram 3, Runway Gen-4
 *  Image); 'shape': aspect ratios, and the maker picks the pixels (Ideogram
 *  2a). `sep` is how the maker spells a choice ("1312x736", "1360:768"), and
 *  `field` the request field it goes in. */
export interface DirectSizeSnap {
  widthParam: string;
  heightParam: string;
  maker: string;
  field: string;
  kind: 'size' | 'shape';
  sep: string;
  choices: string[];
}

/** A maker's documented output size rules for its direct route
 *  (backend services/node_route.py _size_block). `widthParam`/`heightParam`
 *  name an explicit size (a Krea copy's width/height); `param` names a size
 *  choice whose `unsupported` values, or a `{width, height}` outside the
 *  limits, keep the run on the copy. */
export interface DirectSizeLimits {
  minPixels?: number;
  maxPixels?: number;
  maxAspect?: number;
  widthParam?: string;
  heightParam?: string;
  param?: string;
  unsupported?: string[];
}

/** How a utility node reaches a provider.
 *  - `model`: it runs another node's handler, picked by the value at `path`
 *    (cinema-scene's scene.base.model). Keys come from that model's own
 *    definition. `models` is the allowlist, `default` what an empty value
 *    runs, `fallbackFor` the values that also run the default. The backend
 *    handler's own constants stay the security boundary; a parity test pins
 *    this list to them.
 *  - `param`: one param picks local or provider work. Only the values in
 *    `freeWhen` run locally; any other value (including an empty or unknown
 *    one) needs one of `anyKey` and has no list price. */
export type ProviderVia =
  | { kind: 'model'; path: string[]; models: string[]; default: string; fallbackFor: string[] }
  | { kind: 'param'; param: string; freeWhen: string[]; anyKey: string[]; provider: string };

/** A single shot within a cinema-scene storyboard. Each shot carries its own
 *  prompt and (optionally) overrides the shared palette/look, and produces one
 *  dynamic Image output port keyed off its id. */
export interface CinemaShot {
  id: string;
  prompt: string;
  /** Per-shot composition refs (optional), layered on top of the shared character refs. */
  refImageUrls?: string[];
  /** Lets one shot deviate from the shared palette/look without breaking the rest. */
  overrides?: { palette?: Partial<CinemaSceneSpec['palette']>; look?: Partial<CinemaSceneSpec['look']> };
  output?: { imageUrl?: string; status: 'idle' | 'running' | 'done' | 'error'; error?: string; hash?: string };
  /** Candidate variations of this shot (one base-model run per distinct seed).
   *  The canonical image (output.imageUrl, the dynamic port, Send-to-motion) is
   *  the `selectedVariation`. Persists on the scene spec so save/load keeps them. */
  variations?: { url: string; seed: number }[];
  selectedVariation?: number;
}

/** The editor-managed spec stored on `cinema-scene` node's `data.params.scene`
 *  — exactly how `remotion-node` stores `data.params.manifest`. Shared
 *  character/palette/look across many shots; each shot has its own prompt. */
export interface CinemaSceneSpec {
  version: 1;
  /** e.g. 'seedream-4-5' | 'nano-banana' | 'flux-kontext'. */
  base: { model: string; params?: Record<string, unknown> };
  /** Shared character identity via reference-edit. */
  character?: { refImageUrls: string[]; strength: number; sheetUrl?: string };
  palette?: { swatches: string[]; sourceImageUrl?: string; strength: number; method: 'lab-transfer' | 'reinhard' | 'histogram' };
  look?: {
    /** 'kodak-portra' | 'fuji-400h' | 'cinestill-800t' | 'bw-tri-x' | 'teal-orange' | 'custom'. */
    preset?: string;
    /** Sliders are 'custom'-mode only. A named preset omits them so they can't
     *  clobber the preset's grade in the backend (which lets explicit floats
     *  override a preset). Optional for that reason. */
    grain?: number; halation?: number; vignette?: number;
    contrast?: number; saturation?: number; temperature?: number;
    /** Optional .cube LUT id. */
    lutId?: string;
  };
  /** '16:9' | '2.39:1' | '4:5' | '1:1' | '9:16'. */
  aspectRatio: string;
  shots: CinemaShot[];
}

/** A persistent, reusable identity asset that flows through the graph on a
 *  Character-typed port. The frozenTraitString is re-emitted VERBATIM into
 *  prompts — paraphrase breaks identity (Seedance finding). */
export interface Character {
  id: string;
  name: string;
  version: number;
  subjectType: 'human' | 'non-human' | 'stylized';
  referenceViews: string[];        // the multi-view bundle (required, >=3); /api/outputs or /api/uploads URLs
  frozenTraitString: string;       // re-emitted VERBATIM into prompts — paraphrase breaks identity (Seedance finding)
  seed: number;                    // fixed seed for repeatability (Pheme "seed 84" pattern)
  consistencyStrength: number;     // retained metadata; current reference adapters expose no adherence control
  thumbnail: string;               // auto-picked from referenceViews
  projectId?: string;              // project-scoped; absent = global
  createdAt: string;
  updatedAt: string;
}

/** Lightweight bundle passed on a Character port between nodes.
 *
 *  The identity fields (characterId..consistencyStrength) come VERBATIM from the
 *  stored Character. The optional override* fields are the PER-USE override
 *  layer read from the `character` node's own params (override_prompt /
 *  override_refs / strength_override) — pose/expression/wardrobe/framing
 *  direction layered on top of the stored asset. They are applied by the
 *  consumer (cinema-scene / edit nodes) via expand_character, not by the
 *  character node itself. Absent/empty = no override for that field. */
export interface CharacterBundle {
  characterId: string;
  name: string;
  referenceViews: string[];
  frozenTraitString: string;
  seed: number;
  consistencyStrength: number;
  /** Per-use prompt direction folded in AFTER the base prompt (empty = none). */
  overridePrompt?: string;
  /** Per-use extra reference images, appended after referenceViews (empty = none). */
  overrideRefs?: string[];
  /** Retained per-use strength metadata; current reference adapters do not apply it.
   *  null/absent = inherit the stored metadata. */
  strengthOverride?: number | null;
}

/** Typed bundle emitted by the camera-rig utility node on its CameraRig port.
 *  Cinema translates these inspectable values into labeled prompt guidance;
 *  they are not native model camera controls. */
export interface CameraRigBundle {
  height: number;          // camera height in meters
  pitch: number;           // degrees, -90 (straight down) to 90 (straight up)
  yaw: number;             // degrees, 0 to 360 around the subject
  roll: number;            // degrees, -45 to 45 (Dutch angle)
  focalLength: number;     // mm, 10 to 200
  subjectDistance: number; // meters, 0.5 to 50
  focusDistance: number;   // meters, 0.5 to 100
  subjectScreenX: number;  // 0 to 1 (normalized subject position in frame)
  subjectScreenY: number;  // 0 to 1 (normalized subject position in frame)
}

/** Typed bundle emitted by the reference-set utility node on its ReferenceSet
 *  port. Each item pairs an image URL with the semantic role of the port it
 *  was connected to and that port's weight. Items are sorted by weight
 *  (descending) so downstream handlers can read precedence directly. */
export interface ReferenceSetBundle {
  items: Array<{
    url: string;    // image URL or local path
    role: string;   // one of the 7 standard roles (see referenceRoles.ts)
    weight: number; // 0.0-1.0
  }>;
}

/** A locally materialized World Labs environment.
 *
 * The World port deliberately stays structured: the splat, navigation link,
 * panorama, collider, scale, and coordinate convention describe one spatial
 * result and must not drift apart as separate graph values. Provider URLs are
 * materialized by the backend before this value reaches the canvas. */
export interface WorldValue {
  schemaVersion: 1;
  provider: 'worldlabs';
  worldId: string;
  model: string;
  displayName: string;
  marbleUrl?: string;
  promptType: 'text' | 'image' | 'multi-image' | 'video' | string;
  assets: {
    splats: Record<string, string | undefined> & {
      '100k'?: string;
      '150k'?: string;
      '500k'?: string;
      full_res?: string;
    };
    panorama?: string;
    colliderMesh?: string;
    thumbnail?: string;
  };
  semantics: {
    metricScaleFactor?: number;
    groundPlaneOffset?: number;
    coordinateFrame: 'marble_raw_opencv' | string;
  };
  caption?: string;
  cost?: Record<string, unknown> | number;
}

export interface MoodboardImage {
  id: string;
  url: string;
  weight: number;
  notes: string;
  excluded: boolean;
}

export interface MoodboardAnalysis {
  version: number;
  sourceHash: string;
  mode: 'look' | 'world' | 'subject';
  modeIntent: string;
  strength: number;
  summary: string;
  tasteProfile: string;
  styleBrief: string;
  negativePrompt: string;
  keywords: string[];
  avoids: string[];
  palette: string[];
  lighting: string;
  composition: string;
  materials: string[];
  textures: string[];
  motifs: string[];
  subjectBias: string[];
  representativeImages: string[];
  providerHints: Record<string, unknown>;
  images: Array<Record<string, unknown>>;
  warnings: string[];
}

export interface Moodboard {
  id: string;
  name: string;
  version: number;
  images: MoodboardImage[];
  notes: string;
  mode: 'look' | 'world' | 'subject';
  strength: number;
  analysis: MoodboardAnalysis | null;
  thumbnail: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortValue {
  type: PortDataType;
  value: string | string[] | { url: string; mimeType: string } | WorldValue
    | CameraPose | CameraPath | SpatialContext | DepthMap | DepthSequence
    | PointCloud | SensorRig | SensorStream | SpatialSessionMetadata | WorldValueV2
    | Record<string, unknown> | ArrayBuffer | null;
}

export interface PaperRunInput {
  nodeId: string;
  sourceId: string;
  snapshot: PaperSourceSnapshot;
}

/** Attribution of the visible output, independent of mutable source previews. */
export interface PaperOutputFreshness {
  runId?: string;
  recipeRevision?: string;
  paperInputs: PaperRunInput[];
  outOfDateReasons: string[];
}

/** A repeated invocation's display attribution. Canonical port values stay scalar. */
export interface VariantScope {
  index: number;
  label: string;
  lineage: Array<{
    source_node_id: string;
    source_label: string;
    index: number;
    item_label: string;
  }>;
}

export interface NodeData {
  [key: string]: unknown;
  label: string;
  definitionId: string;
  params: Record<string, unknown>;
  state: NodeState;
  progress?: number;
  /** UI-only: when this node's current run started (ms since epoch). */
  runStartedAt?: number;
  outputs: Record<string, PortValue>;
  /** UI-only cumulative previews; excluded from recipe and graph-file data. */
  batchOutputs?: Array<Record<string, PortValue>>;
  batchVariants?: VariantScope[];
  batchRunId?: string;
  /** What the last run said beside its outputs (the executed event's
   *  notes), kept with the results like `outputs`, never part of the recipe; e.g. "Ideogram made 1312x736, the closest it could get
   *  to your 1000x560." */
  runNotes?: string[];
  outputFreshness?: PaperOutputFreshness;
  error?: string;
  /** Friendly classification of `error` (see backend error_classifier). `error`
   *  still holds the raw provider string for the expandable debug details. */
  errorCategory?: string;
  errorFriendly?: string;
  keyStatus?: 'ok' | 'missing';
  streamingText?: string;
  streamingPartials?: { index: number; src: string }[];
  /** Latest partial SVG markup during a Quiver Arrow stream. Replaced
   *  by the final SVG once the `content` event lands. Stored as raw
   *  markup; ModelNode renders inline via a data URI so no disk write
   *  is needed for the progressive preview. */
  streamingSvg?: { index: number; svg: string; isFinal: boolean };
  /** Marks Edit nodes that were auto-spawned this session. Used by
   *  graphStore.removeEmptyEditNode (Task 10) to auto-remove no-op
   *  Edit nodes when the editor is exited without making real edits. */
  spawnedThisSession?: boolean;
  _createOrigin?: CreateOriginTag;
}

export interface CreateOriginTag {
  sessionId: string;
  genId: string;
  ts: number;
  prompt: string;
}

export interface GenerationRequest {
  definitionId: string;
  prompt: string;
  params: Record<string, unknown>;
  refPaths: string[];
  quantity: number;
  sessionId: string;
  genId: string;
  layoutOrigin: { x: number; y: number };
}

export interface DynamicPortDefinition {
  id: string;
  label: string;
  dataType: PortDataType;
  required: boolean;
  multiple?: boolean;
  maxConnections?: number;
  /** Semantic reference role — advisory metadata, same contract as
   *  PortDefinition.role. */
  role?: string;
  /** Advisory reference weight, 0.0-1.0. Absent behaves as 1.0. */
  weight?: number;
}

export interface DynamicParamDefinition {
  key: string;
  label: string;
  type: 'string' | 'integer' | 'float' | 'boolean' | 'enum' | 'textarea' | 'file';
  required: boolean;
  default?: unknown;
  options?: Array<{ label: string; value: string | number }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export interface DynamicNodeData extends NodeData {
  [key: string]: unknown;
  isDynamic: true;
  providerType: 'openrouter' | 'replicate' | 'fal' | 'nous';
  modelId?: string;
  dynamicInputPorts: DynamicPortDefinition[];
  dynamicOutputPorts: DynamicPortDefinition[];
  dynamicParams: DynamicParamDefinition[];
  /** Provider-specific metadata (e.g. Replicate version_id, FAL endpoint_id) */
  providerMeta: Record<string, unknown>;
}

export type CanvasMode =
  | 'idle'
  | 'panning'
  | 'node-dragging'
  | 'port-connecting'
  | 'rubber-band-select'
  | 'node-resizing'
  | 'context-menu';
