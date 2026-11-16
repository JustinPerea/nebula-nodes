/**
 * The Title Case default labels of six nodes, before the copy sweep renamed
 * them to sentence case. A node saved earlier carries the old label, which no
 * longer equals the definition's name, so a plain comparison would read it as a
 * name the person chose. Every default-title check goes through here, so a
 * former default counts as the default. Stored labels are not rewritten.
 * Same table as backend/services/node_route.py FORMER_DEFAULT_TITLES;
 * contracts/fixtures/former-default-titles.json pins both.
 */
export const FORMER_DEFAULT_TITLES: Readonly<Record<string, string>> = {
  'camera-rig': 'Camera Rig',
  'cinema-scene': 'Cinema Scene',
  'paper-source': 'Paper Source',
  'reference-set': 'Reference Set',
  'remotion-node': 'Remotion Composition',
  'video-edit': 'Video Edit',
};

/** The label is the Title Case default this definition had before the sweep. */
export function isFormerDefaultTitle(definitionId: string | undefined, label: string | null | undefined): boolean {
  return !!definitionId && !!label && FORMER_DEFAULT_TITLES[definitionId] === label;
}
