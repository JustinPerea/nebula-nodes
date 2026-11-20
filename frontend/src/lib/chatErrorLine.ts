import { endedSentence } from './errorCopy';

/**
 * The chat's line for a stream error (design): "Claude stopped because the connection was refused."
 * There is no "Warning:" lead and no second colon. It is a because line, so it is drawn neutral
 * (the line says so itself: `because`, passed to LineText as tone="because").
 *
 * The words come from the backend or the agent's own CLI. A line that is already a whole sentence
 * for the person (a backend refusal such as "Opus is no longer offered.", "Fake Agent exited (code
 * 3).") and anything Nebula itself sent (`source: "system"`, the codes below) reads as it is, with
 * its trailing colon form cleaned. A fragment (the CLI's stderr, "claude exited with code 1") is
 * the reason: a known one is worded here, an unknown one keeps its text, cleaned, after "because".
 * A single line of whole sentences (capital to . ! or ?) reads as it is at any length: a long refusal
 * written for the person keeps its reason and its fix in view, drawn with the error tone. A message with
 * line breaks, or a long line that is not whole sentences (a stack trace, a long stderr), reads "<Agent> stopped
 * because its command failed." with the raw text behind the line's Details. becauseLine() is not used: it opens with "Nebula couldn’t …", and design's line names the agent.
 */

/** Codes whose message the backend wrote as a whole line for the person. */
const WHOLE_LINE_CODES = new Set(['personal_session_ended', 'personal_agent_warning_required', 'model_unsupported',
  'effort_unsupported', 'model_required', 'auth_required', 'agent_invalid', 'provider_invalid']);

/** Connection faults, worded once. Only a connection-shaped message (an errno or "connection refused"), never any "timed out". */
const KNOWN_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:ECONNREFUSED|connection (?:was )?refused)\b/i, 'the connection was refused'],
  [/\b(?:ECONNRESET|connection (?:was )?reset|socket hang up)\b/i, 'the connection was reset'],
  [/\b(?:ETIMEDOUT|connection (?:timed out|timeout))\b/i, 'the connection timed out'],
  [/^`?(claude|codex)`? binary not found in PATH$/i, 'its command wasn’t found. Check that it is installed'],
];

const WHOLE_SENTENCE = /^[A-Z“"‘'`].*[.!?]$/s;
/** Words that keep their capital in the middle of a line. */
const KEPT_WORDS = new Set(['claude', 'codex', 'gemini', 'nebula', 'cli', 'mcp', 'api', 'json']);
/** What is left of "Codex turn failed" once the name goes: no reason of its own. */
const EMPTY_REASON = /^(turn|request|run|command|session)(?: has)? (?:failed|errored|error)$|^(?:failed|error|errored)$/i;

/** A fragment's subject that is the agent's own work: "Command timed out after 120s" reads "its command timed out after 120s". */
const OWN_SUBJECT = /^(?:command|process|turn|request)\b/i;

/** The text without its leading "Error:" and its trailing colon form ("connection refused:" or " :"). */
function cleaned(message: string): string {
  return message.replace(/\s+/g, ' ').trim().replace(/^error\s*:\s*/i, '').replace(/\s*:+$/, '').trim();
}

/** The first letter lower case, unless the first word is a name, an acronym or has capitals of its own. */
function lowerFirst(text: string, names: readonly string[]): string {
  const first = (text.split(' ', 1)[0] ?? '').replace(/[,;:]+$/, '');
  const kept = KEPT_WORDS.has(first.toLowerCase()) || names.some((name) => name.toLowerCase().split(' ')[0] === first.toLowerCase());
  return !first || kept || /[A-Z]/.test(first.slice(1)) || /^I[’']/.test(first) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** A whole line starts with a capital, unless its first word is an identifier ("claude_cli", "v2.0"): a plain lower-case word is capitalised. */
function upperFirst(text: string): string {
  const first = (text.split(' ', 1)[0] ?? '').replace(/[,;:]+$/, '');
  return /^[a-z][a-z’']*$/.test(first) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** The agent's own name (the chat's, or its command's) and a colon off the front of a fragment. */
function withoutAgentName(text: string, names: readonly string[]): string {
  const escaped = [...names].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const lead = new RegExp(`^(?:${escaped.join('|')})(?![\\w-])\\s*[:\\-–—]?\\s*`, 'i');
  return text.replace(lead, '').trim();
}

export type ChatErrorLine = {
  text: string;
  /** The line is in the "<Agent> stopped because …" form: drawn neutral (LineText tone="because"). */
  because: boolean;
  /** The raw message, for the Details disclosure, when the line is a short stand-in for it. */
  details?: string;
};

export function chatErrorLine({ message, code, source, agentName }: {
  message: string | undefined | null; code?: unknown; source?: unknown; agentName: string;
}): ChatErrorLine {
  const raw = (message ?? '').trim();
  const text = cleaned(raw);
  const because = (reason: string): ChatErrorLine => ({ text: `${agentName} stopped because ${endedSentence(reason)}`, because: true });
  if (!text) return because('of an unknown error');
  const whole = (line: string): ChatErrorLine => ({ text: endedSentence(upperFirst(line)), because: false });
  if (source === 'system' || WHOLE_LINE_CODES.has(String(code))) return whole(text);
  const stands = () => ({ ...because('its command failed'), details: raw });
  if (/\n/.test(raw)) return stands();
  // A known reason is worded here when the text is one short sentence; a longer message is the agent's own words.
  const oneShort = text.length <= 120 && !/[.!?]\s/.test(text);
  const known = oneShort ? KNOWN_REASONS.find(([pattern]) => pattern.test(text)) : undefined;
  if (known) return because(known[1]);
  // One line of whole sentences written for the person reads as it is, whatever its length. Only a
  // long line that is not (a raw CLI dump) gives way to the short line with its Details.
  if (WHOLE_SENTENCE.test(text)) return whole(text);
  if (raw.length > 200) return stands();
  const names = [agentName, 'claude', 'codex'];
  const exited = /^(?:claude|codex) exited with (code \d+|subtype=\S+)$/i.exec(text);
  if (exited) return because(`it exited with ${exited[1]}`);
  const rest = withoutAgentName(text, names);
  const bare = EMPTY_REASON.exec(rest);
  if (!rest || bare) return because(`its ${bare?.[1]?.toLowerCase() ?? 'turn'} failed`);
  // A fragment whose subject is the agent's own command, process, turn or request takes "its".
  if (OWN_SUBJECT.test(rest)) return because(`its ${lowerFirst(rest, names)}`);
  return because(lowerFirst(rest, names));
}
