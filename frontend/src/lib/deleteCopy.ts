/**
 * GM - Design, round 20 (item 1, 2026-10-27), verbatim: a failed delete
 * whose cause really is no answer from Nebula (isBackendUnreachable: no
 * answer at all, or a gateway status with no reason of the backend's):
 *   "Couldn't delete “<node>”. Nebula isn't answering. Make sure it's
 *    running, then try again."
 *   Several nodes: up to 3 names ("“A” and “B”", "“A”, “B” and “C”"); from
 *   4 up, "Couldn't delete <N> nodes."
 * Other causes keep their reason under the old heading.
 */
export const DELETE_NO_ANSWER_REASON = "Nebula isn't answering. Make sure it's running, then try again.";

export function deleteNoAnswerLine(names: string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  const what = quoted.length >= 4 ? `${quoted.length} nodes`
    : quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
  return `Couldn't delete ${what}. ${DELETE_NO_ANSWER_REASON}`;
}

/**
 * GM - Design, round 21 (LOCKED, 2026-10-27), verbatim: a delete Nebula
 * answered with a server error (a 500), when the node and its wires really
 * are back on the canvas:
 *   "Couldn't delete “<node>”. Nebula ran into an error, so it's back on the
 *    canvas. Try again, and if it keeps happening, restart Nebula."
 *   Several nodes: the same counting as deleteNoAnswerLine (up to 3 names,
 *   then "<N> nodes"), ending "…so they're back on the canvas."
 * The status (and an error id, when Nebula gives one) goes in the Agent log,
 * never in the line.
 */
export function deleteServerErrorLine(names: string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  const what = quoted.length >= 4 ? `${quoted.length} nodes`
    : quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
  const back = names.length === 1 ? "it's back on the canvas" : "they're back on the canvas";
  return `Couldn't delete ${what}. Nebula ran into an error, so ${back}. Try again, and if it keeps happening, restart Nebula.`;
}
