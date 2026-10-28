/**
 * The money copy for the "+ unpriced" chip and its tooltip (GM - Design,
 * PR #198 r6 "FROM THE SHOTS" and r7 item 3), and the amount ceiling's
 * text (review 5, N4). One place, so GM can reword each line.
 *
 * Tooltip rules (r7): no colons; one sentence per reason, each ending with a
 * period; the known part first. `names` is already a nodeNameList
 * ("“A”", "“A” and “B”", "4 nodes"), and `several` says whether it names
 * more than one node (namesSeveral).
 *
 * Lines marked PLACEHOLDER aren't GM's words yet.
 */

/** After the chip's figure when part of the run has no known price:
 * "Up to $0.43 + unpriced" (GM r6). */
export const UNPRICED_SUFFIX = ' + unpriced';

/** The tooltip's first sentence: what the priced part costs (GM r7). */
export const PRICED_PART = {
  upTo: (amount: string) => `The priced part of this run costs up to ${amount}.`,
  range: (low: string, high: string) => `The priced part of this run costs between ${low} and ${high}.`,
  exact: (amount: string) => `The priced part of this run costs about ${amount}.`,
  under: 'The priced part of this run costs under $0.01.',
  /** PLACEHOLDER: the priced nodes add up to nothing. */
  free: 'The priced part of this run is free.',
  /** PLACEHOLDER: the priced part is past the ceiling (review 5, N4). */
  over: (amount: string) => `The priced part of this run costs more than ${amount}.`,
};

/** A closed chip past the ceiling: its tooltip. PLACEHOLDER. */
export const OVER_TITLE = (amount: string) => `More than ${amount}.`;

type Line = (names: string, several: boolean) => string;

/** No list price for these settings (GM r7). */
export const NO_LISTED_PRICE: Line = (names, several) => `${names} ${several ? 'have' : 'has'} no listed price.`;

/** The chosen route's key isn't set. `key` is the key as the node's own
 * route line names it ("fal.ai API key", "Black Forest Labs or fal.ai API
 * key"; directRoute.keyPhrase), so the two agree (GM r7). The plural is a
 * PLACEHOLDER. */
export const MISSING_KEY = (names: string, several: boolean, key: string) => (several
  ? `${names} can't be priced until their ${key} is added.`
  : `${names} can't be priced until its ${key} is added.`);

/** A missing key that has no name Settings knows. PLACEHOLDER. */
export const MISSING_KEY_UNNAMED = 'provider key';

/** The chosen route can't take the run for another reason (a setting it
 * doesn't take, a retired model, an unknown provider). PLACEHOLDER. */
export const ROUTE_CANT_RUN: Line = (names, several) => (several
  ? `${names} can't be priced because they can't run on their chosen providers.`
  : `${names} can't be priced because it can't run on its chosen provider.`);

/** Priced from its input file's size, not known yet (GM r7). The plural is
 * a PLACEHOLDER. */
export const AWAITING_INPUT: Line = (names, several) => (several
  ? `${names} are priced from their inputs, which aren't ready yet.`
  : `${names} is priced from its input, which isn't ready yet.`);

/** Priced from its input file's size, which the backend can't read (a file
 * on another host, never downloaded to price it). PLACEHOLDER. */
export const SIZE_UNREADABLE: Line = (names, several) => (several
  ? `${names} are priced from their inputs' sizes, which Nebula can't read.`
  : `${names} is priced from its input's size, which Nebula can't read.`);

/** A cost a priced node's estimate leaves out (its price entry's `plus`).
 * GM r7 asks for the actual cost by name; the table's values today are
 * "input images", "thinking tokens" and "input media and thinking tokens".
 * Each maps to the neutral line until GM words it. PLACEHOLDER. */
const LEFT_OUT_NEUTRAL: Line = (names) => `${names} may add costs the estimate doesn't include.`;
export const LEFT_OUT: Readonly<Record<string, Line>> = {
  'input images': LEFT_OUT_NEUTRAL,
  'thinking tokens': LEFT_OUT_NEUTRAL,
  'input media and thinking tokens': LEFT_OUT_NEUTRAL,
};
export const LEFT_OUT_OTHER: Line = LEFT_OUT_NEUTRAL;

/** Amounts above this read as more than it, on both sides (review 5, N4;
 * backend services/money.py CEILING_USD). */
export const CEILING_USD = 1e13;
export const OVER_CEILING_USD = '>$10,000,000,000,000';
export const OVER_CEILING_SPENT_USD = '>$10,000,000,000,000.00';
/** The ceiling as a chip's figure, for "more than" lines. */
export const CEILING_FIGURE = '$10,000,000,000,000';
