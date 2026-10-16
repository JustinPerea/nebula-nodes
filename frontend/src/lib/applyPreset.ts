import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { isBillingParam } from './billingParams';
import { buildDefaultParamsForUi } from './createParams';
import type { Preset } from './createPresets';
import { kreaModeFor, supportsKreaAccount, type KreaConnectionMode } from './kreaConnection';

export interface ComposerState {
  modelId: string | null;
  prompt: string;
  params: Record<string, unknown>;
}

/** Merge a preset into the current composer state. Pure. */
export function applyPresetToComposer(
  preset: Preset,
  current: ComposerState,
  apiKeys: Record<string, string> = {},
  kreaConnectionMode: KreaConnectionMode = 'api-token',
): ComposerState {
  // Prompt: append the fragment to whatever the user already typed.
  const fragment = preset.prompt.trim();
  const base = current.prompt.trim();
  const prompt = fragment && base ? `${base}, ${fragment}` : fragment || base;

  // Model: if the preset hints a model (and it exists), switch to it and rebuild
  // its defaults so stale params from the old model don't leak through.
  if (preset.modelId && NODE_DEFINITIONS[preset.modelId]) {
    const baseParams = buildDefaultParamsForUi(NODE_DEFINITIONS[preset.modelId], apiKeys, kreaConnectionMode);
    // A saved Krea preset is an existing recipe. Missing old modes retain API billing.
    if (supportsKreaAccount(NODE_DEFINITIONS[preset.modelId])) {
      baseParams._kreaAuth = kreaModeFor(NODE_DEFINITIONS[preset.modelId], preset.params);
    }
    return { modelId: preset.modelId, prompt, params: { ...baseParams, ...preset.params } };
  }
  // A model this catalog doesn't have: its params belong to that model, so
  // none land on the current one (its billing keys least of all). The backend
  // reads a preset on a retired or folded node as the node it became
  // (services/preset_store.py), so this is a model it couldn't map.
  if (preset.modelId) return { modelId: current.modelId, prompt, params: current.params };
  // A style-only preset styles the current model; who bills it stays the
  // person's choice there.
  const styled = Object.fromEntries(Object.entries(preset.params ?? {}).filter(([key]) => !isBillingParam(key)));
  return { modelId: current.modelId, prompt, params: { ...current.params, ...styled } };
}
