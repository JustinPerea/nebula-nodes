/**
 * The collapsed "Details" toggle that holds raw text under a written failure
 * line (error copy round 3: Commons analysis; round 3c: a node's run error,
 * GM - Design: "put the raw provider text behind the same collapsed
 * "Details" toggle used for Commons analysis"). A native disclosure: it is
 * closed until the person opens it, Tab reaches its summary and Enter or
 * Space opens it, and a screen reader announces it as a collapsed group.
 * Keyed on the text, so a new failure always starts closed. The raw text
 * is plain text, never the line itself. `className` adds the surface's own
 * classes (a React Flow card passes nodrag/nowheel).
 *
 * `nokey` keeps Space working: the canvas pans on Space, and React Flow's
 * key listener sits on the whole window and cancels Space on anything that
 * isn't a button, a link or an input, unless it is inside `.nokey`. A
 * cancelled keydown stops a <summary> from toggling, on a node card and on
 * Commons analysis alike (the canvas stays mounted under it). Inside the
 * toggle React Flow's other keys (Backspace to delete) are ignored too.
 */
export function ErrorDetails({ raw, className }: { raw: string; className?: string }) {
  return (
    <details key={raw} className={['error-details', 'nokey', className].filter(Boolean).join(' ')}>
      <summary>Details</summary>
      <span className="error-details__raw">{raw}</span>
    </details>
  );
}
