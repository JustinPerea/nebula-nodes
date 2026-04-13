export type PortDataType =
  | 'Text'
  | 'Image'
  | 'Video'
  | 'Audio'
  | 'Mask'
  | 'Array'
  | 'SVG'
  | 'Any';

export type NodeCategory =
  | 'image-gen'
  | 'video-gen'
  | 'text-gen'
  | 'audio-gen'
  | 'transform'
  | 'analyzer'
  | 'utility'
  | 'universal';

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
  | 'bfl';

export interface PortDefinition {
  id: string;
  label: string;
  dataType: PortDataType;
  required: boolean;
  multiple?: boolean;
  maxConnections?: number;
}

export interface ParamDefinition {
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
  condition?: string;
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
  docUrl?: string;
}

export interface PortValue {
  type: PortDataType;
  value: string | string[] | { url: string; mimeType: string } | ArrayBuffer | null;
}

export interface NodeData {
  label: string;
  definitionId: string;
  params: Record<string, unknown>;
  state: NodeState;
  progress?: number;
  outputs: Record<string, PortValue>;
  error?: string;
  keyStatus?: 'ok' | 'missing';
  streamingText?: string;
}

export interface DynamicPortDefinition {
  id: string;
  label: string;
  dataType: PortDataType;
  required: boolean;
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
  isDynamic: true;
  providerType: 'openrouter' | 'replicate' | 'fal';
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
