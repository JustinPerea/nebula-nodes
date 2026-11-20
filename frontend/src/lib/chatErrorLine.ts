import { endedSentence, curlApostrophes } from './errorCopy';
import { PROVIDER_LABELS } from './directRoute';

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
 * because its command failed." with the raw text behind the line's Details. A fragment joins "because" only when it opens with a subject (a name, a pronoun, a determiner); any other fragment is a sentence of its own: "Claude stopped. Couldn’t read the file." becauseLine() is not used: it opens with "Nebula couldn’t …", and design's line names the agent.
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

/** The provider names the app shows (directRoute.PROVIDER_LABELS), except the local-tools stand-in, which is not a name. */
const PROVIDER_NAMES: readonly string[] = Object.entries(PROVIDER_LABELS).filter(([key]) => key !== 'utility').map(([, label]) => label);

/** The provider names that are also ordinary English verbs: "Replicate it again", "Google the error". Only these
 * can open a reason as a word instead of a name; every other provider's name is a name whatever follows it
 * ("Krea this morning failed" is about Krea). The rest of PROVIDER_NAMES (OpenAI, Anthropic, Runway, Kling,
 * ElevenLabs, ByteDance, MiniMax, Luma, xAI, Recraft, Ideogram, OpenRouter, Black Forest Labs, Higgsfield,
 * Meshy, QuiverAI, Krea, World Labs, Nous, TypeSafe, Speridlabs, Hugging Face, fal.ai) are not verbs. */
const VERB_PROVIDERS = new Set(['Replicate', 'Google']);

/** What follows a verb provider's label when it is used as the verb ("Replicate the prompt"), not as a name. */
const NOT_A_NAME_AFTER = /^\s+(?:the|a|an|this|that|these|those|your|my|it|them)(?![\w-])/i;

/** The provider label (as the app spells it) the text opens with, alone or as a possessive ("Krea’s reader"), compared
 * without case. Null when none does, or when a verb provider's label is followed by a determiner or pronoun: then it is a word, not a name. */
function openingProviderLabel(text: string): string | null {
  const lower = text.toLowerCase();
  for (const label of [...PROVIDER_NAMES].sort((a, b) => b.length - a.length)) {
    const own = label.toLowerCase();
    if (!lower.startsWith(own)) continue;
    const after = text.slice(own.length);
    if (after !== '' && !/^(?:[’']s)?(?![\w-])/.test(after)) continue;
    return VERB_PROVIDERS.has(label) && NOT_A_NAME_AFTER.test(after) ? null : label;
  }
  return null;
}

/** True when the text opens with the agent's own name (or its command's), alone or as a possessive, compared without case. */
function opensWithAgentName(text: string, names: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return names.some((name) => {
    const own = name.toLowerCase();
    return own !== '' && lower.startsWith(own) && /^(?:[’']s)?(?![\w-])/.test(lower.slice(own.length));
  });
}

/** The first letter lower case, unless the first word is a name (a provider or an agent, also as "Krea’s"), an acronym or has capitals of its own.
 * A provider's name is written as the app writes it ("Fal.ai" gives "fal.ai", "Hugging face" gives "Hugging Face"); a label used as a word
 * ("Replicate the prompt") is lower-cased like any other. */
function lowerFirst(text: string, names: readonly string[]): string {
  const first = (text.split(' ', 1)[0] ?? '').replace(/[,;:]+$/, '');
  const label = openingProviderLabel(text);
  if (label !== null) return label + text.slice(label.length);
  const kept = KEPT_WORDS.has(first.toLowerCase()) || names.some((name) => name.toLowerCase().split(' ')[0] === first.toLowerCase())
    || opensWithAgentName(text, names);
  return !first || kept || /[A-Z]/.test(first.slice(1)) || /^I(?:[’'].*)?$/.test(first) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** Pronouns and determiners that open a subject ("It isn’t there", "The file is gone", "Its host is down"), also as a contraction. */
const SUBJECT_WORD = /^(?:I|You|He|She|It|We|They|The|A|An|This|That|Your|Its|Their)(?:[’'](?:m|d|ll|s|re|ve))?(?![\w/-])/i;

/** True when the reason opens with a subject (design): a provider or agent name, also as a possessive ("Krea’s reader"),
 * a pronoun or one of the determiners above. Anything else ("Couldn’t read …", "No key", "Missing file") is not one. */
function opensWithSubject(text: string, names: readonly string[]): boolean {
  return openingProviderLabel(text) !== null || opensWithAgentName(text, names) || SUBJECT_WORD.test(text);
}

/** A whole line starts with a capital, unless its first word is an identifier ("claude_cli", "v2.0"): a plain lower-case word is capitalised. */
function upperFirst(text: string): string {
  const first = (text.split(' ', 1)[0] ?? '').replace(/[,;:]+$/, '');
  return /^[a-z][a-z’']*$/.test(first) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** The agent's own name (the chat's, or its command's) and a colon off the front of a fragment. A possessive ("Atlas’s host") is a name used in the reason, so it stays. */
function withoutAgentName(text: string, names: readonly string[]): string {
  const escaped = [...names].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const lead = new RegExp(`^(?:${escaped.join('|')})(?![\\w-])(?![’']s(?![\\w-]))\\s*[:\\-–—]?\\s*`, 'i');
  // A capital word right after the name, with no separator, is more of a name ("Claude Code crashed" for an agent
  // called Claude): the name stays and the reason opens with it.
  const match = lead.exec(text);
  if (match && !/[:\-–—]/.test(match[0]) && /^\p{Lu}/u.test(text.slice(match[0].length))) return text.trim();
  return text.replace(lead, '').trim();
}

/** True when the text opens with the agent's own name as its subject ("Claude hit a rate limit"): the name, a space and
 * a lower-case word. A label separator (":", "-", "–", "—") is a log prefix ("codex: out of credits"), and a capital
 * after the name is more of a name ("Claude Code crashed" for an agent called Claude), so neither is a subject. */
function agentIsSubject(text: string, names: readonly string[]): boolean {
  const escaped = [...names].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const lead = new RegExp(`^(?:${escaped.join('|')})\\s+`, 'i').exec(text);
  return lead !== null && /^\p{Ll}/u.test(text.slice(lead[0].length));
}

export type ChatErrorLine = {
  text: string;
  /** The line is in a "stopped because" form: drawn neutral (LineText tone="because"). Both of design's forms count:
   * "<Agent> stopped because …" and the same line as two sentences, "<Agent> stopped. <Reason>." */
  because: boolean;
  /** The raw message, for the Details disclosure, when the line is a short stand-in for it. */
  details?: string;
};

export function chatErrorLine({ message, code, source, agentName: given }: {
  message: string | undefined | null; code?: unknown; source?: unknown; agentName: string;
}): ChatErrorLine {
  // An agent with no name is "Your agent", as the chat panel calls it.
  const agentName = given.trim() || 'Your agent';
  const raw = (message ?? '').trim();
  const text = cleaned(raw);
  const because = (reason: string): ChatErrorLine => ({ text: `${agentName} stopped because ${curlApostrophes(endedSentence(reason))}`, because: true });
  if (!text) return because('of an unknown error');
  const whole = (line: string): ChatErrorLine => ({ text: curlApostrophes(endedSentence(upperFirst(line))), because: false });
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
  // The agent's own name was the subject ("Claude hit a rate limit"): it is "it", as in "it exited with code 1".
  if (agentIsSubject(text, names)) return because(`it ${lowerFirst(rest, names)}`);
  // A reason that opens with a subject joins the agent's name with "because"; any other reads as a sentence of its own.
  if (opensWithSubject(rest, names)) return because(lowerFirst(rest, names));
  return { text: `${agentName} stopped. ${curlApostrophes(endedSentence(upperFirst(rest)))}`, because: true };
}

/** The agent's status hover: the CLI's own message (prose, curled where it shows) and the session (a name, kept as it is). */
export function agentStatusTitle(message: string | null | undefined, sessionTitle: string | null | undefined): string | undefined {
  return [message ? curlApostrophes(message) : message, sessionTitle].filter(Boolean).join(' · ') || undefined;
}

