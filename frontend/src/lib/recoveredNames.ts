/**
 * The tab's side of Nebula's copy names (PR #199: GM r23 a, r25 5, r27 2,
 * r29 2), by the backend's rule (services/project_store). Nebula never reads
 * a number in someone else's name; the only number it raises is its own
 * "copy N":
 * - a recovered copy starts from "Recovered <name>" and takes it when it's
 *   free ("Shot" gives "Recovered Shot" even beside "Recovered Shot 7", a
 *   different name); when it's taken, " copy", then " copy 2", " copy 3";
 * - a name that already starts with "Recovered " (Nebula's word) starts from
 *   itself, never a second "Recovered";
 * - a duplicate is "<name> copy", then "<name> copy 2";
 * - a name ending in Nebula's " copy" or " copy N" goes on from that number
 *   ("Recovered Alpha copy 2" gives "Recovered Alpha copy 3");
 * - a canvas filed when its project isn't known is "Recovered canvas", then
 *   "Recovered canvas 2" (Nebula's own count, no name read); a project that
 *   happens to be named "Recovered canvas" is recovered as any other name
 *   starting with "Recovered ".
 * Names from before the rule ("Delta (recovered)", "Delta (recovered 2)")
 * start from "Recovered Delta"; their number is never read. Every name fits
 * NAME_LIMIT code points: a long name is cut at its end, so "Recovered " in
 * front and " copy N" behind stay whole. The cases both sides test:
 * backend/tests/data/copy_name_cases.json.
 */
const RECOVERED_CANVAS = 'Recovered canvas';
/** Nebula's own " copy" / " copy N" at the end of a name (N from 2). The
 * "s" flag, as DOTALL on the backend: "." takes U+2028, U+2029 and every
 * other character a name can hold. Digits are ASCII only. */
const NEBULA_COPY = /^(.+?) copy(?: ([2-9]|[1-9][0-9]+))?$/su;
const LEGACY_RECOVERED = /^(.+?) \(recovered(?: [0-9]+)?\)$/su;
/** The longest project name, in code points (Python's len on the backend,
 * never UTF-16 units). */
export const NAME_LIMIT = 120;

const points = (text: string) => Array.from(text);
/** The spaces a cut leaves at the end of a stem, which go: the backend's
 * CUT_SPACES (every character its strip() removes that a name can hold). */
export const CUT_SPACES = new Set(['\u0020', '\u0085', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
  '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000']);
function trimEnd(chars: string[]): string {
  let end = chars.length;
  while (end > 0 && CUT_SPACES.has(chars[end - 1])) end -= 1;
  return chars.slice(0, end).join('');
}

/** `stem` then `suffix`, the stem cut short so the whole name fits
 * NAME_LIMIT code points; the spaces (CUT_SPACES) the cut leaves at the end
 * of the stem go.
 * The suffix is never cut. */
function fit(stem: string, suffix = ''): string {
  const stemPoints = points(stem);
  const room = NAME_LIMIT - points(suffix).length;
  if (stemPoints.length <= room) return stem + suffix;
  return trimEnd(stemPoints.slice(0, room)) + suffix;
}

const copyForm = (stem: string, n: number) => fit(stem, n === 1 ? ' copy' : ` copy ${n}`);

/** The lowest free copy name of `name`: above its own copy number when it
 * is a copy Nebula named, else " copy", " copy 2", … */
function copyOf(name: string, names: Set<string>): string {
  const copy = NEBULA_COPY.exec(name);
  const stem = copy ? copy[1] : name;
  let n = (copy ? (copy[2] ? Number(copy[2]) : 1) : 0) + 1;
  while (names.has(copyForm(stem, n))) n += 1;
  return copyForm(stem, n);
}

/** `start` when it's free, else its lowest free copy name. */
const firstFree = (start: string, names: Set<string>) => (names.has(start) ? copyOf(start, names) : start);

/** A recovered copy's name. `taken`: the names in use (the project list,
 * Recently deleted, and names promised to copies not filed yet). */
export function recoveredCopyFallbackName(sourceName: string, taken: Iterable<string> = []): string {
  // As Nebula's recovered_name: only the names in use are taken. A source
  // still in the list is one of them; a source the list lost (a kept canvas
  // after a restore) is free, so "Recovered Alpha copy 2" keeps its name.
  const names = new Set(taken);
  const legacy = LEGACY_RECOVERED.exec(sourceName);
  // An old form's stem can end in spaces ("Alpha  (recovered)"): they go, as at a cut.
  const name = legacy ? trimEnd(points(legacy[1])) : sourceName;
  const start = name === 'Recovered' || name.startsWith('Recovered ') ? name : fit(`Recovered ${name}`);
  return firstFree(start, names);
}

/** A duplicate's name: "<name> copy", then the next free copy number. */
export function duplicateName(sourceName: string, taken: Iterable<string> = []): string {
  return copyOf(sourceName, new Set([...taken, sourceName]));
}

/** A canvas's copy when its project isn't known: "Recovered canvas", then the lowest free number. */
export function recoveredCanvasName(taken: Iterable<string> = []): string {
  const names = new Set(taken);
  if (!names.has(RECOVERED_CANVAS)) return RECOVERED_CANVAS;
  let n = 2;
  while (names.has(`${RECOVERED_CANVAS} ${n}`)) n += 1;
  return `${RECOVERED_CANVAS} ${n}`;
}
