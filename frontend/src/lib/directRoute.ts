import type { ModelNodeDefinition } from '../types';

/** The keys that select a dual-route node's direct (non-FAL) route, in the
 * order the backend tries them. Veo 3.1 has two: Vertex, then the Gemini API. */
export function directKeyNames(definition: Pick<ModelNodeDefinition, 'directKeyName'>): string[] {
  const direct = definition.directKeyName;
  return (Array.isArray(direct) ? direct : [direct]).filter((key): key is string => Boolean(key));
}

/** The first direct key that is configured, if any. */
export function configuredDirectKey(
  definition: Pick<ModelNodeDefinition, 'directKeyName'>,
  apiKeys: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return directKeyNames(definition).find((key) => Boolean(apiKeys[key]?.trim()));
}
