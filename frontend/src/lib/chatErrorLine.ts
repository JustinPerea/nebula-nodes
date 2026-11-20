import { endedSentence } from './errorCopy';

/**
 * The chat's line for a stream error (design): "Claude stopped because the connection was refused."
 * There is no "Warning:" lead and no second colon. It is a because line, so it is drawn neutral
 * (isBecauseFailure, through LineText).
 *
 * The words come from the backend or the agent's own CLI. A line that is already a whole sentence
 * for the person (a backend refusal such as "Opus is no longer offered.", "Fake Agent exited (code
 * 3).") and anything Nebula itself sent (`source: "system"`, the codes below) reads as it is, with
 * its trailing colon form cleaned. A fragment (the CLI's stderr, "claude exited with code 1") is
 * the reason: a known one is worded here, an unknown one keeps its text, cleaned, after "because".
 * becauseLine() is not used: it opens with "Nebula couldn’t …", and design's line names the agent.
 */

/** Codes whose message the backend wrote as a whole line for the person. */
const WHOLE_LINE_CODES = new Set(['personal_session_ended', 'personal_agent_warning_required', 'model_unsupported',
  'effort_unsupported', 'model_required', 'auth_required', 'agent_invalid', 'provider_invalid']);

/** Known reasons, worded once. Tried on one short sentence. */
const KNOWN_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:ECONNREFUSED|connection refused)\b/i, 'the connection was refused'],
  [/\b(?:ECONNRESET|connection reset)\b/i, 'the connection was reset'],
  [/\b(?:ETIMEDOUT|timed out)\b/i, 'the connection timed out'],
  [/^`?(claude|codex)`? binary not found in PATH$/i, 'its command wasn’t found. Check that it is installed'],
];

const WHOLE_SENTENCE = /^[A-Z“"‘'`].*[.!?]$/s;

/** The text without its leading "Error:" and its trailing colon form ("connection refused:" or " :"). */
function cleaned(message: string): string {
  return message.replace(/\s+/g, ' ').trim().replace(/^(?:Error|error)\s*:\s*/, '').replace(/\s*:+$/, '').trim();
}

/** The first letter lower case, unless the first word is an acronym or has capitals of its own. */
function lowerFirst(text: string): string {
  const first = text.split(' ', 1)[0] ?? '';
  return !first || /[A-Z]/.test(first.slice(1)) || /^I[’']/.test(first) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

export function chatErrorLine({ message, code, source, agentName }: {
  message: string | undefined | null; code?: unknown; source?: unknown; agentName: string;
}): string {
  const text = cleaned(message ?? '');
  if (!text) return `${agentName} stopped because of an unknown error.`;
  if (source === 'system' || WHOLE_LINE_CODES.has(String(code))) return endedSentence(text);
  // A known reason is worded here when the text is one short sentence; a longer message is the agent's own words.
  const oneShort = text.length <= 120 && !/[.!?]\s/.test(text);
  const known = oneShort ? KNOWN_REASONS.find(([pattern]) => pattern.test(text)) : undefined;
  if (known) return `${agentName} stopped because ${endedSentence(known[1])}`;
  if (WHOLE_SENTENCE.test(text)) return endedSentence(text);
  const exited = /^(?:claude|codex) exited with (code \d+|subtype=\S+)$/i.exec(text);
  const reason = exited ? `it exited with ${exited[1]}` : lowerFirst(text);
  return `${agentName} stopped because ${endedSentence(reason)}`;
}
