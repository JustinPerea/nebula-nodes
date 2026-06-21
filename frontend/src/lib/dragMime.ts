/** Drag MIME types the Canvas reads on drop to route an asset to the right
 *  node factory (addCharacterNode / addMoodboardNode) rather than addNode.
 *  Lives here (not in a panel component) so both the Assets panel and the
 *  Canvas drop handler can share them without a component dependency. */
export const CHARACTER_DRAG_MIME = 'application/nebula-character';
export const MOODBOARD_DRAG_MIME = 'application/nebula-moodboard';
