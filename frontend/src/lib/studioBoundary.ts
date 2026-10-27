/**
 * What a studio that can't render says (GM's follow-up for PR #198 r2, M2).
 * A studio whose node data is missing or damaged shows a contained line
 * with Back to canvas (components/StudioBoundary.tsx) instead of blanking
 * the whole app, and the Agent log names the node and the field.
 */

/** The screens StudioBoundary wraps (uiStore viewMode). */
export type StudioScreen =
  | 'cinema-editor' | 'editor' | 'remotion-editor' | 'character-editor' | 'moodboard-editor'
  | 'create' | 'commons' | 'brand-showcase';

/** What the line calls a studio's subject when its node has no name. GM
 * worded "this scene", "this clip" and "this shot list"; the rest are
 * builder's, for GM to confirm. */
const SUBJECT: Record<StudioScreen, string> = {
  'cinema-editor': 'this scene',
  editor: 'this clip',
  'remotion-editor': 'this shot list',
  'character-editor': 'this character',
  'moodboard-editor': 'this moodboard',
  create: 'Creator Studio',
  commons: 'the Commons',
  'brand-showcase': 'the showcase',
};

const DAMAGED = "Some of its data is missing or damaged, so Nebula can't show it.";

/** GM: "Couldn't open “<node>”. Some of its data is missing or damaged, so
 * Nebula can't show it.", or the studio's noun with no name. */
export function studioBoundaryLine(studio: StudioScreen, label: string | null): string {
  const subject = label ? `“${label}”` : SUBJECT[studio];
  return `Couldn't open ${subject}. ${DAMAGED}`;
}

/** GM's boundary line at a canvas card's size (PR #198 review 3, L4): the
 * same words, "Couldn't open “<node>”. Some of its data is missing or
 * damaged, so Nebula can't show it.", "this node" with no name. */
export function nodeCardBoundaryLine(label: string | null): string {
  return `Couldn't open ${label ? `“${label}”` : 'this node'}. ${DAMAGED}`;
}

/** GM: the Agent log's line, "Couldn't open “<node>”, node n4. <field> is
 * missing." Never names the agent. With no field found, builder's: "Its
 * data couldn't be read." */
export function studioBoundaryLogLine(label: string | null, nodeId: string, field: string | null): string {
  const what = field ? `${field} is missing.` : "Its data couldn't be read.";
  return `Couldn't open ${label ? `“${label}”` : 'a node'}, node ${nodeId}. ${what}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The first part of a Cinema scene the studio can't read through its
 * defaults (as the backend names fields: "scene.shots[0]"), or null when
 * none is. A missing base or aspect is filled in (lib/cinemaScene), so it
 * is named only when nothing else is wrong. */
export function cinemaSceneProblem(params: Record<string, unknown> | undefined): string | null {
  const scene = params?.scene;
  if (!isRecord(scene)) return 'scene';
  if (Array.isArray(scene.shots)) {
    const broken = scene.shots.findIndex((shot) => !isRecord(shot) || typeof shot.id !== 'string');
    if (broken >= 0) return `scene.shots[${broken}]`;
  } else if (scene.shots !== undefined) return 'scene.shots';
  if (!isRecord(scene.base)) return 'scene.base';
  if (typeof scene.base.model !== 'string' || !scene.base.model) return 'scene.base.model';
  if (typeof scene.aspectRatio !== 'string' || !scene.aspectRatio) return 'scene.aspectRatio';
  return null;
}
