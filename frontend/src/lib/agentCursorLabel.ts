/**
 * A cursor's label, the one string its name pill shows and the Agent log
 * names it by (GM - Design, PR #211 r19), so the two never disagree. Kept
 * apart from agentCursorLook so the log, loaded with the app, doesn't pull
 * in the cursor layer's geometry. Person UI only: agents never read it.
 */
import type { AgentPresenceSession } from './wsClient';

const SESSION_KEY = /^[0-9a-f]{12}$/;
const MAX_SESSION_ORDINAL = 100_000;

/** A session the backend gave, or null: anything malformed lands the event on
 *  the agent's own cursor. */
export function cleanSession(raw: unknown): AgentPresenceSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const session = raw as Record<string, unknown>;
  const { key, ordinal } = session;
  if (typeof key !== 'string' || !SESSION_KEY.test(key)) return null;
  if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_SESSION_ORDINAL) {
    return null;
  }
  return { key, ordinal };
}

/** A chat title in a cursor's name is cut to this many characters. */
export const AGENT_CURSOR_TITLE_CHARS = 20;

export interface SessionLike {
  ordinal: number;
}

/**
 * "Claude" for number 1, then "Claude · 2", "Claude · 3": the number the
 * backend gave, the lowest free among the agent's live sessions. This only
 * shows it and never numbers. A chat title, when Nebula has one for the
 * session, takes the number's place.
 */
/** The first `count` user-perceived characters (grapheme clusters), so a flag or an accent is never split. */
export function cutGraphemes(text: string, count: number): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return [...text].slice(0, count).join('');
  const parts: string[] = [];
  for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (parts.length === count) break;
    parts.push(segment);
  }
  return parts.join('');
}

export function sessionName(name: string, session: SessionLike | null, title?: string | null): string {
  const cut = title ? cutGraphemes(title.trim(), AGENT_CURSOR_TITLE_CHARS).trim() : '';
  if (cut) return `${name} · ${cut}`;
  if (!session || !Number.isInteger(session.ordinal) || session.ordinal < 2) return name;
  return `${name} · ${session.ordinal}`;
}

/** The label a cursor's pill shows, and the Agent log's name for its lines:
 *  "Pair" for number 1 or no session, then "Pair · 2", "Pair · 3". */
export function cursorLabel(name: string, session: SessionLike | null): string {
  return sessionName(name, session);
}
