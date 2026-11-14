/**
 * The hold after the spend record was found unreadable (review of PR #242): for 24 hours every
 * agent spending limit counts as used up. The backend sends when it ends (`until`, epoch
 * seconds); the lines here are GM - Design's, verbatim, and the live form is drawn by the app so it
 * goes the moment the hold does.
 */

/** The start of the sentence the backend writes (agent_spend.LEDGER_UNREADABLE minus its time),
 * with the curly apostrophe. A backend test reads it from this file. */
export const LEDGER_HOLD_SENTENCE = 'Nebula couldn’t read its record of what agents have spent, so it counts every spending limit as used up until';

/** What Settings says while the spend record can't be opened at all (backend agent_spend.LEDGER_CANT_READ,
 * pinned by a backend test): not the hold, so no end time; every row then reads "Amount unknown". */
export const LEDGER_CANT_READ = 'Nebula can’t open its record of what agents have spent, so agents can’t start paid runs until it can.';

/** A limit row's usage figure while the hold is on. */
export const COUNTED_AS_USED_UP = 'Counted as used up';

/** The figure of a row set to "No limit" while the hold is on: what the record counts then covers
 * only the time since it was found unreadable, so there is no true amount to show (GM - Design). */
export const AMOUNT_UNKNOWN = 'Amount unknown';

/** A row's usage figure during the hold: used up where it has a limit, unknown where it has none. */
export function holdFigure(hasLimit: boolean): string {
  return hasLimit ? COUNTED_AS_USED_UP : AMOUNT_UNKNOWN;
}

/** The same two inside a paragraph (the outside agents' help), as full sentences (GM - Design). */
export function holdSentence(hasLimit: boolean): string {
  return hasLimit ? 'This limit is counted as used up.' : 'The amount spent isn’t known.';
}

/** The hold as the backend sends it. */
export interface LedgerHold {
  until: number;
}

/** A proposal's wait details: the backend's sentence as well (weekday form, for lines written once). */
export interface ProposalLedgerHold extends LedgerHold {
  line: string;
}

/** Whether the hold is still on at `now` (ms). A missing or unreadable `until` is no hold. */
export function holdOn(hold: Pick<LedgerHold, 'until'> | null | undefined, now: number): boolean {
  const until = hold?.until;
  return typeof until === 'number' && Number.isFinite(until) && now < until * 1000;
}

/** "3:40 PM", "12:00 AM": the computer's local time, 12-hour, no leading zero. */
export function clockLabel(at: Date): string {
  const hours = at.getHours();
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** The live sentence for Settings: "… until 3:40 PM." when it ends today, "… until 3:40 PM tomorrow."
 * otherwise; null once `now` (ms) is at or past the end. */
export function ledgerHoldLine(hold: Pick<LedgerHold, 'until'> | null | undefined, now: number): string | null {
  if (!hold || !holdOn(hold, now)) return null;
  const end = new Date(hold.until * 1000);
  const today = new Date(now);
  const sameDay = end.getFullYear() === today.getFullYear() && end.getMonth() === today.getMonth()
    && end.getDate() === today.getDate();
  return `${LEDGER_HOLD_SENTENCE} ${clockLabel(end)}${sameDay ? '' : ' tomorrow'}.`;
}

/** A proposal's sentence while its hold is on: what the backend wrote, or null. */
export function proposalHoldLine(hold: Partial<ProposalLedgerHold> | null | undefined, now: number): string | null {
  if (!hold || typeof hold.line !== 'string' || hold.line === '') return null;
  return holdOn(hold as LedgerHold, now) ? hold.line : null;
}

/** `text`, then the hold's line after one space while it is on. */
export function withHoldLine(text: string, line: string | null): string {
  return line ? `${text} ${line}` : text;
}
