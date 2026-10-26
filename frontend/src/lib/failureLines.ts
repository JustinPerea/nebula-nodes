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

/** backend main.MODEL_SETTINGS_FAILURE_HEADER and its one value. */
export const MODEL_SETTINGS_FAILURE_HEADER = 'X-Nebula-Failure';
export const MODEL_SETTINGS_FAILURE = 'model-settings';
