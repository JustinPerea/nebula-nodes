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
    expect(line('Something odd happened:')).toBe('Claude stopped. Something odd happened.');
    expect(line('API quota exhausted')).toBe('Claude stopped. API quota exhausted.');
    expect(line('exit code 2 :')).toBe('Claude stopped. Exit code 2.');
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
    expect(hermes).toEqual({ text: 'Hermes v2.0 stopped. Boom.', because: true });
    expect(chatErrorLine({ message: 'boom', agentName: `A${'x'.repeat(70)}` }).because).toBe(true);
  });

  it('drops the agent\'s own name from the reason and keeps names and acronyms capitalised', () => {
    expect(line('Codex turn failed', { agentName: 'Codex' })).toBe('Codex stopped because its turn failed.');
    expect(line('Hermes: request failed', { agentName: 'Hermes' })).toBe('Hermes stopped because its request failed.');
    expect(line('codex: out of credits', { agentName: 'Codex' })).toBe('Codex stopped. Out of credits.');
    expect(line('Claude hit a rate limit')).toBe('Claude stopped because it hit a rate limit.');
    expect(line('Gemini quota exhausted')).toBe('Claude stopped. Gemini quota exhausted.');
    expect(line('MCP server crashed')).toBe('Claude stopped. MCP server crashed.');
    expect(line('JSON parse failed')).toBe('Claude stopped. JSON parse failed.');
  });

  it('keeps the words of a timeout that is not a connection fault', () => {
    expect(line('Command timed out after 120s')).toBe('Claude stopped because its command timed out after 120s.');
    expect(line('Process exited unexpectedly')).toBe('Claude stopped because its process exited unexpectedly.');
    expect(line('Request was rejected')).toBe('Claude stopped because its request was rejected.');
    expect(line('Commander lost the thread')).toBe('Claude stopped. Commander lost the thread.');
    expect(line('MCP tool call timed out')).toBe('Claude stopped. MCP tool call timed out.');
    expect(line('connection timed out')).toBe('Claude stopped because the connection timed out.');
  });

  it('puts a multi-line or long message behind Details', () => {
    const trace = 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: nope';
    expect(full(trace)).toEqual({ text: 'Claude stopped because its command failed.', because: true, details: trace });
    const long = `boom ${'x'.repeat(220)}`;
    expect(full(long)).toMatchObject({ text: 'Claude stopped because its command failed.', details: long });
    expect(full('connection refused').details).toBeUndefined();
  });

  it('shows a long single-line refusal written for the person with its apostrophes curled, with the error tone and no Details', () => {
    const apiKey = 'Codex agent is restricted to ChatGPT account login in Nebula. Current Codex auth is API-key billing mode. Use “Connect ChatGPT account” in Nebula, or run `codex logout` then `codex login` without `--with-api-key`.';
    expect(apiKey.length).toBeGreaterThan(200);
    expect(full(apiKey, { agentName: 'Codex' })).toEqual({ text: apiKey, because: false });
    // The backend sends a straight apostrophe; the chat line curls it where it renders.
    const features = 'Codex has features on that Nebula hasn\'t reviewed for its agent (browser_use, js_repl), so the turn was not started. Review them and add each to CODEX_ALLOWED_FEATURES or CODEX_DISABLED_FEATURES in services/agent_profiles.py.';
    expect(features.length).toBeGreaterThan(200);
    expect(full(features, { agentName: 'Codex' })).toEqual({ text: features.replace("hasn't", 'hasn’t'), because: false });
  });

  it('puts a 6-line stack trace and a long non-sentence dump behind Details', () => {
    const trace = ['Traceback (most recent call last):', '  File "a.py", line 3, in run', '    go()', '  File "b.py", line 9, in go', '    raise ValueError("nope")', 'ValueError: nope.'].join('\n');
    expect(full(trace)).toEqual({ text: 'Claude stopped because its command failed.', because: true, details: trace });
    const dump = `Traceback ${'frame '.repeat(50)}ended`;
    expect(full(dump)).toMatchObject({ text: 'Claude stopped because its command failed.', details: dump });
    const multiSentence = 'Something failed. '.repeat(15).trim();
    expect(full(`${multiSentence}\nmore`).details).toBeDefined();
  });

  it('capitalises a whole line from the backend unless it opens with an identifier, and drops an Error lead', () => {
    expect(line('invalid JSON', { source: 'system' })).toBe('Invalid JSON.');
    expect(line('ERROR: invalid JSON', { source: 'system' })).toBe('Invalid JSON.');
    expect(line('error: bad thing', { source: 'system' })).toBe('Bad thing.');
    expect(line('claude_cli went away', { source: 'system' })).toBe('claude_cli went away.');
    expect(line('JSON was invalid', { source: 'system' })).toBe('JSON was invalid.');
  });
  it('keeps a provider or agent name capital, also as a possessive, and lower-cases other words', () => {
    expect(line('Krea’s reader can’t open it')).toBe('Claude stopped because Krea’s reader can’t open it.');
    expect(line("Krea's reader can't open it")).toBe('Claude stopped because Krea’s reader can’t open it.');
    expect(line('Krea can’t read the file')).toBe('Claude stopped because Krea can’t read the file.');
    expect(line('KREA’s reader can’t open it')).toBe('Claude stopped because Krea’s reader can’t open it.');
    expect(line('Black Forest Labs can’t read the file')).toBe('Claude stopped because Black Forest Labs can’t read the file.');
    expect(line('Hugging Face’s Space is asleep')).toBe('Claude stopped because Hugging Face’s Space is asleep.');
    expect(line('Your Codex’s session is gone', { agentName: 'Your Codex' })).toBe('Your Codex stopped because Your Codex’s session is gone.');
    expect(line('Atlas’s host is gone', { agentName: 'Nova' })).toBe('Nova stopped. Atlas’s host is gone.');
    expect(line('The file is too large')).toBe('Claude stopped because the file is too large.');
    expect(line('Kreator can’t help')).toBe('Claude stopped. Kreator can’t help.');
  });

  it('lower-cases only a provider name that is a verb, and then it is not a subject (item 1 and 7)', () => {
    // Replicate and Google are ordinary verbs: "Replicate it again" opens no subject, so it is a sentence of its own.
    expect(line('Replicate the prompt and retry')).toBe('Claude stopped. Replicate the prompt and retry.');
    expect(line('Replicate it again')).toBe('Claude stopped. Replicate it again.');
    expect(line('Google the error code')).toBe('Claude stopped. Google the error code.');
    // Replicate as a name: followed by "its", a possessive, a verb.
    expect(line('Replicate its queue is down')).toBe('Claude stopped because Replicate its queue is down.');
    expect(line('Replicate’s queue is down')).toBe('Claude stopped because Replicate’s queue is down.');
    // Every other provider keeps its name whatever follows.
    for (const after of ['a', 'an', 'this', 'that', 'these', 'those', 'your', 'my', 'it', 'them']) {
      expect(line(`Runway ${after} thing`)).toBe(`Claude stopped because Runway ${after} thing.`);
    }
    expect(line('Krea this morning failed')).toBe('Claude stopped because Krea this morning failed.');
    expect(line('Runway returned an error')).toBe('Claude stopped because Runway returned an error.');
    expect(line('Krea’s reader can’t open it')).toBe('Claude stopped because Krea’s reader can’t open it.');
  });
  it('joins with "because" only when the reason opens with a subject (item 7)', () => {
    // Not a subject: two sentences, the second keeping its capital.
    expect(line("Couldn't read `~/it's/file.png` because it isn't there")).toBe('Claude stopped. Couldn’t read `~/it\'s/file.png` because it isn’t there.');
    expect(line("Couldn't read `~/it's/file.png` because it isn't there.")).toBe('Couldn’t read `~/it\'s/file.png` because it isn’t there.');
    expect(line('No API key')).toBe('Claude stopped. No API key.');
    expect(line('Cannot open the file')).toBe('Claude stopped. Cannot open the file.');
    expect(line('Missing file')).toBe('Claude stopped. Missing file.');
    // Already ended by an ellipsis, a URL or a colon-free stop.
    expect(line('Waiting for the host…')).toBe('Claude stopped. Waiting for the host…');
    expect(line('See https://fal.ai/docs')).toBe('Claude stopped. See https://fal.ai/docs');
    // A reason that is already a whole sentence with its stop reads as it is (the whole-line rule), with no "stopped" lead.
    expect(line('Missing file.')).toBe('Missing file.');
    // Pronouns and determiners are subjects.
    for (const word of ['I', 'You', 'He', 'She', 'It', 'We', 'They']) {
      expect(line(`${word} could not finish`)).toBe(`Claude stopped because ${word === 'I' ? 'I' : word.toLowerCase()} could not finish.`);
    }
    for (const word of ['The', 'A', 'An', 'This', 'That', 'Your', 'Its', 'Their']) {
      expect(line(`${word} host is gone`)).toBe(`Claude stopped because ${word.toLowerCase()} host is gone.`);
    }
    // A provider name, a possessive name and the agent's own name are subjects; the agent name stands in for "Claude".
    expect(line('OpenAI is down')).toBe('Claude stopped because OpenAI is down.');
    expect(line('Hugging Face’s Space is asleep')).toBe('Claude stopped because Hugging Face’s Space is asleep.');
    expect(line('Atlas’s host is gone', { agentName: 'Atlas' })).toBe('Atlas stopped because Atlas’s host is gone.');
    expect(line('Hermes lost the thread', { agentName: 'Hermes v2.0' })).toBe('Hermes v2.0 stopped. Hermes lost the thread.');
    // The agent's own name at the front is dropped first (it is the line's subject already), leaving no subject.
    expect(line('Nova lost the thread', { agentName: 'Nova' })).toBe('Nova stopped because it lost the thread.');
    // A log label (the name, then a separator) is not a subject: the reason is a sentence of its own.
    expect(line('Nova: lost the thread', { agentName: 'Nova' })).toBe('Nova stopped. Lost the thread.');
    expect(line('Nova - couldn’t read the file', { agentName: 'Nova' })).toBe('Nova stopped. Couldn’t read the file.');
    expect(line('claude couldn’t read the file')).toBe('Claude stopped because it couldn’t read the file.');
    // A capital after the name is more of a name, not a verb.
    expect(line('Claude Code crashed')).toBe('Claude stopped because Claude Code crashed.');
    // A separator still strips the name.
    expect(line('Claude: Code crashed')).toBe('Claude stopped. Code crashed.');
    expect(line('Claude - Code crashed')).toBe('Claude stopped. Code crashed.');
    // No reason at all.
    expect(line('')).toBe('Claude stopped because of an unknown error.');
    expect(line('Error:')).toBe('Claude stopped because of an unknown error.');
  });
  it('a reason that is only a subject, with no verb, still joins "because" (known limit)', () => {
    // Known limit: there is no verb detection, so a reason that is just a noun phrase reads as a broken clause.
    // It did the same before the copy-name work. Pinned so a later change is deliberate.
    expect(line('An error')).toBe('Claude stopped because an error.');
    expect(line('Replicate')).toBe('Claude stopped because Replicate.');
  });
  it('writes a kept provider name as the app spells it', () => {
    expect(line('Fal.ai/x.png missing')).toBe('Claude stopped because fal.ai/x.png missing.');
    expect(line('FAL.AI is down')).toBe('Claude stopped because fal.ai is down.');
    expect(line('Hugging face hub error')).toBe('Claude stopped because Hugging Face hub error.');
    expect(line('Typesafe check failed')).toBe('Claude stopped because TypeSafe check failed.');
    expect(line('typesafe check failed')).toBe('Claude stopped because TypeSafe check failed.');
    expect(line('krea’s reader failed')).toBe('Claude stopped because Krea’s reader failed.');
  });
  it('names an agent with no name "Your agent"', () => {
    expect(line('connection refused', { agentName: '' })).toBe('Your agent stopped because the connection was refused.');
    expect(line('boom', { agentName: '   ' })).toBe('Your agent stopped. Boom.');
    expect(line(null, { agentName: '' })).toBe('Your agent stopped because of an unknown error.');
  });
});
