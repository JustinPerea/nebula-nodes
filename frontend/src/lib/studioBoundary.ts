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

const STUDIO_DAMAGED = "Some of its data is missing or damaged, so Nebula can’t show it.";
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
  return `Couldn’t open ${subject}. ${damaged ? STUDIO_DAMAGED : STUDIO_NEUTRAL}`;
}

/** A canvas card's line (GM r4 and r5): "Couldn't show “<node>”. Some of
 * its data is missing or damaged." when `damaged`, else "Couldn't show
 * “<node>”. Nebula ran into a problem drawing it, but its data is fine.
 * Reload Nebula to try again."; "this node" with no name. */
export function nodeCardBoundaryLine(label: string | null, damaged: boolean): string {
  return `Couldn’t show ${label ? `“${label}”` : 'this node'}. ${damaged ? CARD_DAMAGED : CARD_NEUTRAL}`;
}

/** What the data check knows about the field it names (GM r6 item 4):
 * `missing` when the field is absent, `damaged` when it's there but isn't
 * what Nebula reads, `unknown` when the code can't tell (the check itself
 * failed, or a caller only had the field's name). */
export type DataProblemState = 'missing' | 'damaged' | 'unknown';
export interface DataProblem {
  field: string;
  state: DataProblemState;
}

/** GM r6 item 4, the Agent log's ending for each kind: "<field> is
 * missing.", "<field> is damaged.", and "missing or damaged" only when the
 * code can't tell. */
const PROBLEM_TAIL: Record<DataProblemState, string> = {
  missing: 'is missing.',
  damaged: 'is damaged.',
  unknown: 'is missing or damaged.',
};

/** GM: the Agent log's line for damaged data, "Couldn't open “<node>”, node
 * n4. <field> is missing." (or "is damaged.", GM r6 item 4, by what the
 * check found; a bare field name can't say, so "is missing or damaged.").
 * Opened in a studio, it names the studio (GM r8): "Couldn't open “<node>”
 * in Cinema, node n4. …". Never names the agent. With no field found,
 * builder's: "Its data couldn't be read." */
export function studioBoundaryLogLine(label: string | null, nodeId: string,
  problem: DataProblem | string | null, studio?: StudioScreen): string {
  const found = typeof problem === 'string' ? { field: problem, state: 'unknown' as const } : problem;
  const what = found ? `${found.field} ${PROBLEM_TAIL[found.state]}` : "Its data couldn’t be read.";
  const where = studio ? ` in ${STUDIO_PLACE[studio]}` : '';
  return `Couldn’t open ${label ? `“${label}”` : 'a node'}${where}, node ${nodeId}. ${what}`;
}

const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.trim() || 'An error with no message.';
};

/** GM r5: a canvas card's Agent log line when the data checks out,
 * "Couldn't draw “<node>”, node n4. <error message>". */
export function drawFailedLogLine(label: string | null, nodeId: string, error: unknown): string {
  return `Couldn’t draw ${label ? `“${label}”` : 'a node'}, node ${nodeId}. ${errorText(error)}`;
}

/** Where a studio's Agent log line says the node failed to open, after
 * "in". GM r6 item 5 worded "in Creator Studio"; the others are builder's,
 * for GM to confirm (each studio by the name its header shows). */
export const STUDIO_PLACE: Record<StudioScreen, string> = {
  'cinema-editor': 'Cinema',
  editor: 'the video editor',
  'remotion-editor': 'the composition editor',
  'character-editor': 'the character editor',
  'moodboard-editor': 'the moodboard editor',
  create: 'Creator Studio',
  commons: 'the Commons',
  'brand-showcase': 'the showcase',
};

/** GM r6 item 5: a studio's Agent log line when the data checks out,
 * "Couldn't open “<node>” in <studio>, node n4. <error message>". */
export function studioDrawFailedLogLine(studio: StudioScreen, label: string | null, nodeId: string, error: unknown): string {
  return `Couldn’t open ${label ? `“${label}”` : 'a node'} in ${STUDIO_PLACE[studio]}, node ${nodeId}. ${errorText(error)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A field that is there but not what Nebula reads is damaged; one that
 * isn't there at all is missing (GM r6 item 4). */
const problem = (field: string, value: unknown): DataProblem =>
  ({ field, state: value === undefined ? 'missing' : 'damaged' });

/** The first item of `list` that isn't an object, as `<name>[i]`; `<name>`
 * when it's there but isn't a list; null when it's fine or absent. Both are
 * damaged: the list is there. */
function listProblem(name: string, list: unknown, item: (value: unknown) => boolean = isRecord): DataProblem | null {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return { field: name, state: 'damaged' };
  const broken = list.findIndex((value) => !item(value));
  return broken >= 0 ? { field: `${name}[${broken}]`, state: 'damaged' } : null;
}

/** The first part of a node's data a card or studio can't read (as the
 * backend names fields), with whether it is missing or damaged (GM r6 item
 * 4), or null when it checks out (review 4, L3: only then does a boundary
 * say "missing or damaged"). It checks what every card reads (a known
 * definitionId; label as text; params and outputs as objects) and the
 * structures the studios walk (a scene's shots and base, an edit's clips, a
 * composition's timeline). Absent optional parts are fine: the canvas fills
 * them in. */
export function nodeDataProblem(data: unknown): DataProblem | null {
  if (!isRecord(data)) return problem('data', data ?? undefined);
  if (typeof data.definitionId !== 'string' || !NODE_DEFINITIONS[data.definitionId]) return problem('definitionId', data.definitionId);
  if (data.label !== undefined && data.label !== null && typeof data.label !== 'string') return problem('label', data.label);
  if ('params' in data && !isRecord(data.params)) return problem('params', data.params);
  if ('outputs' in data && !isRecord(data.outputs)) return problem('outputs', data.outputs);
  const params = isRecord(data.params) ? data.params : {};
  switch (data.definitionId) {
    case 'cinema-scene': return cinemaSceneProblem(params);
    case 'video-edit': return listProblem('clips', params.clips);
    case 'remotion-node': {
      if (params.manifest === undefined) return null;
      if (!isRecord(params.manifest)) return problem('manifest', params.manifest);
      return listProblem('manifest.timeline', params.manifest.timeline);
    }
    default: return null;
  }
}

/** The first part of a Cinema scene the studio can't read through its
 * defaults (as the backend names fields: "scene.shots[0]"), with whether it
 * is missing or damaged, or null when none is. A missing base or aspect is
 * filled in (lib/cinemaScene), so it is named only when nothing else is
 * wrong. */
export function cinemaSceneProblem(params: Record<string, unknown> | undefined): DataProblem | null {
  const scene = params?.scene;
  if (!isRecord(scene)) return problem('scene', scene);
  if (Array.isArray(scene.shots)) {
    const broken = scene.shots.findIndex((shot) => !isRecord(shot) || typeof shot.id !== 'string');
    if (broken >= 0) return { field: `scene.shots[${broken}]`, state: 'damaged' };
  } else if (scene.shots !== undefined) return { field: 'scene.shots', state: 'damaged' };
  if (!isRecord(scene.base)) return problem('scene.base', scene.base);
  if (typeof scene.base.model !== 'string' || !scene.base.model) return problem('scene.base.model', scene.base.model);
  if (typeof scene.aspectRatio !== 'string' || !scene.aspectRatio) return problem('scene.aspectRatio', scene.aspectRatio);
  return null;
}
