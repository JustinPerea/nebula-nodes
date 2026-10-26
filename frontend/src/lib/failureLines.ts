import { keyPhrase } from './directRoute';

/**
 * Failure lines for steps whose request failed (review 12, L-4; GM - Design,
 * round 13, verbatim). A Cmd+Z held for such a step goes to nothing, so the
 * failure itself has to say what happened: these three used to say nothing.
 */

/** Chat /clear refused before the backend removed anything (a 4xx answer:
 * every refusal of DELETE /api/graph comes before its clear). */
export const CLEAR_REFUSED_TEXT = "Couldn't clear the canvas. Nothing was removed.";

/** Chat /clear failed any other way (a 5xx, no answer). The backend clears
 * its graph before saving it, so such a failure can come after the clear:
 * "Nothing was removed" would not be sure to be true (GM: "Use the second
 * sentence only if it is true"). */
export const CLEAR_FAILED_TEXT = "Couldn't clear the canvas.";

/** What chat /clear's request did to the canvas (lib/chatCanvasClear.ts). */
export type ChatClearOutcome = 'cleared' | 'refused' | 'failed';

/** The chat's system line after /clear (GM - Design, round 14, item 2,
 * verbatim; review 13, L-7). It stays after the notice is gone, so it says
 * what happened to the canvas. The session itself always clears: its id is
 * reset here, so the next message starts a fresh conversation. */
export function chatClearLine(outcome: ChatClearOutcome): string {
  if (outcome === 'refused') return "Session cleared. Next message starts a fresh conversation. The canvas wasn't cleared.";
  if (outcome === 'failed') return 'Session cleared. Next message starts a fresh conversation. The canvas may not be fully cleared.';
  return 'Session cleared. Next message starts a fresh conversation with an empty canvas.';
}

/** The model pickers (OpenRouter, Nous Portal, Replicate): reading the
 * provider's settings for the model failed (the backend marks that answer
 * with MODEL_SETTINGS_FAILURE_HEADER). The node keeps its settings. */
export function modelSettingsFailedText(name: string): string {
  return `Couldn't load the model settings for “${name}”.`;
}

/** The model pickers, any other failure (a refusal, no answer). The node
 * keeps its settings. */
export function modelSetupFailedText(name: string): string {
  return `Couldn't set up “${name}”.`;
}

/** GM - Design, round 15, item 1, verbatim: the pickers' line calls
 * Replicate's an "API key" ("Add your Replicate API key in Settings."). */
const PICKER_KEY_PHRASES: Readonly<Record<string, string>> = { REPLICATE_API_TOKEN: 'Replicate API key' };

/** The model pickers, the provider's key isn't set (review 13, L-5; GM -
 * Design, round 15, item 1): GM's "Couldn't set up “X”." and the key to
 * add, by its provider's name (no env names: directRoute.keyPhrase). The
 * node keeps its settings. */
export function modelKeyMissingText(name: string, keys: readonly string[]): string {
  const phrase = keys.length === 1 && Object.hasOwn(PICKER_KEY_PHRASES, keys[0]) ? PICKER_KEY_PHRASES[keys[0]] : keyPhrase(keys);
  return phrase ? `${modelSetupFailedText(name)} Add your ${phrase} in Settings.` : modelSetupFailedText(name);
}

/** backend main.MODEL_SETTINGS_FAILURE_HEADER and its values: reading the
 * provider's settings failed, or the provider's key isn't set (review 13,
 * L-5). A malformed model id carries none. */
export const MODEL_SETTINGS_FAILURE_HEADER = 'X-Nebula-Failure';
export const MODEL_SETTINGS_FAILURE = 'model-settings';
export const MISSING_KEY_FAILURE = 'missing-key';
