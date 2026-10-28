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
 * GM's words (r8) unless marked: the builder's plurals of GM's singular
 * lines are marked "Builder's plural", and lines still awaiting GM are
 * marked PLACEHOLDER.
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
  /** The priced nodes add up to nothing: no line (GM r8: "$0 is a price,
   * not unpriced"), so the tooltip starts with the reasons. */
  free: '',
  /** PLACEHOLDER: the priced part is past the ceiling (review 5, N4). GM r8
   * worded "“X” may cost more than $Y." for a price cap; the ceiling is
   * Nebula's display limit ($10 trillion), not a cap, so it waits for GM. */
  over: (amount: string) => `The priced part of this run costs more than ${amount}.`,
};

/** A closed chip past the ceiling: its tooltip. PLACEHOLDER. */
export const OVER_TITLE = (amount: string) => `More than ${amount}.`;

type Line = (names: string, several: boolean) => string;

/** No list price for these settings (GM r7). */
export const NO_LISTED_PRICE: Line = (names, several) => `${names} ${several ? 'have' : 'has'} no listed price.`;

/** The chosen route's key isn't set. `key` is the key as the node's own
 * route line names it ("fal.ai API key", "Black Forest Labs or fal.ai API
 * key"; directRoute.keyPhrase), so the two agree (GM r7; the plural, GM r8). */
export const MISSING_KEY = (names: string, several: boolean, key: string) => (several
  ? `${names} can't be priced until their ${key} is added.`
  : `${names} can't be priced until its ${key} is added.`);

/** A missing key that has no name Settings knows (GM r8): "“X” can't be
 * priced until its API key is added." */
export const MISSING_KEY_UNNAMED = 'API key';

/** The chosen route can't take the run for another reason (a setting it
 * doesn't take, a retired model, an unknown provider). GM r8; the plural is
 * the builder's. */
export const ROUTE_CANT_RUN: Line = (names, several) => (several
  ? `${names} can't run as they're set up now, so they have no price.`
  : `${names} can't run as it's set up now, so it has no price.`);

/** Priced from its input file's size, not known yet (GM r7; the plural, GM r8). */
export const AWAITING_INPUT: Line = (names, several) => (several
  ? `${names} are priced from their inputs, which aren't ready yet.`
  : `${names} is priced from its input, which isn't ready yet.`);

/** Priced from its input file's size, which the backend can't read (a file
 * on another host, never downloaded to price it). GM r8; the plural is the
 * builder's. */
export const SIZE_UNREADABLE: Line = (names, several) => (several
  ? `${names} are priced by their input sizes, which Nebula couldn't read.`
  : `${names} is priced by its input size, which Nebula couldn't read.`);

/** A cost a priced node's estimate leaves out (its price entry's `plus`),
 * by name (GM r8): "“X” may cost more for its input images, which the
 * estimate leaves out." The table's values today are "input images",
 * "thinking tokens" and "input media and thinking tokens"; the plurals
 * ("their", "the models'") are the builder's. Nodes sharing one group with
 * the name helper (runScope reasonSentences). */
const leftOut = (one: string, several: string): Line => (names, many) =>
  `${names} may cost more for ${many ? several : one}, which the estimate leaves out.`;
export const LEFT_OUT: Readonly<Record<string, Line>> = {
  'input images': leftOut('its input images', 'their input images'),
  'thinking tokens': leftOut("the model's thinking", "the models' thinking"),
  'input media and thinking tokens': leftOut("its input media and the model's thinking", "their input media and the models' thinking"),
};
/** A `plus` the table adds later, until GM words it: named as the table
 * names it. PLACEHOLDER. */
export const LEFT_OUT_OTHER = (plus: string): Line => leftOut(`its ${plus}`, `their ${plus}`);

/** Amounts above this read as more than it, on both sides (review 5, N4;
 * backend services/money.py CEILING_USD). */
export const CEILING_USD = 1e13;
export const OVER_CEILING_USD = '>$10,000,000,000,000';
export const OVER_CEILING_SPENT_USD = '>$10,000,000,000,000.00';
/** The ceiling as a chip's figure, for "more than" lines. */
export const CEILING_FIGURE = '$10,000,000,000,000';
