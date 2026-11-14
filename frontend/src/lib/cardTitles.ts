import type { ModelNodeDefinition } from '../types';
import { canvasTitle } from './directRoute';
import type { StoredAssetEntry } from '../store/storedAssetsStore';

/**
 * The title row of each deferred card, in one startup module. The real cards
 * (components/nodes/*Node.tsx) read their title from here, and so does the
 * frame drawn while a card's chunk loads (components/nodes/CardFallback.tsx),
 * so a frame shows what its card shows and the two cannot drift apart. The
 * strings are the cards' own; this module holds no icon component (a lucide
 * icon imported here would land in the startup set).
 */

/** The glyph a card draws before its title, where the card's icon is a plain character. */
export const CARD_GLYPH: Readonly<Record<string, string>> = {
  characterNode: '◐',
  referenceSetNode: '▤',
  cameraRigNode: '◈',
  cinemaSceneNode: '⛭',
  editNode: '✂',
  remotionNode: '▶',
};

/** The type name of a card whose title is a fixed name. */
const FIXED_NAME: Readonly<Record<string, string>> = {
  referenceSetNode: 'Reference Set',
  cameraRigNode: 'Camera Rig',
  cinemaSceneNode: 'Cinema Scene',
  editNode: 'Video Edit',
  remotionNode: 'Remotion Composition',
  paperSourceNode: 'Paper source',
};

/** A glyph card's title as the card prints it: "◈ Camera Rig". */
export function glyphTitle(type: string, text: string): string {
  return `${CARD_GLYPH[type]} ${text}`;
}

/** The fixed title of a card that has one (Reference set, Camera rig, Cinema scene, Edit, Remotion, Paper source); glyph cards include theirs. */
export function fixedCardTitle(type: string): string {
  const name = FIXED_NAME[type] ?? '';
  return CARD_GLYPH[type] ? glyphTitle(type, name) : name;
}

/** A Character card's name: the character's own, else by the stored entry's status. */
export function characterName(entry: StoredAssetEntry | null): string {
  return entry?.summary?.name.trim() || (entry?.status === 'missing' ? 'Character not found' : 'Character');
}

/** A Moodboard card's name line: the board's own, else by status ('empty' is no board chosen). */
export function moodboardName(boardId: string, entry: StoredAssetEntry | null): string {
  const status = boardId ? entry?.status ?? 'loading' : 'empty';
  return entry?.summary?.name.trim() || (status === 'empty' ? 'No board chosen' : status === 'missing' ? 'Board not found' : 'Moodboard');
}

/** A Batch card's name: its display name, else "Batch". */
export function batchName(params: Record<string, unknown> | undefined): string {
  const name = params?.display_name;
  return typeof name === 'string' && name.trim() ? name : 'Batch';
}

/**
 * What a Model or Dynamic card's title shows for a saved label (NodeLabel's
 * rule): the saved label is custom when it is neither form of the node's
 * default title (the catalog name or the canvas title); an unnamed node shows
 * the canvas title.
 */
export function shownNodeTitle(label: string, displayName: string | undefined, defaultTitle: string | undefined): { shown: string; custom: boolean; fallback: string | undefined } {
  const fallback = defaultTitle ?? displayName;
  const custom = Boolean(displayName) && label !== displayName && label !== fallback;
  const shown = displayName && !custom && fallback ? fallback : label;
  return { shown, custom, fallback };
}

/** The title a Model or Dynamic frame shows: what NodeLabel shows for the node's label. */
export function modelFrameTitle(label: string, definition: ModelNodeDefinition | undefined): string {
  return shownNodeTitle(label, definition?.displayName, definition ? canvasTitle(definition) : undefined).shown;
}

/** A frame's title row: glyph and text as the card prints them, or text with the node type's own icon. */
export interface FrameTitle {
  /** The whole title for a glyph card ("◐ Mara"), or the text alone. */
  text: string;
  /** Model and Dynamic only: their own icon (NodeTypeIcon) leads the row. */
  typeIcon: boolean;
}

export interface FrameTitleInput {
  type: string | undefined;
  data: Record<string, unknown>;
  definition: ModelNodeDefinition | undefined;
  characterEntry: StoredAssetEntry | null;
  moodboardEntry: StoredAssetEntry | null;
  boardId: string;
}

/** The title the frame for `type` shows; an unknown type shows its definition's name with no icon. */
export function frameTitle({ type, data, definition, characterEntry, moodboardEntry, boardId }: FrameTitleInput): FrameTitle {
  const label = typeof data.label === 'string' ? data.label : '';
  const params = data.params && typeof data.params === 'object' ? data.params as Record<string, unknown> : undefined;
  switch (type) {
    case 'model-node':
    case 'dynamic-node':
      return { text: modelFrameTitle(label, definition) || definition?.displayName || 'Node', typeIcon: true };
    case 'characterNode': return { text: glyphTitle(type, characterName(characterEntry)), typeIcon: false };
    case 'moodboardNode': return { text: moodboardName(boardId, moodboardEntry), typeIcon: false };
    case 'batchNode': return { text: batchName(params), typeIcon: false };
    case 'referenceSetNode':
    case 'cameraRigNode':
    case 'cinemaSceneNode':
    case 'editNode':
    case 'remotionNode':
    case 'paperSourceNode':
      return { text: fixedCardTitle(type), typeIcon: false };
    default:
      return { text: definition?.displayName ?? 'Node', typeIcon: false };
  }
}
