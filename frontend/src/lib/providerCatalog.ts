import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { matchesModelSearch } from './modelDiscovery';

/** One credential Settings can hold. Order here is only the tiebreak; rows sort by reach. */
export interface ProviderKeySpec {
  key: string;
  label: string;
  /** Where the provider hands out keys. */
  url: string;
  placeholder: string;
  /** A Google service-account key arrives as a JSON file, not a pasted token. */
  input?: 'secret' | 'service-account';
  /** What the provider calls the credential in screen-reader labels ("token"
   *  for Hugging Face); "API key" when unset. The visible "Add key" buttons
   *  stay as they are (GM, PR #203 r1). */
  credential?: string;
  /** Words dropped from node names in this row ("ElevenLabs TTS" reads as "TTS"). */
  brand?: string[];
  /** Nodes to name first in the row's summary. A test keeps these real. */
  highlights?: string[];
  /** Said instead of node names when the node list doesn't explain the key. */
  note?: string;
  /** What to know before getting this key (where it's sold, setup it needs).
   *  Shown under the key field and in the saved row. */
  caveat?: string;
}

export const PROVIDER_KEYS: readonly ProviderKeySpec[] = [
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-...', url: 'https://platform.openai.com/api-keys',
    brand: ['OpenAI'], highlights: ['gpt-image-2-generate', 'gpt-image-2-5-generate', 'openai-stt', 'openai-tts'] },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', placeholder: 'sk-ant-...', url: 'https://console.anthropic.com/settings/keys' },
  { key: 'GOOGLE_API_KEY', label: 'Google · Gemini API', placeholder: 'AIza...', url: 'https://aistudio.google.com/apikey',
    brand: ['Gemini'], highlights: ['nano-banana', 'veo-3', 'lyria-3', 'gemini-chat'] },
  { key: 'GOOGLE_VERTEX_CREDENTIALS', label: 'Google · Vertex AI', placeholder: '{"type": "service_account", ...}',
    url: 'https://console.cloud.google.com/iam-admin/serviceaccounts', input: 'service-account',
    note: 'Veo 3.1 on Google Cloud billing' },
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter', placeholder: 'sk-or-...', url: 'https://openrouter.ai/keys',
    note: 'Hundreds of chat models through one key' },
  { key: 'REPLICATE_API_TOKEN', label: 'Replicate', placeholder: 'r8_...', url: 'https://replicate.com/account/api-tokens',
    note: 'Any model on Replicate' },
  { key: 'FAL_KEY', label: 'fal.ai', placeholder: 'fal_...', url: 'https://fal.ai/dashboard/keys',
    brand: ['FAL'], highlights: ['kling-v3', 'flux-2-pro', 'seedance-2-t2v', 'veo-3'] },
  { key: 'MESHY_API_KEY', label: 'Meshy', placeholder: 'msy_...', url: 'https://app.meshy.ai/settings/api', brand: ['Meshy', 'Meshy 6'] },
  { key: 'RUNWAY_API_KEY', label: 'Runway', placeholder: 'key_...', url: 'https://app.runwayml.com/settings/api-keys', brand: ['Runway'],
    highlights: ['runway-video', 'runway-aleph', 'runway-act-two'] },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', placeholder: 'el_...', url: 'https://elevenlabs.io/app/settings/api-keys', brand: ['ElevenLabs'] },
  { key: 'MINIMAX_API_KEY', label: 'MiniMax', placeholder: 'eyJ...', url: 'https://www.minimaxi.com/platform', brand: ['MiniMax'],
    note: 'Hailuo 2.3 video from text, an image or a subject' },
  { key: 'XAI_API_KEY', label: 'xAI (Grok)', placeholder: 'xai-...', url: 'https://console.x.ai' },
  { key: 'HIGGSFIELD_API_KEY', label: 'Higgsfield', placeholder: 'hf_...', url: 'https://app.higgsfield.ai/settings',
    note: 'Image-to-video: DoP, Kling 2.1, Seedance' },
  { key: 'QUIVER_API_KEY', label: 'QuiverAI (Arrow)', placeholder: 'qvr-...', url: 'https://app.quiver.ai/settings/api-keys', brand: ['Quiver'] },
  { key: 'KREA_API_TOKEN', label: 'Krea · API token', placeholder: 'krea_...', url: 'https://www.krea.ai/api-keys',
    brand: ['Krea'], highlights: ['krea-2-generate', 'krea-image-google-nano-banana-pro', 'krea-image-openai-gpt-image-2'] },
  { key: 'KREA_USAGE_KEY', label: 'Krea · usage key', placeholder: 'Service key', url: 'https://www.krea.ai/api-keys',
    note: 'Workspace spend reporting (enterprise)' },
  { key: 'IDEOGRAM_API_KEY', label: 'Ideogram', placeholder: 'ideogram_...', url: 'https://developer.ideogram.ai', brand: ['Ideogram'] },
  { key: 'TYPESAFE_API_KEY', label: 'TypeSafe', placeholder: 'Your TypeSafe key', url: 'https://console.typesafe.ai/keys',
    brand: ['Jev'], note: 'Typed judge, classify and pick-best decisions (Jev)' },
  { key: 'WORLDLABS_API_KEY', label: 'World Labs', placeholder: 'wlt_...', url: 'https://platform.worldlabs.ai', brand: ['World Labs'] },
  // Black Forest Labs' own API (api.bfl.ai, x-key header). Keys come from
  // dashboard.bfl.ai under API -> Keys, scoped to a project; credits are
  // shared by the organization. docs/api-guides/bfl.md.
  { key: 'BFL_API_KEY', label: 'Black Forest Labs', placeholder: 'bfl_...', url: 'https://dashboard.bfl.ai',
    brand: ['FLUX'], note: 'FLUX on Black Forest Labs\' own API' },
  // Needed to run the Idol node on Speridlabs' Hugging Face Space (GM, PR #203
  // r4): each run asks ZeroGPU for 120 s (Space app.py duration=120), which
  // spaces 0.51.3 multiplies by 1.5 on the Blackwell GPUs ZeroGPU runs on, so
  // 180 s, past the 120 s a day a caller without a token gets (to confirm on
  // the first live run). A token gives runs the person's own quota (free 5
  // minutes, PRO 40 minutes a day). The caveat's PRO sentence is Hugging
  // Face's own, https://huggingface.co/docs/hub/spaces-zerogpu, "Extending
  // quota with credits": "PRO, Team, and Enterprise users can continue using
  // ZeroGPU Spaces beyond their included daily quota by consuming pre-paid
  // credits at the rate of $1 per 10 minutes of GPU time."
  { key: 'HF_TOKEN', label: 'Hugging Face', credential: 'token', placeholder: 'hf_...',
    url: 'https://huggingface.co/settings/tokens',
    brand: ['Idol'], note: 'Needed to run Idol.',
    // TODO(Justin): which token scope to ask for.
    caveat: 'Idol runs on your Hugging Face allowance. With Hugging Face PRO, time past your allowance uses '
      + 'your prepaid Hugging Face credits.' },
  // BytePlus Service Specific Terms (Model Services): "The BytePlus Model
  // Services are not available in the United States." Models need activating
  // first (404 ModelNotOpen otherwise). docs/api-guides/byteplus.md.
  { key: 'BYTEPLUS_API_KEY', label: 'BytePlus · ModelArk', placeholder: 'ModelArk API key',
    url: 'https://ai.byteplus.com/ark/region:ap-southeast-1/apiKey', brand: ['Seedream', 'Seedance'],
    note: 'Seedream and Seedance on ByteDance\'s own API',
    caveat: 'BytePlus doesn\'t offer its model services in the United States (BytePlus Service Specific Terms). '
      + 'Use an Asia Pacific (ap-southeast-1) ModelArk key, and activate each model on the ModelArk console\'s '
      + 'Model activation page first; Seedance 2.x also needs USD 30 of BytePlus credits before activation.' },
];

export const PROVIDER_KEY_SPECS: Readonly<Record<string, ProviderKeySpec>> = Object.fromEntries(
  PROVIDER_KEYS.map((spec) => [spec.key, spec]),
);

const NODES = Object.values(NODE_DEFINITIONS);

/** Nodes that can run with this key (alone or as one of their routes), or
 * use it when set (a keyless route's optionalKeys, such as Idol's Hugging Face
 * token if it goes back to keyless). */
export function nodesForKey(key: string) {
  return NODES.filter((node) => {
    const keys = Array.isArray(node.envKeyName) ? node.envKeyName : [node.envKeyName];
    return keys.includes(key) || (node.routes ?? []).some((route) => route.optionalKeys?.includes(key));
  });
}

function shortName(name: string, brand: readonly string[] = []): string {
  let out = name.replace(/\s*\((?:Krea|FAL|fal)\)\s*$/, '').replace(/\s*\(sunsets[^)]*\)/i, '');
  for (const word of [...brand].sort((a, b) => b.length - a.length)) {
    // "Krea 2" and "Ideogram 4" keep the brand: a bare version number names nothing.
    if (out.startsWith(`${word} `) && !/^\d/.test(out.slice(word.length + 1))) { out = out.slice(word.length + 1); break; }
  }
  return out.trim();
}

/** Node names for a row, highlights first, provider name trimmed, no repeats. */
export function unlockNames(spec: ProviderKeySpec): string[] {
  const nodes = nodesForKey(spec.key);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered = [
    ...(spec.highlights ?? []).map((id) => byId.get(id)).filter((node) => node !== undefined),
    ...nodes.filter((node) => !spec.highlights?.includes(node.id)),
  ];
  return [...new Set(ordered.map((node) => shortName(node.displayName, spec.brand)))];
}

/**
 * The row's one-line summary of what the key opens up.
 * Connected rows lead with names ("GPT Image 2, Whisper +8"); rows still to
 * add lead with the count, since reach is what you're choosing on.
 */
export function unlockSummary(spec: ProviderKeySpec, style: 'connected' | 'add'): string {
  const names = unlockNames(spec);
  if (spec.note && names.length <= 3) return spec.note;
  if (names.length === 0) return spec.note ?? '';
  if (names.length <= 3) return names.join(', ');
  if (style === 'connected') return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
  return `${names.length} nodes: ${names.slice(0, 3).join(', ')}…`;
}

/** How many nodes the key opens up; the add list sorts by it. */
export function unlockCount(spec: ProviderKeySpec): number {
  return nodesForKey(spec.key).length;
}

/** Search a provider by its name, its key's name, or any node it runs ("Veo" finds Google, Vertex and fal). */
export function providerMatches(spec: ProviderKeySpec, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (spec.label.toLowerCase().includes(q) || spec.key.toLowerCase().includes(q)) return true;
  if (spec.note?.toLowerCase().includes(q)) return true;
  return nodesForKey(spec.key).some((node) => matchesModelSearch(node, q));
}
