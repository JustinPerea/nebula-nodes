/** agent_spend.MAX_DAILY_TOTAL_USD: the most a daily total may be. The
 * backend reads a saved total above it as unreadable (the $5 default), so the
 * Settings store and the typed field both stop here. Its own module, with no
 * imports, so the settings store can read it without pulling in pricing. */
export const MAX_DAILY_TOTAL_USD = 100_000;
