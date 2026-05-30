export type PortDataType =
  | 'Text'
  | 'Image'
  | 'Video'
  | 'Audio'
  | 'Mask'
  | 'Array'
  | 'SVG'
  | 'Mesh'
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
  | 'cinematic';

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
   *  e.g. { model: ['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview'] } */
  visibleWhen?: Record<string, (string | number | boolean)[]>;
}

export interface ModelNodeDefinition {
  id: string;
  displayName: string;
  category: NodeCategory;
  apiProvider: APIProvider;
  apiEndpoint: string;
  envKeyName: string | string[];
  executionPattern: ExecutionPattern;
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
    grain: number; halation: number; vignette: number;
    contrast: number; saturation: number; temperature: number;
    /** Optional .cube LUT id. */
    lutId?: string;
  };
  /** '16:9' | '2.39:1' | '4:5' | '1:1' | '9:16'. */
  aspectRatio: string;
  shots: CinemaShot[];
}

export interface PortValue {
  type: PortDataType;
  value: string | string[] | { url: string; mimeType: string } | ArrayBuffer | null;
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
