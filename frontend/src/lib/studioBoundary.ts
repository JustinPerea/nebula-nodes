import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

/**
 * What a studio or a canvas card that can't render says (GM's follow-up for
 * PR #198 r2, M2; r4 and r5 for review 4, L3). It shows a contained line
 * (components/StudioBoundary.tsx, components/nodes/NodeCardBoundary.tsx)
 * instead of blanking the whole app. Which line depends on the data check
 * (nodeDataProblem): "missing or damaged" only when the check finds what's
 * wrong; when the data checks out, GM's neutral line says the data is fine
 * and to reload, and the Agent log names the error itself.
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

const STUDIO_DAMAGED = "Some of its data is missing or damaged, so Nebula can't show it.";
/** GM r4: a card's line has no "so Nebula can't show it." */
const CARD_DAMAGED = 'Some of its data is missing or damaged.';
/** GM r5: the data checks out, so the fault is Nebula's drawing. */
const CARD_NEUTRAL = 'Nebula ran into a problem drawing it, but its data is fine. Reload Nebula to try again.';
const STUDIO_NEUTRAL = 'Nebula ran into a problem showing it, but its data is fine. Reload Nebula to try again.';

/** GM: "Couldn't open “<node>”. Some of its data is missing or damaged, so
 * Nebula can't show it." when `damaged`, else GM r5's "Couldn't open
 * “<node>”. Nebula ran into a problem showing it, but its data is fine.
 * Reload Nebula to try again."; the studio's noun with no name. */
export function studioBoundaryLine(studio: StudioScreen, label: string | null, damaged: boolean): string {
  const subject = label ? `“${label}”` : SUBJECT[studio];
  return `Couldn't open ${subject}. ${damaged ? STUDIO_DAMAGED : STUDIO_NEUTRAL}`;
}

/** A canvas card's line (GM r4 and r5): "Couldn't show “<node>”. Some of
 * its data is missing or damaged." when `damaged`, else "Couldn't show
 * “<node>”. Nebula ran into a problem drawing it, but its data is fine.
 * Reload Nebula to try again."; "this node" with no name. */
export function nodeCardBoundaryLine(label: string | null, damaged: boolean): string {
  return `Couldn't show ${label ? `“${label}”` : 'this node'}. ${damaged ? CARD_DAMAGED : CARD_NEUTRAL}`;
}

/** GM: the Agent log's line for damaged data, "Couldn't open “<node>”, node
 * n4. <field> is missing." Never names the agent. With no field found,
 * builder's: "Its data couldn't be read." */
export function studioBoundaryLogLine(label: string | null, nodeId: string, field: string | null): string {
  const what = field ? `${field} is missing.` : "Its data couldn't be read.";
  return `Couldn't open ${label ? `“${label}”` : 'a node'}, node ${nodeId}. ${what}`;
}

/** GM r5: the Agent log's line when the data checks out, "Couldn't draw
 * “<node>”, node n4. <error message>". */
export function drawFailedLogLine(label: string | null, nodeId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const what = message.trim() || 'An error with no message.';
  return `Couldn't draw ${label ? `“${label}”` : 'a node'}, node ${nodeId}. ${what}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The first item of `list` that isn't an object, as `<name>[i]`; `<name>`
 * when it's there but isn't a list; null when it's fine or absent. */
function listProblem(name: string, list: unknown, item: (value: unknown) => boolean = isRecord): string | null {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return name;
  const broken = list.findIndex((value) => !item(value));
  return broken >= 0 ? `${name}[${broken}]` : null;
}

/** The first part of a node's data a card or studio can't read (as the
 * backend names fields), or null when it checks out (review 4, L3: only then
 * does a boundary say "missing or damaged"). It checks what every card reads
 * (a known definitionId; label as text; params and outputs as objects) and
 * the structures the studios walk (a scene's shots and base, an edit's
 * clips, a composition's timeline). Absent optional parts are fine: the
 * canvas fills them in. */
export function nodeDataProblem(data: unknown): string | null {
  if (!isRecord(data)) return 'data';
  if (typeof data.definitionId !== 'string' || !NODE_DEFINITIONS[data.definitionId]) return 'definitionId';
  if (data.label !== undefined && data.label !== null && typeof data.label !== 'string') return 'label';
  if ('params' in data && !isRecord(data.params)) return 'params';
  if ('outputs' in data && !isRecord(data.outputs)) return 'outputs';
  const params = isRecord(data.params) ? data.params : {};
  switch (data.definitionId) {
    case 'cinema-scene': return cinemaSceneProblem(params);
    case 'video-edit': return listProblem('clips', params.clips);
    case 'remotion-node': {
      if (params.manifest === undefined) return null;
      if (!isRecord(params.manifest)) return 'manifest';
      return listProblem('manifest.timeline', params.manifest.timeline);
    }
    default: return null;
  }
}

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
