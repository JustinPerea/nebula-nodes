import { describe, expect, it } from 'vitest';
import { chatErrorLine } from '../src/lib/chatErrorLine';
import { DEFERS_TO_NOTICE, chatPersonRequiredCopy, isBecauseFailure, saysPersonRequired } from '../src/lib/errorCopy';
import { notConnectedKind } from '../src/lib/notConnectedLine';

type Extra = { code?: string; source?: string; stop?: string; agentName?: string };
const line = (message: string | null, extra: Extra = {}) => chatErrorLine({ message, agentName: 'Claude', ...extra }).text;
const full = (message: string | null, extra: Extra = {}) => chatErrorLine({ message, agentName: 'Claude', ...extra });

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
    expect(line('A response is still running. Stop it and wait for it to stop, then send again.', { source: 'system' }))
      .toBe('A response is still running. Stop it and wait for it to stop, then send again.');
    // A stop is never shown alone: it opens with the agent, whatever its reason's full stop.
    expect(line('Skipped a large event. Continuing.')).toBe('Claude stopped. Skipped a large event. Continuing.');
  });

  it('is a because line, so it is drawn neutral', () => {
    expect(isBecauseFailure(line('connection refused'))).toBe(true);
    expect(isBecauseFailure('Opus is no longer offered.')).toBe(false);
  });

  it('gives each line its tone: a stop error and a refusal are warnings, an ended session is neutral', () => {
    expect(full('connection refused').tone).toBe('error');
    expect(full('Opus is no longer offered.', { code: 'model_unsupported' }).tone).toBe('error');
    expect(chatErrorLine({ message: 'boom', agentName: 'Hermes v2.0' })).toEqual({ text: 'Hermes v2.0 stopped. Boom.', tone: 'error' });
    expect(chatErrorLine({ message: 'boom', agentName: `A${'x'.repeat(70)}` }).tone).toBe('error');
    expect(full('Hermes stopped after it sat idle. Send again to start a new conversation.', { stop: 'ended', agentName: 'Hermes' }).tone).toBe('neutral');
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
    expect(full(trace)).toEqual({ text: 'Claude stopped because its command failed.', tone: 'error', details: trace });
    const long = `boom ${'x'.repeat(220)}`;
    expect(full(long)).toMatchObject({ text: 'Claude stopped because its command failed.', details: long });
    expect(full('connection refused').details).toBeUndefined();
  });

  it('shows a long single-line stop written for the person after the agent\'s name, with its apostrophes curled, in the error tone and no Details', () => {
    const apiKey = 'Codex agent is restricted to ChatGPT account login in Nebula. Current Codex auth is API-key billing mode. Use “Connect ChatGPT account” in Nebula, or run `codex logout` then `codex login` without `--with-api-key`.';
    expect(apiKey.length).toBeGreaterThan(200);
    expect(full(apiKey, { agentName: 'Codex' })).toEqual({ text: `Codex stopped. ${apiKey}`, tone: 'error' });
    // The backend sends a straight apostrophe; the chat line curls it where it renders.
    const features = 'Codex has features on that Nebula hasn\'t reviewed for its agent (browser_use, js_repl), so the turn was not started. Review them and add each to CODEX_ALLOWED_FEATURES or CODEX_DISABLED_FEATURES in services/agent_profiles.py.';
    expect(features.length).toBeGreaterThan(200);
    expect(full(features, { agentName: 'Codex' })).toEqual({ text: `Codex stopped. ${features.replace("hasn't", 'hasn’t')}`, tone: 'error' });
  });

  it('puts a 6-line stack trace and a long non-sentence dump behind Details', () => {
    const trace = ['Traceback (most recent call last):', '  File "a.py", line 3, in run', '    go()', '  File "b.py", line 9, in go', '    raise ValueError("nope")', 'ValueError: nope.'].join('\n');
    expect(full(trace)).toEqual({ text: 'Claude stopped because its command failed.', tone: 'error', details: trace });
    const dump = `Traceback ${'frame '.repeat(50)}ended`;
    expect(full(dump)).toMatchObject({ text: 'Claude stopped because its command failed.', details: dump });
    const multiSentence = 'Something failed. '.repeat(15).trim();
    expect(full(`${multiSentence}\nmore`).details).toBeDefined();
  });

  it('capitalises a whole line from the backend unless it opens with an identifier, and drops an Error lead', () => {
    expect(line('Nebula couldn’t read that message. Reload the page, then send again.', { source: 'system' })).toBe('Nebula couldn’t read that message. Reload the page, then send again.');
    expect(line('ERROR: nebula couldn’t read that message', { source: 'system' })).toBe('Nebula couldn’t read that message.');
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
    expect(line("Couldn't read `~/it's/file.png` because it isn't there.")).toBe('Claude stopped. Couldn’t read `~/it\'s/file.png` because it isn’t there.');
    expect(line('No API key')).toBe('Claude stopped. No API key.');
    expect(line('Cannot open the file')).toBe('Claude stopped. Cannot open the file.');
    expect(line('Missing file')).toBe('Claude stopped. Missing file.');
    // Already ended by an ellipsis, a URL or a colon-free stop.
    expect(line('Waiting for the host…')).toBe('Claude stopped. Waiting for the host…');
    expect(line('See https://fal.ai/docs')).toBe('Claude stopped. See https://fal.ai/docs');
    // A closing full stop in the reason changes neither the form nor the tone.
    expect(line('Missing file.')).toBe('Claude stopped. Missing file.');
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

describe('the chat line takes its form and tone from the event', () => {
  const hermes = (message: string | null, extra: Extra = {}) => chatErrorLine({ message, agentName: 'Hermes', ...extra });

  it('stop: error opens "<Agent> stopped", in the warning tone, whether or not the reason has a full stop', () => {
    for (const reason of ['it lost its connection', 'It lost its connection', 'It lost its connection.']) {
      expect(hermes(reason, { stop: 'error' })).toEqual({ text: 'Hermes stopped because it lost its connection.', tone: 'error' });
    }
    // A reason that opens with no subject is a sentence of its own, again the same with or without the stop.
    for (const reason of ['Couldn’t read the file', 'Couldn’t read the file.']) {
      expect(hermes(reason, { stop: 'error' })).toEqual({ text: 'Hermes stopped. Couldn’t read the file.', tone: 'error' });
    }
    // A whole-sentence reason with its stop is no longer shown alone.
    expect(hermes('The host is down.', { stop: 'error' }).text).toBe('Hermes stopped because the host is down.');
    // The agent's own error answer, "<Name>: message".
    expect(hermes('Hermes: request failed', { stop: 'error' }).text).toBe('Hermes stopped because its request failed.');
  });

  it('a stop error with a code is still a stop (a crashed personal session)', () => {
    expect(hermes('Hermes exited (code 3)', { stop: 'error', code: 'personal_session_ended' }))
      .toEqual({ text: 'Hermes stopped because it exited (code 3).', tone: 'error' });
  });

  it('a line that already opens with the stop is shown as it is, still a warning', () => {
    expect(hermes('This chat’s agent stopped. Send again to start a new conversation.', { stop: 'error', code: 'personal_session_ended' }))
      .toEqual({ text: 'This chat’s agent stopped. Send again to start a new conversation.', tone: 'error' });
    expect(hermes('Hermes stopped after it sat idle.', { stop: 'error' }).text).toBe('Hermes stopped after it sat idle.');
  });

  it('stop: ended is the backend line as it is, neutral', () => {
    const idle = 'Hermes stopped after it sat idle. Send again to start a new conversation.';
    expect(hermes(idle, { stop: 'ended', code: 'personal_session_ended' })).toEqual({ text: idle, tone: 'neutral' });
    const commons = 'Hermes stopped because Commons is on. Pick Claude or Codex to keep chatting.';
    expect(hermes(commons, { stop: 'ended', code: 'personal_session_ended' })).toEqual({ text: commons, tone: 'neutral' });
    expect(hermes('This chat\'s agent stopped. Send again to start a new conversation.', { stop: 'ended' }).text)
      .toBe('This chat’s agent stopped. Send again to start a new conversation.');
    expect(hermes(null, { stop: 'ended' })).toEqual({ text: 'Hermes stopped.', tone: 'neutral' });
  });

  it('a missing stop on an event that is not a refusal reads as an error stop', () => {
    expect(hermes('boom')).toEqual({ text: 'Hermes stopped. Boom.', tone: 'error' });
    expect(hermes('It lost its connection')).toEqual({ text: 'Hermes stopped because it lost its connection.', tone: 'error' });
    expect(hermes('Hermes exited (code 3).', { code: 'some_new_code' }).tone).toBe('error');
  });

  it('a refusal (source system, or a whole-line code, with no stop) is a whole line in the warning tone', () => {
    const reload = 'Nebula couldn’t read that message. Reload the page, then send again.';
    expect(hermes(reload, { source: 'system' })).toEqual({ text: reload, tone: 'error' });
    expect(hermes(reload, { code: 'model_invalid' })).toEqual({ text: reload, tone: 'error' });
    expect(hermes('Commons is on, so only Claude and Codex can chat. Pick one of them, then send again.', { source: 'system' }).text)
      .toBe('Commons is on, so only Claude and Codex can chat. Pick one of them, then send again.');
    expect(hermes('Codex isn’t installed. Install it, then send again.', { code: 'cli_not_installed' }).text).toBe('Codex isn’t installed. Install it, then send again.');
    expect(hermes('Hermes needs setup. Install Node.js 20.', { code: 'personal_agent_needs_node' }).tone).toBe('error');
    expect(hermes('Hermes needs you to sign in. Sign in, then send again.', { code: 'auth_required' }).text).toBe('Hermes needs you to sign in. Sign in, then send again.');
  });

  it('every refusal code the backend sends is a whole line', () => {
    const codes = ['personal_session_ended', 'personal_agent_warning_required', 'agent_invalid', 'provider_invalid', 'model_unsupported',
      'effort_unsupported', 'model_required', 'model_invalid', 'effort_invalid', 'auth_required', 'auth_unknown', 'cli_not_installed',
      'catalog_unavailable', 'catalog_cleanup_failed', 'catalog_timeout', 'catalog_invalid', 'personal_agent_unknown',
      'personal_agent_disabled', 'personal_agent_not_installed', 'personal_agent_needs_node', 'personal_agent_needs_setup',
      'personal_agent_changed', 'personal_agent_limit', 'personal_agent_shutting_down', 'personal_agent_start_timeout',
      'personal_agent_start_failed', 'acp_version_unsupported'];
    for (const code of codes) expect(hermes('Pick another, then send again.', { code })).toEqual({ text: 'Pick another, then send again.', tone: 'error' });
  });

  it('a raw dump (line breaks, or long and not whole sentences) is a short stop line with the raw text under Details', () => {
    const trace = 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: nope.';
    expect(hermes(trace, { stop: 'error' })).toEqual({ text: 'Hermes stopped because its command failed.', tone: 'error', details: trace });
    const dump = `Traceback ${'frame '.repeat(50)}ended`;
    expect(hermes(dump, { stop: 'error' })).toMatchObject({ text: 'Hermes stopped because its command failed.', tone: 'error', details: dump });
  });

});

describe('the chat’s person_required wording, by what the tab was doing', () => {
  it('has a line for each action in a tab, the desktop app and the two developer setups', () => {
    expect(chatPersonRequiredCopy('send', false)).toBe('This tab isn’t connected as you, so it can’t start a chat. Open the link Nebula printed when it started, then send again.');
    expect(chatPersonRequiredCopy('send', true, '')).toBe('This window isn’t connected as you, so it can’t start a chat. Quit Nebula and open it again, then send again.');
    expect(chatPersonRequiredCopy('send', true, 'debug-port')).toBe(`This window isn’t connected as you, so it can’t start a chat. ${DEFERS_TO_NOTICE}`);
    expect(chatPersonRequiredCopy('answer', false)).toBe('Nebula can’t answer or close the agent from this tab because it isn’t connected as you. Open the link Nebula printed when it started.');
    expect(chatPersonRequiredCopy('answer', true, '')).toBe('Nebula can’t answer or close the agent from this window because it isn’t connected as you. Quit Nebula and open it again.');
    expect(chatPersonRequiredCopy('answer', true, 'dev-renderer')).toBe(`Nebula can’t answer or close the agent from this window because it isn’t connected as you. ${DEFERS_TO_NOTICE}`);
  });
  it('is read like the general line: it carries the person-required reason, and the dev lines defer to the notice', () => {
    for (const action of ['send', 'answer'] as const) {
      for (const [desktop, reason] of [[false, ''], [true, ''], [true, 'debug-port']] as const) {
        const text = chatPersonRequiredCopy(action, desktop, reason);
        expect(saysPersonRequired(text), text).toBe(true);
        expect(notConnectedKind(text), text).toBe(reason === 'debug-port' ? 'defers' : 'fix');
      }
    }
  });
});

describe('a turn Claude or Codex was refused before the CLI ran is a whole line, not a stop', () => {
  const REFUSALS: ReadonlyArray<readonly [string, string]> = [
    ['cli_not_installed', 'Claude Code isn’t installed. Install it, then send again.'],
    ['agent_grant_overlap', 'Nebula didn’t start Claude Code because a folder it would open overlaps one Nebula keeps private. Make sure Nebula’s output and Commons folders are separate, then send again.'],
    ['agent_knowledge_unavailable', 'Nebula couldn’t copy its reference files for Claude Code, so it didn’t start. Restart Nebula, then send again. If it keeps happening, reinstall Nebula.'],
    ['codex_features_refused', 'Codex has features on that Nebula hasn’t reviewed (`browser_use`), so it didn’t start. Update Nebula, then send again.'],
    ['codex_chatgpt_required', 'Codex is using an API key, and Nebula needs a ChatGPT account. Use Connect ChatGPT account above the message box, then send again.'],
    ['personal_agent_start_interrupted', 'Fake Agent couldn’t start because the chat was closed or replaced. Send again to start a new conversation.'],
  ];

  it.each(REFUSALS)('reads %s as its own line in the warning tone, with no "Claude stopped"', (code, message) => {
    // The backend sends a code and no stop, and no source "system" for a Claude or Codex turn.
    const shown = chatErrorLine({ message, code, source: 'claude', agentName: 'Claude' });
    expect(shown).toEqual({ text: message, tone: 'error' });
    expect(shown.text).not.toMatch(/ stopped/);
  });

  it('would read the same line as a stop if its code were not listed', () => {
    expect(chatErrorLine({ message: REFUSALS[1][1], code: 'unlisted_code', source: 'claude', agentName: 'Claude' }).text).toMatch(/^Claude stopped/);
  });

  it('keeps the lines for older code-less backends: the missing-command text still reads as a stop', () => {
    expect(line('`codex` binary not found in PATH', { agentName: 'Codex' })).toBe('Codex stopped because its command wasn’t found. Check that it is installed.');
  });
});
