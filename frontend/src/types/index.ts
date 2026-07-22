export type PortDataType =
  | 'Text'
  | 'Image'
  | 'Video'
  | 'Audio'
  | 'Mask'
  | 'Array'
  | 'SVG'
  | 'Mesh'
  | 'Character'
  | 'Moodboard'
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
  | 'nous'
  | 'utility';

export interface PortDefinition {
  id: string;
  label: string;
  dataType: PortDataType;
  required: boolean;
  multiple?: boolean;
  maxConnections?: number;
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
  /** Dual-param architecture for nodes with both FAL and direct API support.
   *  When present, Inspector renders sharedParams + (falParams or directParams)
   *  based on which API key is available. `params` is ignored when these are set. */
  sharedParams?: ParamDefinition[];
  falParams?: ParamDefinition[];
  directParams?: ParamDefinition[];
  /** Which env key name selects the "direct" route (vs FAL). Used by Inspector
   *  to decide which param set to show. e.g. 'MESHY_API_KEY' or 'GOOGLE_API_KEY'. */
  directKeyName?: string;
  docUrl?: string;
}

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
  consistencyStrength: number;     // 0..1 — the --ow / IP-adherence analog
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
  /** Per-use consistency strength; overrides consistencyStrength when set.
   *  null/absent = inherit consistencyStrength. */
  strengthOverride?: number | null;
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
  value: string | string[] | { url: string; mimeType: string } | Record<string, unknown> | ArrayBuffer | null;
}

export interface NodeData {
  [key: string]: unknown;
  label: string;
  definitionId: string;
  params: Record<string, unknown>;
  state: NodeState;
  progress?: number;
  outputs: Record<string, PortValue>;
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
