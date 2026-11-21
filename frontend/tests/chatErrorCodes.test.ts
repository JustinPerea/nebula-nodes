/**
 * The chat handler never sends an error code the chat line can't read.
 *
 * chatErrorLine decides how an error event reads: a stop event (`stop: "error"` or `"ended"`) carries the agent's
 * words after "<Agent> stopped"; any other error is a refusal, and a refusal is shown as the whole line only when its
 * `code` is in WHOLE_LINE_CODES (or its source is "system"). A refusal whose code isn't listed, from a backend that
 * sends no `source: "system"`, would read as a fragment of an agent's reason ("Hermes stopped because ..."). So a new
 * code the backend can emit must be added there, or this test fails.
 *
 * The codes are read from the backend sources as text, in every form a code is written:
 *  - the literal `"code": "<x>"`, and `code="<x>"` as a keyword argument;
 *  - the first argument of the error classes the chat handler raises or relays (PersonalSessionError,
 *    ChatModelSelectionError, _DiscoveryError, start_refusal, and PersonalAgentError for the launch_spec path);
 *  - the second argument of PreflightRefusal(text, "code") (its text is first), and the default of a
 *    getattr(x, "code", DEFAULT) that start_refusal is given;
 *  - a module-level constant (`NAME_CODE = "<x>"`, or any UPPER_CASE constant used where a code goes);
 *  - an f-string whose placeholder has a known expansion (`personal_agent_{view.status}`); one that has none is
 *    reported as unreadable, since its codes can't be listed.
 * main.py is read only inside the chat websocket handler. The sources are the modules the handler imports an error
 * class from (errorModules), plus the runners' own (AGENT_RUNNER_MODULES).
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

const CLASSES = '(?:PersonalSessionError|ChatModelSelectionError|_DiscoveryError|start_refusal)';
/** A code as written: a quoted string, an f-string, or an UPPER_CASE constant. */
const EXPR = '(f?["\'][^"\'\\n]*["\']|[A-Z][A-Z0-9_]*\\b(?:\\.\\w+\\(|\\[)?)';
/** The modules Claude's and Codex's runners (AGENT_RUNNERS) and the chat's lines live in. */
const AGENT_RUNNER_MODULES = ['services/chat_session.py', 'services/codex_session.py', 'services/chat_lines.py'];

/** The chat websocket handler's own text, out of main.py. */
export function chatHandlerText(main: string): string {
  const start = main.indexOf('async def chat_websocket');
  if (start < 0) throw new Error('chat_websocket not found in main.py');
  const after = main.slice(start + 1);
  const end = after.search(/\n(?=@app\.|(?:async )?def |class )/);
  return end < 0 ? after : after.slice(0, end);
}

/** The modules (backend files, "services/x.py") that main.py's chat handler imports an error class from: every
 * `from services.x import ... SomeError` in main.py whose class the handler names. */
export function errorModules(main: string): string[] {
  const handler = chatHandlerText(main);
  const used = new Set(handler.match(/\b[A-Za-z_]*Error\b/g) ?? []);
  const modules = new Set<string>();
  for (const m of main.matchAll(/^[ \t]*from ((?:services|commons)(?:\.\w+)*) import (\([^)]*\)|[^\n]*)/gm)) {
    const names = m[2].replace(/[()]/g, '').split(/[,\s]+/).filter(Boolean);
    if (names.some((name) => used.has(name) && /Error$/.test(name))) modules.add(`${m[1].replace(/\./g, '/')}.py`);
  }
  return [...modules].sort();
}

/** The string constants a text defines at module level: NAME = "value" (an UPPER_CASE name, at the margin). */
export function constantsIn(text: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*["']([a-z][a-z_0-9]*)["']\s*(?:#.*)?$/gm)) constants.set(m[1], m[2]);
  return constants;
}

/** The top-level arguments of the call whose "(" is at `open`, as written: commas inside a string, a bracket or a
 * nested call don't split. Python strings only (single or double quoted, with a backslash escape). */
export function callArguments(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote = '';
  let from = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(text.slice(from, i)); return args.map((a) => a.trim()).filter(Boolean); }
    } else if (c === ',' && depth === 1) { args.push(text.slice(from, i)); from = i + 1; }
  }
  return args.map((a) => a.trim()).filter(Boolean);
}

/** One code written as `expr`, listed: a literal is itself, a constant is its value, an f-string is its expansions.
 * What can't be listed comes back as the text itself, so the caller reports it. */
function resolve(expr: string, constants: ReadonlyMap<string, string>, expansions: Readonly<Record<string, readonly string[]>>): string[] {
  // A code taken from a table (NAMES.get(x), NAMES[x]) can't be listed from here: spell each code out where it is sent.
  if (/[([]$/.test(expr)) return [`${expr}... (a code looked up in a table)`];
  if (/^[A-Z]/.test(expr)) return [constants.get(expr) ?? `${expr} (a constant with no string value)`];
  const fString = expr.startsWith('f');
  const body = expr.replace(/^f/, '').slice(1, -1);
  if (!fString) return /^[a-z][a-z_0-9]*$/.test(body) ? [body] : [];
  let forms = [body];
  for (const placeholder of new Set(body.match(/\{[^{}]+\}/g) ?? [])) {
    const values = expansions[placeholder.slice(1, -1)];
    if (!values) return [expr];
    forms = forms.flatMap((form) => values.map((value) => form.split(placeholder).join(value)));
  }
  return forms;
}

/** Every error code a backend text can send in a chat error event. `constants` are the sources' module-level
 * string constants (a code can be defined in one module and sent from another); `expansions` list the values of the
 * placeholders an f-string code may hold. */
export function codesIn(
  text: string,
  personalAgentStatuses: readonly string[] = [],
  constants: ReadonlyMap<string, string> = constantsIn(text),
  expansions: Readonly<Record<string, readonly string[]>> = { 'view.status': personalAgentStatuses },
): Set<string> {
  const codes = new Set<string>();
  const add = (expr: string) => resolve(expr, constants, expansions).forEach((code) => codes.add(code));
  for (const m of text.matchAll(new RegExp(`["']code["']\\s*:\\s*${EXPR}`, 'g'))) add(m[1]);
  for (const m of text.matchAll(new RegExp(`\\bcode\\s*=\\s*${EXPR}`, 'g'))) add(m[1]);
  for (const m of text.matchAll(new RegExp(`${CLASSES}\\(\\s*${EXPR}`, 'g'))) add(m[1]);
  // PreflightRefusal(text, "code"): the code is the second argument; the text comes first. With no second argument the
  // class's own default applies (a constant named _CODE, read below).
  for (const m of text.matchAll(/\bPreflightRefusal\(/g)) {
    const second = callArguments(text, m.index + m[0].length - 1)[1];
    const written = second ? new RegExp(`^(?:code\\s*=\\s*)?${EXPR}$`).exec(second) : null;
    if (written) add(written[1]);
  }
  // start_refusal(getattr(refusal, "code", DEFAULT), text): the code an object carries, or DEFAULT when it has none.
  for (const m of text.matchAll(new RegExp(`getattr\\([^,()]+,\\s*["']code["']\\s*,\\s*${EXPR}`, 'g'))) add(m[1]);
  // A constant named for what it is: NAME_CODE = "x" is a code wherever it is sent from.
  for (const [name, code] of constants) if (name.endsWith('_CODE') && text.includes(name)) codes.add(code);
  // launch_spec: PersonalAgentError("personal_agent_<x>", ...) reaches the chat; the REST codes (invalid, conflict, not_found) do not.
  for (const m of text.matchAll(new RegExp(`PersonalAgentError\\(\\s*${EXPR}`, 'g'))) {
    for (const code of resolve(m[1], constants, expansions)) if (/^(?:f["'])?personal_agent_/.test(code)) codes.add(code);
  }
  return codes;
}

/** The codes `sources` can send that the chat line can't read. */
export function unreadCodes(sources: readonly { file: string; text: string }[], known: ReadonlySet<string>, statuses: readonly string[] = []): string[] {
  const unread: string[] = [];
  const constants = new Map(sources.flatMap(({ text }) => [...constantsIn(text)]));
  for (const { file, text } of sources) {
    for (const code of codesIn(file.endsWith('main.py') ? chatHandlerText(text) : text, statuses, constants)) {
      if (known.has(code) || STOP_CODES.has(code) || READ_ELSEWHERE.has(code) || NOT_AN_ERROR_EVENT.some(([pattern]) => pattern.test(code))) continue;
      unread.push(`${file}: ${code}`);
    }
  }
  return unread;
}

describe('every error code the chat handler can send is one the chat line reads', () => {
  const main = source('main.py');
  const modules = [...new Set(['services/chat_models.py', 'services/acp_session.py', 'services/personal_agents.py', ...errorModules(main.text), ...AGENT_RUNNER_MODULES])];
  const sources = [main, ...modules.map(source)];
  const statuses = /STATUSES = \(([^)]*)\)/.exec(sources.find((s) => s.file.endsWith('personal_agents.py'))!.text)![1]
    .split(',').map((s) => s.trim().replace(/["']/g, '')).filter((s) => s && s !== 'ready');

  it('reads the real sources', () => {
    expect(statuses).toEqual(['not_installed', 'needs_node', 'needs_setup', 'disabled']);
    const all = new Set(sources.flatMap(({ file, text }) => [...codesIn(file.endsWith('main.py') ? chatHandlerText(text) : text, statuses)]));
    for (const code of ['agent_invalid', 'provider_invalid', 'person_required', 'personal_session_ended', 'model_required', 'catalog_timeout',
      'auth_required', 'personal_agent_start_failed', 'personal_agent_needs_setup', 'personal_agent_disabled']) expect(all, code).toContain(code);
    // main.py is read inside the chat handler only: a code from another route is not in it.
    expect(all).not.toContain('version_conflict');
    // The codes sent through a keyword, a constant and a runner's own module (the start refusals) are read too.
    for (const code of ['agent_grant_overlap', 'agent_knowledge_unavailable', 'codex_features_refused', 'codex_chatgpt_required',
      'cli_not_installed', 'personal_agent_start_interrupted']) expect(all, code).toContain(code);
  });

  it('reads every module the chat handler imports an error class from', () => {
    expect(errorModules(main.text)).toEqual(expect.arrayContaining(['services/chat_models.py']));
    for (const file of errorModules(main.text)) expect(sources.map((s) => s.file), file).toContain(file);
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

  it('reads a code written as a keyword argument', () => {
    const kw = [{ file: 'services/fake_session.py', text: 'raise PersonalSessionError(code="kw_code", message="x")\nyield dict(type="error", code="dict_kw_code")' }];
    expect(unreadCodes(kw, WHOLE_LINE_CODES)).toEqual(['services/fake_session.py: kw_code', 'services/fake_session.py: dict_kw_code']);
  });

  it('reads a module-level constant, named _CODE or used where a code goes, also from another module', () => {
    const named = [{ file: 'services/fake_lines.py', text: 'QUOTA_CODE = "quota_used"\nLIMIT = "limit_reached"\nNOTE = "not_a_code"\nyield {"type": "error", "stop": "error", "message": QUOTA_CODE}' }];
    expect(unreadCodes(named, WHOLE_LINE_CODES)).toEqual(['services/fake_lines.py: quota_used']);
    const used = [
      { file: 'services/fake_lines.py', text: 'LIMIT = "limit_reached"\nNOTE = "not_a_code"' },
      { file: 'services/fake_session.py', text: 'raise PersonalSessionError(LIMIT, "x")\nsend({"type": "error", "code": LIMIT})\nstart_refusal(NO_SUCH, "x")' },
    ];
    expect(unreadCodes(used, WHOLE_LINE_CODES)).toEqual([
      'services/fake_session.py: limit_reached', 'services/fake_session.py: NO_SUCH (a constant with no string value)']);
    const table = [{ file: 'services/fake_session.py', text: 'CODES = {"a": "x_a"}\nraise PersonalSessionError(CODES.get(kind), "x")' }];
    expect(unreadCodes(table, WHOLE_LINE_CODES)).toHaveLength(1);
  });

  it('reads the second argument of PreflightRefusal(text, "code"), whatever the first holds', () => {
    const text = [
      'return PreflightRefusal(f"Codex, with a (comma), isn\'t ready ({names}). Update it.", "preflight_code_a")',
      'return PreflightRefusal("two lines "\n    "joined", code="preflight_code_b")',
      'return PreflightRefusal("no code given, so the class default applies")',
      'return PreflightRefusal(chat_refusal_message("cli_not_installed", "codex", ""), PREFLIGHT_NAMED)',
      'PREFLIGHT_NAMED = "preflight_code_c"',
    ].join('\n');
    expect([...codesIn(text)].sort()).toEqual(['preflight_code_a', 'preflight_code_b', 'preflight_code_c']);
    expect(unreadCodes([{ file: 'services/fake_session.py', text }], WHOLE_LINE_CODES).sort())
      .toEqual(['services/fake_session.py: preflight_code_a', 'services/fake_session.py: preflight_code_b', 'services/fake_session.py: preflight_code_c']);
  });

  it('reads the default of a getattr(x, "code", DEFAULT) given to start_refusal, however the constant is named', () => {
    const text = 'FEATURES = "features_default"\nyield start_refusal(getattr(refusal, "code", FEATURES), str(refusal))\nyield start_refusal(getattr(other, "code", "literal_default"), "x")';
    expect([...codesIn(text)].sort()).toEqual(['features_default', 'literal_default']);
    // Not a code: getattr of another attribute.
    expect([...codesIn('getattr(exc, "status_code", None)\nNAME = "not_a_code"')]).toEqual([]);
  });

  it('expands an f-string code with a known placeholder, and reports one with none', () => {
    const known = [{ file: 'services/fake_session.py', text: 'raise PersonalSessionError(f"personal_agent_{status}", "x")\n{"code": f"catalog_{view.status}"}' }];
    expect([...codesIn(known[0].text, [], new Map(), { status: ['gone', 'slow'], 'view.status': ['not_installed'] })].sort())
      .toEqual(['catalog_not_installed', 'personal_agent_gone', 'personal_agent_slow']);
    expect(unreadCodes(known, WHOLE_LINE_CODES, ['disabled'])).toEqual([
      'services/fake_session.py: catalog_disabled', 'services/fake_session.py: f"personal_agent_{status}"']);
  });

  it('names the modules a chat handler imports an error class from', () => {
    const main = [
      'from services.other import Thing, SomeError  # not in the handler',
      'async def chat_websocket(ws):',
      '    from services.new_thing import (NewThingError,',
      '                                    helper)',
      '    from services.plain import helper2',
      '    try:',
      '        pass',
      '    except NewThingError:',
      '        pass',
      '',
      '@app.get("/x")',
      'async def other():',
      '    pass',
    ].join('\n');
    expect(errorModules(main)).toEqual(['services/new_thing.py']);
  });
});
