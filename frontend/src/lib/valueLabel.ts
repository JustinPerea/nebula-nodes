import type { NodeState } from '../types';

// A stored value shown where a person reads a label ("idle", "glb", "3d_renders")
// becomes words: underscores to spaces, the first letter a capital, initialisms
// in capitals. The Krea catalog script (scripts/sync-krea-catalog.py) applies the
// same rule to the option labels it writes; keep the two tables alike.
// The plain-word initialisms of copy-lint-rules.json ("pro", "us", "os") are left out.
export const VALUE_INITIALISMS: Readonly<Record<string, string>> = {
  api: 'API', cli: 'CLI', mcp: 'MCP', url: 'URL', urls: 'URLs', id: 'ID', ids: 'IDs', ui: 'UI', ux: 'UX',
  hd: 'HD', hdr: 'HDR', hdr10: 'HDR10', hlg: 'HLG', gpu: 'GPU', cpu: 'CPU', json: 'JSON', png: 'PNG', jpg: 'JPG',
  jpeg: 'JPEG', webp: 'WebP', gif: 'GIF', mp3: 'MP3', mp4: 'MP4', wav: 'WAV', pdf: 'PDF', svg: 'SVG', css: 'CSS',
  html: 'HTML', http: 'HTTP', https: 'HTTPS', llm: 'LLM', ai: 'AI', '3d': '3D', '2d': '2D', rgb: 'RGB', rgba: 'RGBA',
  csv: 'CSV', srt: 'SRT', lut: 'LUT', vfx: 'VFX', fps: 'FPS', tts: 'TTS', stt: 'STT', asr: 'ASR', '4k': '4K', '8k': '8K',
  glb: 'GLB', fbx: 'FBX', obj: 'OBJ', usdz: 'USDZ', ply: 'PLY',
};
const LEVEL_WORDS: Readonly<Record<string, string>> = { xhigh: 'extra high', std: 'standard' };

export function valueLabel(value: string): string {
  const words = value.split(/[_\s]+/).filter(Boolean).map((word) => {
    const key = word.toLowerCase();
    return VALUE_INITIALISMS[key] ?? LEVEL_WORDS[key] ?? word;
  });
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The word the Inspector's State row shows for a node's stored state: the words the
// card (NodeRunStatus: Queued, Running) and run history (Complete, Failed) already use.
export const NODE_STATES: readonly NodeState[] = ['idle', 'queued', 'executing', 'complete', 'error', 'skipped'];
const STATE_WORDS: Readonly<Record<NodeState, string>> = {
  idle: 'Idle', queued: 'Queued', executing: 'Running', complete: 'Complete', error: 'Failed', skipped: 'Skipped',
};
export const nodeStateWord = (state: NodeState): string => STATE_WORDS[state] ?? valueLabel(state);
