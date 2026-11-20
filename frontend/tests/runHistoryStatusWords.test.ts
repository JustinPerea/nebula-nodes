import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Design: a run's status word is a badge, so it reads "Running", "Failed",
// "Complete" and "Canceled" as written, with no caps transform.
describe('run history status words', () => {
  const css = readFileSync('src/styles/run-history.css', 'utf8');
  const rule = /\.run-history__status \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const panel = readFileSync('src/components/panels/RunHistoryPanel.tsx', 'utf8');

  it('draws the status word without a text transform', () => {
    expect(rule).not.toBe('');
    expect(rule).not.toMatch(/text-transform/);
  });

  it('stores the words in sentence case', () => {
    for (const word of ['Running', 'Complete', 'Failed', 'Canceled']) expect(panel).toContain(`'${word}'`);
  });
});
