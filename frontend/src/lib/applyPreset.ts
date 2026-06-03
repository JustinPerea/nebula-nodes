import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { buildDefaultParamsForUi } from './createParams';
import type { Preset } from './createPresets';

export interface ComposerState {
  modelId: string | null;
  prompt: string;
  params: Record<string, unknown>;
}

/** Merge a preset into the current composer state. Pure. */
export function applyPresetToComposer(preset: Preset, current: ComposerState): ComposerState {
  // Prompt: append the fragment to whatever the user already typed.
  const fragment = preset.prompt.trim();
  const base = current.prompt.trim();
  const prompt = fragment && base ? `${base}, ${fragment}` : fragment || base;

  // Model: if the preset hints a model (and it exists), switch to it and rebuild
  // its defaults so stale params from the old model don't leak through.
  let modelId = current.modelId;
  let baseParams = current.params;
  if (preset.modelId && NODE_DEFINITIONS[preset.modelId]) {
    modelId = preset.modelId;
    baseParams = buildDefaultParamsForUi(NODE_DEFINITIONS[preset.modelId]);
  }

  return { modelId, prompt, params: { ...baseParams, ...preset.params } };
}
