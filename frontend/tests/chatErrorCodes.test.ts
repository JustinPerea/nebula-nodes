/**
 * The chat handler never sends an error code the chat line can't read.
 *
 * chatErrorLine decides how an error event reads: a stop event (`stop: "error"` or `"ended"`) carries the agent's
 * words after "<Agent> stopped"; any other error is a refusal, and a refusal is shown as the whole line only when its
 * `code` is in WHOLE_LINE_CODES (or its source is "system"). A refusal whose code isn't listed, from a backend that
 * sends no `source: "system"`, would read as a fragment of an agent's reason ("Hermes stopped because ..."). So a new
 * code the backend can emit must be added there, or this test fails.
 *
 * The codes are read from the backend sources as text: the literals `"code": "<x>"` and the first argument of the
 * error classes the chat handler raises or relays (PersonalSessionError, ChatModelSelectionError, _DiscoveryError, and
 * PersonalAgentError for the launch_spec path). main.py is read only inside the chat websocket handler.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WHOLE_LINE_CODES } from '../src/lib/chatErrorLine';
import { PERSON_REQUIRED_CODE } from '../src/lib/errorCopy';

const BACKEND = join(__dirname, '..', '..', 'backend');
const source = (file: string) => ({ file, text: readFileSync(join(BACKEND, file), 'utf8') });

/** Sent with a `stop` (the agent ran and stopped): read by the stop form, not by WHOLE_LINE_CODES. */
const STOP_CODES = new Set(['personal_session_ended']);
/** Codes the chat line reads some other way. */
const READ_ELSEWHERE: ReadonlyMap<string, string> = new Map([
  [PERSON_REQUIRED_CODE, 'ChatPanel draws it from chatPersonRequiredCopy / personRequiredCopy'],
]);
/** Raised in the chat's modules but never sent as an error event. */
const NOT_AN_ERROR_EVENT: ReadonlyArray<readonly [RegExp, string]> = [
  [/^personal_option_/, 'personal_option failures go out as a personal_options event, whose `error` is text'],
];

const CLASSES = '(?:PersonalSessionError|ChatModelSelectionError|_DiscoveryError)';

/** The chat websocket handler's own text, out of main.py. */
export function chatHandlerText(main: string): string {
  const start = main.indexOf('async def chat_websocket');
  if (start < 0) throw new Error('chat_websocket not found in main.py');
  const after = main.slice(start + 1);
  const end = after.search(/\n(?=@app\.|(?:async )?def |class )/);
  return end < 0 ? after : after.slice(0, end);
}

/** Every error code a backend text can send in a chat error event. */
export function codesIn(text: string, personalAgentStatuses: readonly string[] = []): Set<string> {
  const codes = new Set<string>();
  for (const m of text.matchAll(/["']code["']\s*:\s*["']([a-z][a-z_0-9]*)["']/g)) codes.add(m[1]);
  for (const m of text.matchAll(new RegExp(`${CLASSES}\\(\\s*["']([a-z][a-z_0-9]*)["']`, 'g'))) codes.add(m[1]);
  // launch_spec: PersonalAgentError("personal_agent_<x>", ...) reaches the chat; the REST codes (invalid, conflict, not_found) do not.
  for (const m of text.matchAll(/PersonalAgentError\(\s*["'](personal_agent_[a-z_0-9]+)["']/g)) codes.add(m[1]);
  if (/PersonalAgentError\(\s*f["']personal_agent_\{view\.status\}["']/.test(text)) {
    for (const status of personalAgentStatuses) codes.add(`personal_agent_${status}`);
  }
  return codes;
}

/** The codes `sources` can send that the chat line can't read. */
export function unreadCodes(sources: readonly { file: string; text: string }[], known: ReadonlySet<string>, statuses: readonly string[] = []): string[] {
  const unread: string[] = [];
  for (const { file, text } of sources) {
    for (const code of codesIn(file.endsWith('main.py') ? chatHandlerText(text) : text, statuses)) {
      if (known.has(code) || STOP_CODES.has(code) || READ_ELSEWHERE.has(code) || NOT_AN_ERROR_EVENT.some(([pattern]) => pattern.test(code))) continue;
      unread.push(`${file}: ${code}`);
    }
  }
  return unread;
}

describe('every error code the chat handler can send is one the chat line reads', () => {
  const sources = ['main.py', 'services/chat_models.py', 'services/acp_session.py', 'services/personal_agents.py', 'services/chat_lines.py'].map(source);
  const statuses = /STATUSES = \(([^)]*)\)/.exec(sources.find((s) => s.file.endsWith('personal_agents.py'))!.text)![1]
    .split(',').map((s) => s.trim().replace(/["']/g, '')).filter((s) => s && s !== 'ready');

  it('reads the real sources', () => {
    expect(statuses).toEqual(['not_installed', 'needs_node', 'needs_setup', 'disabled']);
    const all = new Set(sources.flatMap(({ file, text }) => [...codesIn(file.endsWith('main.py') ? chatHandlerText(text) : text, statuses)]));
    for (const code of ['agent_invalid', 'provider_invalid', 'person_required', 'personal_session_ended', 'model_required', 'catalog_timeout',
      'auth_required', 'personal_agent_start_failed', 'personal_agent_needs_setup', 'personal_agent_disabled']) expect(all, code).toContain(code);
    // main.py is read inside the chat handler only: a code from another route is not in it.
    expect(all).not.toContain('version_conflict');
  });

  it('has no code the chat line would read as an agent\'s reason', () => {
    expect(unreadCodes(sources, WHOLE_LINE_CODES, statuses)).toEqual([]);
  });

  it('fails on a fixture with a new code', () => {
    const fake = [{ file: 'services/fake_session.py', text: 'raise PersonalSessionError("personal_agent_quota_used", "x")\nyield {"type": "error", "code": "brand_new_code"}' }];
    expect(unreadCodes(fake, WHOLE_LINE_CODES)).toEqual(['services/fake_session.py: brand_new_code', 'services/fake_session.py: personal_agent_quota_used']);
    const inHandler = [{ file: 'main.py', text: 'x = 1\nasync def chat_websocket(ws):\n    send({"type": "error", "code": "another_new_code"})\n\n@app.get("/x")\nasync def other():\n    return {"code": "elsewhere"}\n' }];
    expect(unreadCodes(inHandler, WHOLE_LINE_CODES)).toEqual(['main.py: another_new_code']);
  });

  it('passes a fixture whose codes are listed, a stop code, and a code read elsewhere', () => {
    const ok = [{ file: 'services/fake_session.py', text: 'PersonalSessionError("model_required", "x")\nPersonalSessionError("personal_session_ended", "x", stop="ended")\n{"code": "person_required"}' }];
    expect(unreadCodes(ok, WHOLE_LINE_CODES)).toEqual([]);
  });
});
