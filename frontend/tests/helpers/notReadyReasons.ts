import table from '../../../backend/tests/fixtures/not_ready_reasons.json';
import type { NotReadyReason } from '../../src/lib/wsClient';

/** Every not-ready reason the registry gives (scripts/generate-not-ready-reasons.py). */
export const NOT_READY_REASONS: ReadonlyArray<{ node: string; name: string; one: string; many: string; line: string }>
  = table.reasons;

/** The reason the backend sends beside a person line (cost.notReady[].reason),
 * found in the registry's reasons by what follows the quoted name; undefined
 * for a line no reason gives (a route's own line, an older backend's). */
export function reasonFor(person: string): NotReadyReason | undefined {
  const match = /^“[^”]+” (.*)$/.exec(person);
  const found = match ? NOT_READY_REASONS.find((reason) => reason.one === match[1]) : undefined;
  return found ? { one: found.one, many: found.many } : undefined;
}
