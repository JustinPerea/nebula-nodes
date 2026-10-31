/**
 * The tab's side of the recovered-copy family (PR #199, GM r23 a and GM r25,
 * 5), by the backend's rule (services/project_store: name_family): a copy
 * of the edits for project "Delta" is "Recovered Delta", then "Recovered
 * Delta 2" and on; never a second "Recovered", never a second number. Names
 * from before that rule ("Delta (recovered)") still belong to the family.
 * "Recovered canvas" is a canvas's copy, not a project's.
 */
const RECOVERED = /^Recovered (.+?)(?: ([0-9]+))?$/;
const RECOVERED_OLD = /^(.+?) \(recovered\)(?: ([0-9]+))?$/;

/** The project a recovered copy was made from, or null for a name outside
 * the family and for a canvas's copy. */
export function recoveredSourceName(name: string): string | null {
  const old = RECOVERED_OLD.exec(name);
  if (old) return old[1];
  const now = RECOVERED.exec(name);
  if (!now || now[1] === 'canvas') return null;
  return now[1];
}

/** The name the tab shows for a copy whose answer had none: "Recovered
 * <project>", or for a project that is itself a recovered copy, the next
 * number in its family ("Recovered Delta" → "Recovered Delta 2"). */
export function recoveredCopyFallbackName(sourceName: string): string {
  const now = RECOVERED.exec(sourceName);
  if (now) return `Recovered ${now[1]} ${now[2] ? Number(now[2]) + 1 : 2}`;
  return `Recovered ${sourceName}`;
}
