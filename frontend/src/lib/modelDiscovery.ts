import type { APIProvider, ModelNodeDefinition, NodeCategory, PortDefinition } from '../types';

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  'image-gen': 'Image Generation',
  'video-gen': 'Video Generation',
  'text-gen': 'Text Generation',
  'audio-gen': 'Audio Generation',
  '3d-gen': '3D Generation',
  transform: 'Transform',
  analyzer: 'Analyzer',
  utility: 'Utility',
  universal: 'Universal',
  cinematic: 'Cinematic',
  character: 'Character',
  moodboard: 'Moodboard',
};

const PROVIDER_LABELS: Record<APIProvider, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', runway: 'Runway',
  kling: 'Kling', elevenlabs: 'ElevenLabs', replicate: 'Replicate', fal: 'fal.ai',
  bytedance: 'ByteDance', minimax: 'MiniMax', luma: 'Luma', xai: 'xAI',
  recraft: 'Recraft', ideogram: 'Ideogram', openrouter: 'OpenRouter', bfl: 'Black Forest Labs',
  higgsfield: 'Higgsfield', meshy: 'Meshy', quiver: 'QuiverAI', krea: 'Krea',
  worldlabs: 'World Labs', nous: 'Nous', utility: 'Local tools',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as APIProvider] ?? provider;
}

const CREDENTIAL_PROVIDER_IDS: Readonly<Record<string, APIProvider>> = {
  OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic', GOOGLE_API_KEY: 'google',
  OPENROUTER_API_KEY: 'openrouter', REPLICATE_API_TOKEN: 'replicate', FAL_KEY: 'fal',
  MESHY_API_KEY: 'meshy', RUNWAY_API_KEY: 'runway', ELEVENLABS_API_KEY: 'elevenlabs',
  MINIMAX_API_KEY: 'minimax', XAI_API_KEY: 'xai', HIGGSFIELD_API_KEY: 'higgsfield',
  QUIVER_API_KEY: 'quiver', KREA_API_TOKEN: 'krea', IDEOGRAM_API_KEY: 'ideogram',
  WORLDLABS_API_KEY: 'worldlabs',
};

/** Discovery includes every declared provider route, regardless of which
 * credential is currently configured. Readiness describes the selected route. */
export function supportedModelProviders(definition: ModelNodeDefinition): APIProvider[] {
  const providers = new Set<APIProvider>([definition.apiProvider]);
  const keys = Array.isArray(definition.envKeyName) ? definition.envKeyName : [definition.envKeyName];
  for (const key of [...keys, definition.directKeyName ?? '']) {
    const provider = Object.hasOwn(CREDENTIAL_PROVIDER_IDS, key) ? CREDENTIAL_PROVIDER_IDS[key] : undefined;
    if (provider) providers.add(provider);
  }
  return [...providers];
}

export function matchesModelProvider(definition: ModelNodeDefinition, provider: string): boolean {
  return !provider || supportedModelProviders(definition).includes(provider as APIProvider);
}

// These translate common task words to declared media types. They do not
// assert model-specific quality or capabilities beyond the catalog's ports.
const SEARCH_ALIASES: Record<string, string> = {
  animated: 'animate', animation: 'animate', animations: 'animate', motion: 'animate',
  movie: 'video', movies: 'video',
  photo: 'image', photos: 'image', picture: 'image', pictures: 'image', logo: 'image', logos: 'image',
  sound: 'audio', sounds: 'audio',
  generate: 'generation', gen: 'generation',
};
const TASK_FILLERS = new Set(['a', 'an', 'the', 'to', 'for', 'from', 'with', 'my', 'me', 'please', 'make', 'create']);

function normalizedTokens(value: string): string[] {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .split(/\s+/).filter(Boolean).map((token) => SEARCH_ALIASES[token] ?? token);
}

/** Every meaningful token must match, in any order. Task filler words are
 * ignored; modelSearchText supplies direction-aware task vocabulary. */
export function matchesSearch(text: string, query: string): boolean {
  const rawTokens = normalizedTokens(query);
  const usefulTokens = rawTokens.filter((token) => !TASK_FILLERS.has(token));
  // A query containing only a filler still behaves like an ordinary search.
  const tokens = usefulTokens.length > 0 ? usefulTokens : rawTokens;
  const searchable = normalizedTokens(text).join(' ');
  return tokens.every((token) => searchable.includes(token));
}

export function modelDescription(definition: ModelNodeDefinition): string {
  return definition.capabilityNote ?? '';
}

/** The same source-backed vocabulary serves every discovery surface. Model
 * enum options matter for catalog nodes that wrap more than one model. */
export function modelSearchText(definition: ModelNodeDefinition): string {
  const routeKeys = Array.isArray(definition.envKeyName) ? definition.envKeyName : [definition.envKeyName];
  const modelOptions = [...definition.params, ...(definition.sharedParams ?? []),
    ...(definition.falParams ?? []), ...(definition.directParams ?? [])]
    .filter((param) => param.key === 'model')
    .flatMap((param) => (param.options ?? []).flatMap((option) => [option.label, String(option.value)]));
  return [definition.id, definition.displayName, definition.category, CATEGORY_LABELS[definition.category],
    ...supportedModelProviders(definition).flatMap((provider) => [provider, providerLabel(provider)]),
    modelDescription(definition),
    ...definition.inputPorts.flatMap((port) => [port.label, port.dataType]),
    ...definition.outputPorts.flatMap((port) => [port.label, port.dataType]),
    ...routeKeys, definition.directKeyName ?? '',
    ...(definition.outputPorts.some((port) => port.dataType === 'Video') ? ['animate animation motion'] : []),
    ...modelOptions].join(' ');
}

export function matchesModelSearch(definition: ModelNodeDefinition, query: string): boolean {
  return matchesSearch(modelSearchText(definition), query);
}

function concisePorts(ports: PortDefinition[], showOptional: boolean): string {
  const labels = ports.slice(0, 3).map((port) => `${port.label}${showOptional && !port.required ? ' (optional)' : ''}`);
  if (ports.length > 3) labels.push(`${ports.length - 3} more`);
  return labels.join(' + ');
}

export function modelInputSummary(definition: ModelNodeDefinition): string {
  const inputs = concisePorts(definition.inputPorts, true) || 'No connected inputs';
  const outputs = concisePorts(definition.outputPorts, false) || 'No outputs';
  return `${inputs} → ${outputs}`;
}
