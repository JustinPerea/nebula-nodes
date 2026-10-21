/**
 * A Commons section's eyebrow line: the section's name as its h2, then the
 * section's descriptor ("Blind labeling · C1 / C2 human ground truth"). GM
 * review of PR #157, round 2: the page's h1 stays "Commons"; the section name
 * is the h2, set as the eyebrow (commons-evaluation.css `.commons-eyebrow`).
 * The h2 holds only the name, so a region labelled by its id is named just
 * "Blind labeling". The line is shown in capitals, and Chromium names a
 * heading from the transformed text ("BLIND LABELING", live check), so the
 * h2 also carries its name as written.
 */
export function SectionEyebrow({ id, name, detail }: { id: string; name: string; detail: string }) {
  return (
    <div className="commons-eyebrow">
      <h2 id={id} aria-label={name}>{name}</h2>
      <span>{' · '}{detail}</span>
    </div>
  );
}
