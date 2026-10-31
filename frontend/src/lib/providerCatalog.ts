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
  /** Words dropped from node names in this row ("ElevenLabs TTS" reads as "TTS"). */
  brand?: string[];
  /** Nodes to name first in the row's summary. A test keeps these real. */
  highlights?: string[];
  /** Said instead of node names when the node list doesn't explain the key. */
  note?: string;
  /** What to know before getting this key (where it's sold, setup it needs).
   *  Shown under the key field and in the saved row. */
  caveat?: string;
  /** How to make the key, said first under the key field (Hugging Face: the
   *  token kind), with `keyLink` after it and the caveat last. */
  instruction?: string;
  /** The link to `url`, outside Nebula, in both the manage and the edit
   *  view: "Open <provider> keys", with the provider's own word for its
   *  credential (keys or tokens) and no domain, since the name says where it
   *  goes (GM, PR #203 r19 item 5; Idol's "Open Hugging Face tokens", r14
   *  item 5). Every provider has one. It is the one source of the row's
   *  credential noun (`credentialNoun`): its buttons, notices and
   *  screen-reader names say the link's word (GM, PR #203 r25 item 3). */
  keyLink: string;
}

/** The noun each link word gives. Google Cloud's link opens its service
 * accounts, where the person makes the account's key, and every Vertex line
 * says "service-account key", so it is a key. */
export const LINK_NOUNS: Readonly<Record<string, string>> = { keys: 'key', tokens: 'token', 'service accounts': 'key' };
const LINK_WORD = / (keys|tokens|service accounts)$/;

/** What the provider calls the credential, as its link says it: "key" for
 * "Open OpenAI keys", "token" for "Open Hugging Face tokens" and "Open
 * Replicate tokens" (GM, PR #203 r25 item 3: every provider, from one
 * source). */
export function credentialNoun(spec: Pick<ProviderKeySpec, 'keyLink'>): string {
  const word = LINK_WORD.exec(spec.keyLink)?.[1];
  return (word && LINK_NOUNS[word]) || 'key';
}

/** The row's credential by name, its noun said once: "Hugging Face token",
 * "Replicate token", "OpenAI API key", "Google · Gemini API key", "Google ·
 * Vertex AI service account key", "Krea · API key", "Krea · usage key"
 * (review 12, copy LOW-1: never "Krea · API key API key"). The one name
 * screen readers hear for the row's Add, field, Show and Remove (GM, PR #203
 * r27 item 6). */
export function credentialName(spec: Pick<ProviderKeySpec, 'keyLink' | 'label'>): string {
  // Google Cloud's service-account key isn't an API key: "Google · Vertex AI
  // service account key" (GM, PR #203 r27 item 6).
  if (LINK_WORD.exec(spec.keyLink)?.[1] === 'service accounts') return `${spec.label} service account key`;
  const noun = credentialNoun(spec);
  if (noun !== 'key') return `${spec.label} ${noun}`;
  if (/\bkey$/i.test(spec.label)) return spec.label;
  return /\bAPI$/.test(spec.label) ? `${spec.label} key` : `${spec.label} API key`;
}

export const PROVIDER_KEYS: readonly ProviderKeySpec[] = [
  { key: 'OPENAI_API_KEY', label: 'OpenAI', keyLink: 'Open OpenAI keys', placeholder: 'sk-...', url: 'https://platform.openai.com/api-keys',
    brand: ['OpenAI'], highlights: ['gpt-image-2-generate', 'gpt-image-2-5-generate', 'openai-stt', 'openai-tts'] },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', keyLink: 'Open Anthropic keys', placeholder: 'sk-ant-...', url: 'https://console.anthropic.com/settings/keys' },
  { key: 'GOOGLE_API_KEY', label: 'Google · Gemini API', keyLink: 'Open Google AI Studio keys', placeholder: 'AIza...', url: 'https://aistudio.google.com/apikey',
    brand: ['Gemini'], highlights: ['nano-banana', 'veo-3', 'lyria-3', 'gemini-chat'] },
  { key: 'GOOGLE_VERTEX_CREDENTIALS', label: 'Google · Vertex AI', keyLink: 'Open Google Cloud service accounts', placeholder: '{"type": "service_account", ...}',
    url: 'https://console.cloud.google.com/iam-admin/serviceaccounts', input: 'service-account',
    note: 'Veo 3.1 on Google Cloud billing' },
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter', keyLink: 'Open OpenRouter keys', placeholder: 'sk-or-...', url: 'https://openrouter.ai/keys',
    note: 'Hundreds of chat models through one key' },
  { key: 'REPLICATE_API_TOKEN', label: 'Replicate', keyLink: 'Open Replicate tokens', placeholder: 'r8_...', url: 'https://replicate.com/account/api-tokens',
    note: 'Any model on Replicate' },
  { key: 'FAL_KEY', label: 'fal.ai', keyLink: 'Open fal.ai keys', placeholder: 'fal_...', url: 'https://fal.ai/dashboard/keys',
    brand: ['FAL'], highlights: ['kling-v3', 'flux-2-pro', 'seedance-2-t2v', 'veo-3'] },
  { key: 'MESHY_API_KEY', label: 'Meshy', keyLink: 'Open Meshy keys', placeholder: 'msy_...', url: 'https://app.meshy.ai/settings/api', brand: ['Meshy', 'Meshy 6'] },
  { key: 'RUNWAY_API_KEY', label: 'Runway', keyLink: 'Open Runway keys', placeholder: 'key_...', url: 'https://app.runwayml.com/settings/api-keys', brand: ['Runway'],
    highlights: ['runway-video', 'runway-aleph', 'runway-act-two'] },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', keyLink: 'Open ElevenLabs keys', placeholder: 'el_...', url: 'https://elevenlabs.io/app/settings/api-keys', brand: ['ElevenLabs'] },
  { key: 'MINIMAX_API_KEY', label: 'MiniMax', keyLink: 'Open MiniMax keys', placeholder: 'eyJ...', url: 'https://www.minimaxi.com/platform', brand: ['MiniMax'],
    note: 'Hailuo 2.3 video from text, an image or a subject' },
  { key: 'XAI_API_KEY', label: 'xAI (Grok)', keyLink: 'Open xAI keys', placeholder: 'xai-...', url: 'https://console.x.ai' },
  { key: 'HIGGSFIELD_API_KEY', label: 'Higgsfield', keyLink: 'Open Higgsfield keys', placeholder: 'hf_...', url: 'https://app.higgsfield.ai/settings',
    note: 'Image-to-video: DoP, Kling 2.1, Seedance' },
  { key: 'QUIVER_API_KEY', label: 'QuiverAI (Arrow)', keyLink: 'Open QuiverAI keys', placeholder: 'qvr-...', url: 'https://app.quiver.ai/settings/api-keys', brand: ['Quiver'] },
  { key: 'KREA_API_TOKEN', label: 'Krea · API key', keyLink: 'Open Krea keys', placeholder: 'krea_...', url: 'https://www.krea.ai/api-keys',
    brand: ['Krea'], highlights: ['krea-2-generate', 'krea-image-google-nano-banana-pro', 'krea-image-openai-gpt-image-2'] },
  { key: 'KREA_USAGE_KEY', label: 'Krea · usage key', keyLink: 'Open Krea keys', placeholder: 'Service key', url: 'https://www.krea.ai/api-keys',
    note: 'Workspace spend reporting (enterprise)' },
  { key: 'IDEOGRAM_API_KEY', label: 'Ideogram', keyLink: 'Open Ideogram keys', placeholder: 'ideogram_...', url: 'https://developer.ideogram.ai', brand: ['Ideogram'] },
  { key: 'TYPESAFE_API_KEY', label: 'TypeSafe', keyLink: 'Open TypeSafe keys', placeholder: 'Your TypeSafe key', url: 'https://console.typesafe.ai/keys',
    brand: ['Jev'], note: 'Typed judge, classify and pick-best decisions (Jev)' },
  { key: 'WORLDLABS_API_KEY', label: 'World Labs', keyLink: 'Open World Labs keys', placeholder: 'wlt_...', url: 'https://platform.worldlabs.ai', brand: ['World Labs'] },
  // Black Forest Labs' own API (api.bfl.ai, x-key header). Keys come from
  // dashboard.bfl.ai under API -> Keys, scoped to a project; credits are
  // shared by the organization. docs/api-guides/bfl.md.
  { key: 'BFL_API_KEY', label: 'Black Forest Labs', keyLink: 'Open Black Forest Labs keys', placeholder: 'bfl_...', url: 'https://dashboard.bfl.ai',
    brand: ['FLUX'], note: 'FLUX on Black Forest Labs\' own API' },
  // Optional for the Idol node on Speridlabs' Hugging Face Space: it runs
  // without a token (the first live call, PR #203 round 7), and a token gives
  // its runs the person's own ZeroGPU allowance. Copy: GM, PR #203 r12 item 3
  // (the helper) and r11 item 1 (the instruction, the link and the caveat, in
  // that order). The token kind is a product decision: fine-grained, with no
  // repository access. Hugging Face's docs don't say a token with no
  // permissions counts toward ZeroGPU quota; unconfirmed until the live run
  // with a token made this way. The caveat's PRO sentence is Hugging Face's
  // own, https://huggingface.co/docs/hub/spaces-zerogpu, "Extending quota with
  // credits": "PRO, Team, and Enterprise users can continue using ZeroGPU
  // Spaces beyond their included daily quota by consuming pre-paid credits at
  // the rate of $1 per 10 minutes of GPU time."
  { key: 'HF_TOKEN', label: 'Hugging Face', placeholder: 'hf_...',
    url: 'https://huggingface.co/settings/tokens',
    brand: ['Idol'], note: 'Optional. Gives Idol your own Hugging Face allowance.',
    instruction: 'Create a fine-grained token in your Hugging Face settings and give it no repository access. '
      + 'Nebula uses it only for Idol’s GPU time on Hugging Face.',
    keyLink: 'Open Hugging Face tokens',
    // GM, PR #203 r14 item 1, verbatim.
    caveat: 'With your token, Idol runs on your Hugging Face allowance. With Hugging Face PRO, time past your '
      + 'allowance uses your prepaid Hugging Face credits.' },
  // BytePlus Service Specific Terms (Model Services): "The BytePlus Model
  // Services are not available in the United States." Models need activating
  // first (404 ModelNotOpen otherwise). docs/api-guides/byteplus.md.
  { key: 'BYTEPLUS_API_KEY', label: 'BytePlus · ModelArk', keyLink: 'Open BytePlus ModelArk keys', placeholder: 'ModelArk API key',
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
 * token). */
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
