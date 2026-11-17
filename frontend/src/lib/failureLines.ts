import { keyPhrase, withArticle } from './directRoute';

/**
 * Failure lines for steps whose request failed (review 12, L-4; GM - Design,
 * round 13, verbatim). A Cmd+Z held for such a step goes to nothing, so the
 * failure itself has to say what happened: these three used to say nothing.
 */

/** Chat /clear refused before the backend removed anything (a 4xx answer:
 * every refusal of DELETE /api/graph comes before its clear). */
export const CLEAR_REFUSED_TEXT = 'Nebula couldn’t clear the canvas because the server didn’t accept it. Nothing was removed.';

/** Chat /clear failed any other way (a 5xx, no answer). The backend clears
 * its graph before saving it, so such a failure can come after the clear:
 * "Nothing was removed" would not be sure to be true (GM: "Use the second
 * sentence only if it is true"). */
export const CLEAR_FAILED_TEXT = 'Nebula couldn’t clear the canvas.';

/** What chat /clear's request did to the canvas (lib/chatCanvasClear.ts):
 * cleared, refused (nothing was removed), or not confirmed (a server error
 * or no answer: it may have cleared). Its line is lib/chatClear.ts's (GM,
 * round 12 of PR #114; the round 21 merge took it over #195's round 14 line,
 * since a clear is all or nothing). */
export type ChatClearOutcome = 'cleared' | 'refused' | 'unconfirmed';

/** The model pickers (OpenRouter, Nous Portal, Replicate): reading the
 * provider's settings for the model failed (the backend marks that answer
 * with MODEL_SETTINGS_FAILURE_HEADER). The node keeps its settings. */
export function modelSettingsFailedText(name: string): string {
  return `Nebula couldn’t load the model settings for “${name}”.`;
}

/** The model pickers, any other failure (a refusal, no answer). The node
 * keeps its settings. */
export function modelSetupFailedText(name: string): string {
  return `Nebula couldn’t set up “${name}”.`;
}

/** The model pickers, the provider's key isn't set (review 13, L-5; GM -
 * Design, round 15, item 1; copy sweep item 12): what failed, because the
 * key is missing, and the fix. "Nebula couldn’t set up “X” because it needs
 * an OpenAI API key. Add one in Settings." The key is named by its
 * provider (no env names: directRoute.keyPhrase), in the provider's own
 * noun ("a Replicate token"), "an API key" when the name isn't one
 * Settings stores. The node keeps its settings. */
export function modelKeyMissingText(name: string, keys: readonly string[]): string {
  const phrase = keyPhrase(keys);
  return `Nebula couldn’t set up “${name}” because it needs ${phrase ? withArticle(phrase) : 'an API key'}. Add one in Settings.`;
}

/** backend main.MODEL_SETTINGS_FAILURE_HEADER and its values: reading the
 * provider's settings failed, or the provider's key isn't set (review 13,
 * L-5). A malformed model id carries none. */
export const MODEL_SETTINGS_FAILURE_HEADER = 'X-Nebula-Failure';
export const MODEL_SETTINGS_FAILURE = 'model-settings';
export const MISSING_KEY_FAILURE = 'missing-key';
