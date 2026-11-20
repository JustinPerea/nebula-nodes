/**
 * A label with its aside after a middle dot ("Moodboard · optional", design). The space after the
 * dot is a no-break space and the space before it is an ordinary one, so in a narrow panel the line
 * breaks before the dot and the dot always starts the line together with its aside; it never stays
 * stranded at the end of the first line. Strings that are stored or matched (port and option
 * labels in the node definitions, which other code splits on " · ") keep plain spaces; build the
 * shown string with this instead.
 */
export const ASIDE_DOT = ' ·\u00a0';

export function aside(label: string | number, note: string): string {
  return `${label}${ASIDE_DOT}${note}`;
}

/**
 * A status label as it reads after a dot ("Google API · setup required", design): the first word
 * starts lower case. An acronym ("API key") keeps its capital. The same label stands alone
 * elsewhere ("Setup required"), so this is applied where the two are joined, not in the label.
 */
export const afterDot = (note: string): string => /^[A-Z]{2}/.test(note) ? note : note.charAt(0).toLowerCase() + note.slice(1);
