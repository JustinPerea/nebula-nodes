import { describe, expect, it } from 'vitest';
import {
  AGENT_SAY_MAX_CHARS,
  DEFAULT_SAY_EXAMPLES,
  defaultSay,
  errorCause,
  heldDefault,
  middleCut,
  sayHoldMs,
} from '../src/lib/agentCursorSays';
import { AGENT_CURSOR_ERROR_CAUSE_MS } from '../src/lib/agentCursorTuning';

/** The default say lines, as GM approved them (r54, 2026-11-03). */
describe('default say lines', () => {
  it('match GM r54 word for word', () => {
    expect(DEFAULT_SAY_EXAMPLES.map(({ action, line }) => `${action}: ${line}`)).toEqual([
      'look: Looking at “Brief”',
      'look: Looking here',
      'think: Thinking',
      'type: Writing the prompt for “FLUX.2”',
      'type: Changing “Resolution” on “FLUX.2”',
      'type: Writing',
      'drag: Connecting “Brief” to “FLUX.2”',
      'drag: Connecting to “FLUX.2”',
      'drag: Connecting',
      'run: Started “FLUX.2”',
      'run: Started a run',
      'propose: Waiting for your OK',
      'wait: Waiting for your answer',
      'error: Couldn’t run “FLUX.2”',
      'error: Couldn’t change “FLUX.2”',
      'error: Couldn’t do that',
    ]);
  });

  it('move and click have none (a click’s words are the agent’s)', () => {
    expect(defaultSay('move', { node: 'Brief' })).toBe('');
    expect(defaultSay('click', { node: 'Brief' })).toBe('');
  });

  it('a drag to a spot with no start pulls no wire, so it says nothing, like move (r54 item 3)', () => {
    expect(defaultSay('drag', { node: null, pulled: false })).toBe('');
    expect(defaultSay('drag', { node: null, pulled: true })).toBe('Connecting');
  });

  it('error says what failed: a run, a change, or neither (r54 item 2)', () => {
    expect(defaultSay('error', { node: 'FLUX.2', cause: 'run' })).toBe('Couldn’t run “FLUX.2”');
    expect(defaultSay('error', { node: 'FLUX.2', cause: 'change' })).toBe('Couldn’t change “FLUX.2”');
    expect(defaultSay('error', { node: 'FLUX.2', cause: null })).toBe('Couldn’t do that');
    expect(defaultSay('error', { node: null, cause: 'run' })).toBe('Couldn’t do that');
  });

  it('sentence case, no period, curly quotes only', () => {
    for (const { line } of DEFAULT_SAY_EXAMPLES) {
      expect(line[0]).toBe(line[0].toUpperCase());
      expect(line.endsWith('.')).toBe(false);
      expect(line).not.toMatch(/["']/);
    }
  });

  it('long names are cut in the middle so the line fits the say cap', () => {
    const long = 'A'.repeat(100) + 'Z'.repeat(100);
    const line = defaultSay('drag', { node: long, from: long, pulled: true });
    expect(Array.from(line).length).toBeLessThanOrEqual(AGENT_SAY_MAX_CHARS);
    expect(line).toMatch(/^Connecting “A+…Z+” to “A+…Z+”$/);
    expect(middleCut('FLUX.2', 40)).toBe('FLUX.2');
    expect(middleCut('abcdefghij', 7)).toBe('abcd…ij');
  });
});

describe('what an error failed at', () => {
  const did = (verb: string, nodeId = 'n2', at = 1000) => ({ verb, nodeId, at });
  it('a run or a change on the same node, just before', () => {
    expect(errorCause(did('Ran'), 'n2', 2000)).toBe('run');
    expect(errorCause(did('Tried to run'), 'n2', 2000)).toBe('run');
    for (const verb of ['Changed', 'Renamed', 'Added', 'Connected', 'Disconnected', 'Moved', 'Removed']) {
      expect(errorCause(did(verb), 'n2', 2000)).toBe('change');
    }
  });
  it('unknown for another node, an old action, another verb, or none', () => {
    expect(errorCause(did('Ran', 'n3'), 'n2', 2000)).toBeNull();
    expect(errorCause(did('Ran'), 'n2', 1000 + AGENT_CURSOR_ERROR_CAUSE_MS + 1)).toBeNull();
    expect(errorCause(did('Ran'), 'n2', 1000 + AGENT_CURSOR_ERROR_CAUSE_MS)).toBe('run');
    expect(errorCause(did('Proposed'), 'n2', 2000)).toBeNull();
    expect(errorCause(null, 'n2', 2000)).toBeNull();
    expect(errorCause(did('Ran'), null, 2000)).toBeNull();
  });
});

describe('how long a say holds (r54)', () => {
  it('max(3 s, 60 ms × characters), capped at 8 s', () => {
    expect(sayHoldMs('')).toBe(3000);
    expect(sayHoldMs('x'.repeat(50))).toBe(3000);
    expect(sayHoldMs('x'.repeat(51))).toBe(3060);
    expect(sayHoldMs('x'.repeat(100))).toBe(6000);
    expect(sayHoldMs('x'.repeat(133))).toBe(7980);
    expect(sayHoldMs('x'.repeat(134))).toBe(8000);
    expect(sayHoldMs('x'.repeat(140))).toBe(8000);
    // Characters, not UTF-16 units.
    expect(sayHoldMs('😀'.repeat(60))).toBe(3600);
  });
  it('a default tied to a held state holds with it: think, propose, wait', () => {
    expect(['think', 'propose', 'wait'].every((a) => heldDefault(a as never))).toBe(true);
    expect(['look', 'type', 'drag', 'run', 'error', 'move', 'click'].some((a) => heldDefault(a as never))).toBe(false);
  });
});
