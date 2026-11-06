import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PR #199 round 25: the project store is two files, the state and autosave
 * core (store/projectStore.ts) and the flows chunk (store/projectFlows.ts).
 * A test that reads "the store's source" for a line or a registration reads
 * both, so where a flow lives is not part of what it pins.
 */
export function projectStoreSource(): string {
  const read = (file: string) => readFileSync(resolve(__dirname, '../../src/store', file), 'utf8');
  return `${read('projectStore.ts')}\n${read('projectFlows.ts')}`;
}
