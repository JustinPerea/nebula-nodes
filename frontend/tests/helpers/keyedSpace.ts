import { afterEach, beforeEach } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import type { ModelNodeDefinition } from '../../src/types';

/**
 * A keyed Space route with its own missing-key line: Idol's shape in PR #203
 * rounds 4 to 6, before the first live call showed it runs without a token
 * (round 7). No shipped node has a missingKeyLine today, but the machinery
 * that reads one stays for keyed nodes (lib/runKeyLock, withKeyLock, the
 * history and proposal locks, the backend's route_unavailable_line), so its
 * tests run on this shape: Idol's definition made keyed for the test.
 */
export const KEYED_LINE = 'You can run Idol after you add your Hugging Face token in Settings.';

export function keyedIdol(): ModelNodeDefinition {
  const real = NODE_DEFINITIONS['speridlabs-idol'] as ModelNodeDefinition;
  const copy = JSON.parse(JSON.stringify(real)) as ModelNodeDefinition;
  const route = copy.routes![0];
  route.keys = ['HF_TOKEN'];
  delete route.optionalKeys;
  delete route.mayBillWithKey;
  route.missingKeyLine = KEYED_LINE;
  copy.envKeyName = ['HF_TOKEN'];
  copy.directKeyName = ['HF_TOKEN'];
  return copy;
}

/** Idol's definition is the keyed shape for every test in the calling file
 * (or describe block), and back to the shipped one after each. */
export function keyIdolInEachTest(): void {
  let saved: unknown;
  beforeEach(() => {
    saved = NODE_DEFINITIONS['speridlabs-idol'];
    (NODE_DEFINITIONS as Record<string, unknown>)['speridlabs-idol'] = keyedIdol();
  });
  afterEach(() => {
    (NODE_DEFINITIONS as Record<string, unknown>)['speridlabs-idol'] = saved;
  });
}
