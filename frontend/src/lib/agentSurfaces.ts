/**
 * The surfaces an agent cursor can point at besides the canvas (Phase 3,
 * "Anywhere"), in one table: for each, the key its name has in `anchorNames`,
 * what the part of `itemId` after the "/" is, and its controls with the words
 * a line calls them. Everything surface-shaped reads this (the store's
 * validation, the resolver, the default lines), so a surface is one entry
 * here, not another copy of the moodboard branch.
 *
 * Imports nothing, so anything may read it (the presence store validates
 * against it; this file loads with the cursor's deferred chunks). The words are
 * pinned to the Studios' visible text and to the backend's
 * (cursor_actions.PART_LABELS) by tests/agentSurfaceProtocol.test.ts.
 */

export type AgentSurfaceName = 'moodboard' | 'character' | 'style';

export interface AgentSurfaceSpec {
  /** The key holding the item's name in `anchorNames`. */
  nameKey: 'board' | 'character' | 'style';
  /** What follows the "/" in `itemId`: an image's id, a view's 1-based position, or nothing (no sub-item). */
  sub: { kind: 'image'; nameKey: 'image' } | { kind: 'view'; nameKey: 'view' } | null;
  /** The item's own controls, by part id: the label the screen shows, or null when no screen draws the control (the part only chooses the line). */
  parts: Readonly<Record<string, string | null>>;
  /** The sub-item's controls (an image's), by part id. */
  subParts: Readonly<Record<string, string | null>>;
}

/** The words a moodboard control goes by (the Studio's labels). */
export const MOODBOARD_PART_LABELS = {
  name: 'Name', direction: 'Direction', avoid: 'Avoid', colors: 'Colors', 'colors-out': 'Colors to keep out',
  note: 'Note', weight: 'Weight',
} as const;

export const AGENT_SURFACES: Readonly<Record<AgentSurfaceName, AgentSurfaceSpec>> = {
  moodboard: {
    nameKey: 'board',
    sub: { kind: 'image', nameKey: 'image' },
    parts: {
      name: MOODBOARD_PART_LABELS.name, direction: MOODBOARD_PART_LABELS.direction, avoid: MOODBOARD_PART_LABELS.avoid,
      colors: MOODBOARD_PART_LABELS.colors, 'colors-out': MOODBOARD_PART_LABELS['colors-out'],
    },
    subParts: { note: MOODBOARD_PART_LABELS.note, weight: MOODBOARD_PART_LABELS.weight },
  },
  character: {
    nameKey: 'character',
    sub: { kind: 'view', nameKey: 'view' },
    // The Character Studio's own labels (pinned by a test against its source).
    parts: { name: 'Name', 'subject-type': 'Subject type', views: 'Reference views', traits: 'Frozen trait string', seed: 'Seed' },
    subParts: {},
  },
  style: {
    nameKey: 'style',
    sub: null,
    // No screen draws a Style's fields: the part only chooses the line.
    parts: { name: null, category: null, prompt: null, settings: null, model: null, references: null, thumbnail: null },
    subParts: {},
  },
};

export const AGENT_SURFACE_NAMES = Object.keys(AGENT_SURFACES) as AgentSurfaceName[];

export function isAgentSurface(value: unknown): value is AgentSurfaceName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_SURFACES, value);
}

/** What a surface anchor's names say, whatever the surface: the item's name,
 *  its sub-item's number, the control's label (or, for a Style, its part id). */
export function surfaceNamesOf(
  surface: AgentSurfaceName,
  names: { board?: string; image?: number; character?: string; view?: number; style?: string; part?: string },
): { name: string | null; sub: number | null; part: string | null } {
  const spec = AGENT_SURFACES[surface];
  const sub = spec.sub ? names[spec.sub.nameKey] : undefined;
  return { name: names[spec.nameKey] ?? null, sub: typeof sub === 'number' ? sub : null, part: names.part ?? null };
}
