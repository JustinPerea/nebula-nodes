/**
 * A label with its aside after a middle dot ("Moodboard · optional", design). The space before the
 * dot is a no-break space, so in a narrow panel the dot wraps together with its aside and never
 * stays stranded at the end of the first line. Strings that are stored or matched (port and option
 * labels in the node definitions, which other code splits on " · ") keep the plain space; build the
 * shown string with this instead.
 */
export const ASIDE_DOT = ' ·';

export function aside(label: string | number, note: string): string {
  return `${label}${ASIDE_DOT} ${note}`;
}
