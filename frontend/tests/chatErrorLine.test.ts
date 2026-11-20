import { describe, expect, it } from 'vitest';
import { chatErrorLine } from '../src/lib/chatErrorLine';
import { isBecauseFailure } from '../src/lib/errorCopy';

const line = (message: string | null, extra: { code?: string; source?: string; agentName?: string } = {}) =>
  chatErrorLine({ message, agentName: 'Claude', ...extra }).text;
const full = (message: string | null, extra: { code?: string; source?: string; agentName?: string } = {}) =>
  chatErrorLine({ message, agentName: 'Claude', ...extra });

describe('the chat stream error line', () => {
  it('words a refused connection as a because line naming the agent', () => {
    expect(line('connection refused:')).toBe('Claude stopped because the connection was refused.');
    expect(line('Error: connect ECONNREFUSED 127.0.0.1:3000')).toBe('Claude stopped because the connection was refused.');
    expect(line('connection refused', { agentName: 'Your Codex' })).toBe('Your Codex stopped because the connection was refused.');
  });

  it('has no "Warning:" lead and no second colon', () => {
    for (const message of ['connection refused:', 'boom', 'claude exited with code 1', null]) {
      const text = line(message);
      expect(text).not.toMatch(/^Warning:/);
      expect(text).not.toContain(':');
    }
  });

  it('words an exit, a timeout and a missing CLI', () => {
    expect(line('claude exited with code 1')).toBe('Claude stopped because it exited with code 1.');
    expect(line('connect ETIMEDOUT 10.0.0.1:443')).toBe('Claude stopped because the connection timed out.');
    expect(line('socket hang up')).toBe('Claude stopped because the connection was reset.');
    expect(line('`claude` binary not found in PATH')).toBe('Claude stopped because its command wasn’t found. Check that it is installed.');
  });

  it('keeps an unknown fragment as the reason, cleaned of its colon form', () => {
    expect(line('Something odd happened:')).toBe('Claude stopped because something odd happened.');
    expect(line('API quota exhausted')).toBe('Claude stopped because API quota exhausted.');
    expect(line('exit code 2 :')).toBe('Claude stopped because exit code 2.');
  });

  it('says an unknown error when there is no message', () => {
    expect(line(null)).toBe('Claude stopped because of an unknown error.');
  });

  it('leaves a whole sentence for the person, and anything Nebula sent, as it is', () => {
    expect(line('Opus is no longer offered.', { code: 'model_unsupported' })).toBe('Opus is no longer offered.');
    expect(line('Fake Agent exited (code 3).', { code: 'personal_session_ended' })).toBe('Fake Agent exited (code 3).');
    expect(line('Another response is active. Stop it and wait for cancellation confirmation before sending again.', { source: 'system' }))
      .toBe('Another response is active. Stop it and wait for cancellation confirmation before sending again.');
    expect(line('Skipped an oversized stream event (likely a huge tool result). Continuing.')).toBe('Skipped an oversized stream event (likely a huge tool result). Continuing.');
  });

  it('is a because line, so it is drawn neutral', () => {
    expect(isBecauseFailure(line('connection refused'))).toBe(true);
    expect(isBecauseFailure('Opus is no longer offered.')).toBe(false);
  });

  it('says whether it is a because line itself, for any agent name', () => {
    expect(full('connection refused').because).toBe(true);
    expect(full('Opus is no longer offered.', { code: 'model_unsupported' }).because).toBe(false);
    const hermes = chatErrorLine({ message: 'boom', agentName: 'Hermes v2.0' });
    expect(hermes).toEqual({ text: 'Hermes v2.0 stopped because boom.', because: true });
    expect(chatErrorLine({ message: 'boom', agentName: `A${'x'.repeat(70)}` }).because).toBe(true);
  });

  it('drops the agent\'s own name from the reason and keeps names and acronyms capitalised', () => {
    expect(line('Codex turn failed', { agentName: 'Codex' })).toBe('Codex stopped because its turn failed.');
    expect(line('Hermes: request failed', { agentName: 'Hermes' })).toBe('Hermes stopped because its request failed.');
    expect(line('codex: out of credits', { agentName: 'Codex' })).toBe('Codex stopped because out of credits.');
    expect(line('Claude hit a rate limit')).toBe('Claude stopped because hit a rate limit.');
    expect(line('Gemini quota exhausted')).toBe('Claude stopped because Gemini quota exhausted.');
    expect(line('MCP server crashed')).toBe('Claude stopped because MCP server crashed.');
    expect(line('JSON parse failed')).toBe('Claude stopped because JSON parse failed.');
  });

  it('keeps the words of a timeout that is not a connection fault', () => {
    expect(line('Command timed out after 120s')).toBe('Claude stopped because command timed out after 120s.');
    expect(line('MCP tool call timed out')).toBe('Claude stopped because MCP tool call timed out.');
    expect(line('connection timed out')).toBe('Claude stopped because the connection timed out.');
  });

  it('puts a multi-line or long message behind Details', () => {
    const trace = 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: nope';
    expect(full(trace)).toEqual({ text: 'Claude stopped because its command failed.', because: true, details: trace });
    const long = `boom ${'x'.repeat(220)}`;
    expect(full(long)).toMatchObject({ text: 'Claude stopped because its command failed.', details: long });
    expect(full('connection refused').details).toBeUndefined();
  });

  it('capitalises a whole line from the backend unless it opens with an identifier, and drops an Error lead', () => {
    expect(line('invalid JSON', { source: 'system' })).toBe('Invalid JSON.');
    expect(line('ERROR: invalid JSON', { source: 'system' })).toBe('Invalid JSON.');
    expect(line('error: bad thing', { source: 'system' })).toBe('Bad thing.');
    expect(line('claude_cli went away', { source: 'system' })).toBe('claude_cli went away.');
    expect(line('JSON was invalid', { source: 'system' })).toBe('JSON was invalid.');
  });
});
