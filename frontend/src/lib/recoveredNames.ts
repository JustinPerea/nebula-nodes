/**
 * The tab's side of Nebula's copy names (PR #199: GM r23 a, r25 5, r27 2),
 * by the backend's rule (services/project_store: family_name,
 * recovered_name, duplicate_name, recovered_canvas_name), one family at a
 * time:
 * - copy: "Alpha copy", then "Alpha copy 2"; a copy's copy raises its
 *   number ("Recovered Alpha copy 2" gives "Recovered Alpha copy 3");
 * - recovered: "Recovered Delta", then "Recovered Delta 2"; a recovered
 *   copy's copy takes the next number, never a second "Recovered";
 * - canvas: "Recovered canvas", then "Recovered canvas 2" (a canvas's copy,
 *   not a project's).
 * A name's own number is part of its name, and Nebula numbers only after
 * "copy" there: "Shot 7" is recovered as "Recovered Shot 7 copy", then
 * "Recovered Shot 7 copy 2". Names from before the rule ("Delta
 * (recovered)") still belong to the recovered family. The cases both sides
 * test are backend/tests/data/copy_name_cases.json.
 */
type Family = 'canvas' | 'recovered' | 'copy';

const NUMBER = '(?: ([2-9]|[1-9][0-9]+))?';
const RECOVERED_CANVAS = 'Recovered canvas';
const FAMILIES: Record<Family, { re: RegExp; form: (stem: string, n: number) => string }> = {
  canvas: { re: new RegExp(`^(${RECOVERED_CANVAS})${NUMBER}$`), form: (stem, n) => (n === 1 ? stem : `${stem} ${n}`) },
  recovered: { re: new RegExp(`^Recovered (.+?)${NUMBER}$`), form: (stem, n) => (n === 1 ? `Recovered ${stem}` : `Recovered ${stem} ${n}`) },
  copy: { re: new RegExp(`^(.+?) copy${NUMBER}$`), form: (stem, n) => (n === 1 ? `${stem} copy` : `${stem} copy ${n}`) },
};
const LEGACY_RECOVERED = /^(.+?) \(recovered(?: ([2-9]|[1-9][0-9]+))?\)$/;

/** The first 100 characters (code points, as the backend counts them). */
const clip = (name: string) => Array.from(name).slice(0, 100).join('');

function familyMatch(name: string, family: Family): RegExpExecArray | null {
  if (family === 'recovered' && FAMILIES.canvas.re.test(name)) return null;
  return FAMILIES[family].re.exec(name) ?? (family === 'recovered' ? LEGACY_RECOVERED.exec(name) : null);
}

/** (stem, number) when `name` is in `family`; 1 when its last word gives none. */
function familyNumber(name: string, family: Family): [string, number] | null {
  const match = familyMatch(name, family);
  return match ? [match[1], match[2] ? Number(match[2]) : 1] : null;
}

function nextFree(family: Family, stem: string, names: Set<string>, above: number): string {
  let n = above + 1;
  while (names.has(FAMILIES[family].form(stem, n))) n += 1;
  return FAMILIES[family].form(stem, n);
}

/** The next free name in `family` for something made from `source`. */
function familyName(source: string, family: Family, names: Set<string>): string {
  let found = familyNumber(source, family);
  if (!found) {
    const first = FAMILIES[family].form(clip(source), 1);
    if (!names.has(first)) return first;
    found = familyNumber(first, family);
    if (!found) return nextFree(family, clip(source), names, 1);
  }
  return nextFree(family, found[0], names, found[1]);
}

/** A name ending in a number of its own: a digit last, and not "copy N". */
const endsInItsOwnNumber = (name: string) => /[0-9]$/.test(name) && familyNumber(name, 'copy') === null;

/** A recovered copy's name. `taken`: the names in use (the project list and
 * Recently deleted), so the next free number is picked as Nebula would. */
export function recoveredCopyFallbackName(sourceName: string, taken: Iterable<string> = []): string {
  const names = new Set(taken);
  if (FAMILIES.canvas.re.test(sourceName)) return familyName(sourceName, 'canvas', names);
  const legacy = LEGACY_RECOVERED.exec(sourceName);
  const stem = legacy ? legacy[1] : familyMatch(sourceName, 'recovered')?.[1] ?? null;
  if (stem === null && endsInItsOwnNumber(sourceName)) return familyName(`Recovered ${clip(sourceName)}`, 'copy', names);
  if (stem !== null && endsInItsOwnNumber(stem)) return familyName(legacy ? `Recovered ${stem}` : sourceName, 'copy', names);
  return familyName(sourceName, 'recovered', names);
}

/** A duplicate's name: "<name> copy", then the next free number. */
export function duplicateName(sourceName: string, taken: Iterable<string> = []): string {
  return familyName(sourceName, 'copy', new Set(taken));
}

/** A canvas's copy when its project isn't known: "Recovered canvas", then the lowest free number. */
export function recoveredCanvasName(taken: Iterable<string> = []): string {
  return nextFree('canvas', RECOVERED_CANVAS, new Set(taken), 0);
}

/** The project a recovered copy was made from, or null for a name outside
 * the family and for a canvas's copy. "Recovered Shot 7 copy" was made from
 * "Shot 7" (a name ending in its own number is recovered as a copy). */
export function recoveredSourceName(name: string): string | null {
  const legacy = LEGACY_RECOVERED.exec(name);
  if (legacy) return legacy[1];
  const recovered = familyMatch(name, 'recovered');
  if (!recovered) return null;
  const copied = familyNumber(recovered[1], 'copy');
  if (copied && endsInItsOwnNumber(copied[0])) return copied[0];
  return recovered[1];
}
