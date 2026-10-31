/**
 * The daily total: what everything that isn't the person (agent chats,
 * agents outside Nebula, scripts, tabs not opened from the link) may spend
 * together over the last 24 hours (Justin decided, 2026-10-31; backend
 * services/agent_spend.py DAILY_TOTAL_KEY). Unset is $5; the person's
 * "No limit" is an explicit null. Lines are GM - Design's (2026-10-31),
 * verbatim.
 */
import { formatSpentUsd } from './pricing';

/** agent_spend.DEFAULT_DAILY_TOTAL_USD. */
export const DEFAULT_DAILY_TOTAL_USD = 5;
/** The select's amounts, per day (GM). */
export const DAILY_TOTAL_CHOICES = [1, 2, 5, 10, 20, 50] as const;

/** A limit the person picked: "$5", "$7.50", "$0.50" (agent_spend.limit_usd). */
export function limitUsd(amount: number): string {
  const cents = Math.floor(amount * 100 + 0.5);
  const dollars = Math.floor(cents / 100).toLocaleString('en-US');
  return cents % 100 === 0 ? `$${dollars}` : `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
}

/** The saved total: undefined (never picked) is the default, null is no limit. */
export function dailyLimit(saved: number | null | undefined): number | null {
  return saved === undefined ? DEFAULT_DAILY_TOTAL_USD : saved;
}

/** The usage line under the row's description (GM, verbatim). */
export function dailyUsageLine(spent: number, limit: number | null): string {
  if (!(spent > 0)) return 'Nothing spent in the last 24 hours.';
  if (limit === null) return `${formatSpentUsd(spent)} spent in the last 24 hours.`;
  const used = `${formatSpentUsd(spent)} of ${limitUsd(limit)} used in the last 24 hours.`;
  return spent >= limit ? `${used} New runs wait for your OK.` : used;
}

/** The thin meter shows only with a limit and something spent (GM). */
export function dailyMeterShown(spent: number, limit: number | null): limit is number {
  return limit !== null && spent > 0;
}

/** A typed amount the field saves: a positive dollar figure, at most to the cent. */
export function parseDailyAmount(text: string): number | null {
  const trimmed = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}
