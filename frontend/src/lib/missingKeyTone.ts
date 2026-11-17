/**
 * Whether a node's run error draws neutral as a missing-key stop (something to
 * do, not a failure). The backend flags those errors (`errorMissingKey`). For
 * four node kinds the card's own key state (`keyStatus === 'missing'`) also
 * stands in, so nothing they showed neutral before the copy sweep turns into a
 * failure: their handlers word their own key stops, and one of them (Idol's
 * quota stop, which asks for a Hugging Face token) is a plain error with no
 * kind. Every other node kind reads only `errorMissingKey`.
 */

/**
 * World Labs (environment), Style reference, the Idol node and Veo (veo-3).
 * The follow-up pull request rewords those handlers' lines, gives each stop
 * its kind, and removes this constant and its use below.
 */
export const PLAIN_MISSING_KEY_STOP_NODES: readonly string[] = [
  'worldlabs-environment', 'style-reference', 'speridlabs-idol', 'veo-3',
];

export function drawsAsMissingKey(
  data: { definitionId?: string; keyStatus?: 'ok' | 'missing'; errorMissingKey?: boolean },
): boolean {
  if (data.errorMissingKey === true) return true;
  return data.keyStatus === 'missing' && data.definitionId !== undefined
    && PLAIN_MISSING_KEY_STOP_NODES.includes(data.definitionId);
}
