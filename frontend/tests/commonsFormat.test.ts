import { describe, expect, it } from 'vitest';
import { actorLabel } from '../src/lib/commonsFormat';

describe('Commons actor labels', () => {
  it('shows the local human generically without modifying the legacy persisted actor stamp', () => {
    const actor = 'human:justin';
    expect(actorLabel(actor)).toBe('You');
    expect(actor).toBe('human:justin');
  });

  it('keeps imported notes and other actor identities distinguishable', () => {
    expect(actorLabel('import:moodboard')).toBe('moodboard note');
    expect(actorLabel('human:reviewer')).toBe('reviewer');
    expect(actorLabel('agent:claude:fixture')).toBe('agent:claude:fixture');
  });
});
