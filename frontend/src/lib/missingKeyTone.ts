/**
 * Whether a node's run error draws neutral as a missing-key stop (something to
 * do, not a failure). The backend flags those errors (`errorMissingKey`); four
 * handlers still raise a plain error for their own missing-key stop, so for
 * just those node kinds the card's own key state (`keyStatus === 'missing'`)
 * stands in. Every other node kind reads only `errorMissingKey`.
 */

/**
 * The node kinds whose handlers raise a plain error for a missing key: World
 * Labs (environment), Style reference, the Idol node and Veo (veo-3).
 * The follow-up pull request removes this constant, and its use below, once
 * those handlers raise MissingCredentialError.
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
