import { describe, expect, it } from 'vitest';

import { agentNameInSentence } from '../../src/lib/personalAgentName';

describe('agentNameInSentence', () => {
  it.each([
    ['Your Claude', 'your Claude'],
    ['Your Codex', 'your Codex'],
    ['Your Gemini', 'your Gemini'],
    ['Your Antigravity', 'your Antigravity'],
  ])('lowers the first word of %s', (name, expected) => {
    expect(agentNameInSentence(name)).toBe(expected);
  });

  it.each(['Claude (your setup)', 'Gemini (your setup)', 'Hermes', 'Yours truly', 'Your', 'Your ', 'Claude Code', ''])(
    'passes %j through unchanged',
    (name) => {
      expect(agentNameInSentence(name)).toBe(name);
    },
  );
});
