import { describe, expect, it } from 'vitest';
import table from '../../../backend/tests/fixtures/missing_key_lines.json';
import { KEY_NAMES, missingKeyLine, withArticle } from '../../src/lib/directRoute';
import { withArticle as readinessArticle } from '../../src/lib/providerReadiness';

// One table of cases, read by backend/tests/test_missing_key_line.py too (copy sweep item 12): both sides
// give the same line for the same keys.
describe('the missing-key line matches the backend', () => {
  it.each(table.cases.map((row) => [row.keys.join(' + ') || '(no key)', row.keys, row.line] as const))('%s', (_name, keys, line) => {
    expect(missingKeyLine(keys)).toBe(line);
  });

  it.each(table.articles)('%s takes its article by sound', (name, expected) => {
    expect(withArticle(name)).toBe(expected);
  });

  it('providerReadiness exports the same article helper', () => {
    expect(readinessArticle).toBe(withArticle);
  });

  it('every key Settings stores has a row', () => {
    const rows = new Set(table.cases.filter((row) => row.keys.length === 1).map((row) => row.keys[0]));
    for (const key of Object.keys(KEY_NAMES)) expect(rows.has(key), key).toBe(true);
  });
});
