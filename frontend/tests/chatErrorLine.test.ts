import { describe, expect, it } from 'vitest';
import { chatErrorLine } from '../src/lib/chatErrorLine';
import { isBecauseFailure } from '../src/lib/errorCopy';

const line = (message: string | null, extra: { code?: string; source?: string; agentName?: string } = {}) =>
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
    expect(line('request timed out')).toBe('Claude stopped because the connection timed out.');
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
});
