import type { APIProvider, ModelNodeDefinition, NodeCategory, PortDefinition } from '../types';
import { directKeyNames, KEY_PROVIDERS, selectRoute } from './directRoute';

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

const CREDENTIAL_PROVIDER_IDS = KEY_PROVIDERS;

/** Discovery includes every declared provider route, regardless of which
 * credential is currently configured. Readiness describes the selected route. */
export function supportedModelProviders(definition: ModelNodeDefinition): APIProvider[] {
  const providers = new Set<APIProvider>([definition.apiProvider]);
  const keys = Array.isArray(definition.envKeyName) ? definition.envKeyName : [definition.envKeyName];
  for (const key of [...keys, ...directKeyNames(definition)]) {
    const provider = Object.hasOwn(CREDENTIAL_PROVIDER_IDS, key) ? CREDENTIAL_PROVIDER_IDS[key] : undefined;
    if (provider) providers.add(provider);
  }
  return [...providers];
}

/** The provider a run actually goes through and bills, for "OpenAI · 6s" on
 * a running node and for the run estimate: lib/directRoute.ts selectRoute,
 * the backend's rule (the Krea plan when chosen, else the maker key, else the
 * fal or Krea copy). Local tools have no provider. */
export function runRouteProvider(
  definition: ModelNodeDefinition,
  apiKeys: Readonly<Record<string, string>>,
  params?: Record<string, unknown>,
): APIProvider | null {
  return selectRoute(definition, params, apiKeys).provider as APIProvider | null;
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
    ...routeKeys, ...directKeyNames(definition),
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
