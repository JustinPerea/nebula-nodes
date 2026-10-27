/**
 * A Cinema scene's shape and its shots' run status (PR #198 review 2, M1 and
 * M2). The backend fills a scene's missing fields on every write
 * (services/cinema_scene_spec.py); this is the same fill for what the canvas
 * reads, so a scene saved before that (or one that reached the canvas some
 * other way) still opens instead of blanking the studio.
 */
import type { ActiveRun } from './runHistory';
import type { CinemaSceneSpec, CinemaShot } from '../types';

export const DEFAULT_SCENE_MODEL = 'seedream-4-5';
export const DEFAULT_SCENE_ASPECT = '16:9';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const blank = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim());

/** `scene` with the defaults a new scene has wherever it lacks them (the
 * same object when it lacks none). Shots that aren't a list read as none. */
export function normalizeCinemaScene(scene: unknown): CinemaSceneSpec {
  const value = isRecord(scene) ? scene : {};
  const base = isRecord(value.base) ? value.base : null;
  const fill: Record<string, unknown> = {};
  if (value.version === undefined || value.version === null) fill.version = 1;
  if (!base) fill.base = { model: DEFAULT_SCENE_MODEL };
  else if (blank(base.model) || typeof base.model !== 'string') fill.base = { ...base, model: DEFAULT_SCENE_MODEL };
  if (blank(value.aspectRatio) || typeof value.aspectRatio !== 'string') fill.aspectRatio = DEFAULT_SCENE_ASPECT;
  if (!Array.isArray(value.shots)) fill.shots = [];
  if (Object.keys(fill).length === 0 && value === scene) return scene as unknown as CinemaSceneSpec;
  return { ...value, ...fill } as unknown as CinemaSceneSpec;
}

const TRANSIENT = new Set(['running', 'queued', 'pending']);

/** A shot's output with a transient run status settled: "done" when it has
 * an image, else "idle" (what an undo step holds; nothing it puts back is
 * ever rendering). The same output when it isn't transient. */
export function settledShotOutput(output: CinemaShot['output']): CinemaShot['output'] {
  if (!output || !TRANSIENT.has(output.status)) return output;
  return output.imageUrl ? { ...output, status: 'done' } : { status: 'idle' };
}

/** A node's params with any Cinema shot's transient status settled (the same
 * object when none was). */
export function settledParams(definitionId: string, params: Record<string, unknown>): Record<string, unknown> {
  if (definitionId !== 'cinema-scene') return params;
  const scene = params.scene as CinemaSceneSpec | undefined;
  if (!scene || !Array.isArray(scene.shots)) return params;
  let changed = false;
  const shots = scene.shots.map((shot) => {
    if (!isRecord(shot)) return shot;
    const output = settledShotOutput(shot.output);
    if (output === shot.output) return shot;
    changed = true;
    return { ...shot, output };
  });
  return changed ? { ...params, scene: { ...scene, shots } } : params;
}

/** Why a shot can't be removed now (GM, PR #198 r2: block × while a shot
 * renders): 'stop' when Cinema shows a Stop control for the run rendering
 * it (Stop shot for this shot's run, Stop scene for a run of the whole
 * scene), 'wait' when it renders with no Stop here (its optimistic
 * "running" while the run starts). Null when it can go. */
export function shotRemovalBlock(activeRuns: readonly ActiveRun[], nodeId: string,
  shot: Pick<CinemaShot, 'id' | 'output'>): 'stop' | 'wait' | null {
  const rendering = activeRuns.some((run) => (run.kind === 'cinema-shot'
    ? run.nodeId === nodeId && run.shotId === shot.id : run.nodeIds.includes(nodeId)));
  if (rendering) return 'stop';
  return shot.output?.status === 'running' ? 'wait' : null;
}

/** GM's tooltip for a blocked ×: "Stop the run first." or "Wait for “Shot 2” to finish." */
export function shotRemovalBlockTitle(block: 'stop' | 'wait', shotName: string): string {
  return block === 'stop' ? 'Stop the run first.' : `Wait for “${shotName}” to finish.`;
}

/** `wanted` (params an undo or redo puts back) with every shot that is
 * rendering on the canvas now keeping its live output, so an undo never
 * takes a spinner off a shot whose run is still going (the step holds it
 * settled; review 2, M1). The same object when no shot is rendering. */
export function keepRenderingShots(definitionId: string, wanted: Record<string, unknown>,
  live: Record<string, unknown> | undefined): Record<string, unknown> {
  if (definitionId !== 'cinema-scene') return wanted;
  const liveShots = (live?.scene as CinemaSceneSpec | undefined)?.shots;
  const scene = wanted.scene as CinemaSceneSpec | undefined;
  if (!Array.isArray(liveShots) || !scene || !Array.isArray(scene.shots)) return wanted;
  const rendering = new Map(liveShots.filter((shot) => isRecord(shot) && shot.output?.status === 'running')
    .map((shot) => [shot.id, shot.output]));
  if (rendering.size === 0) return wanted;
  const shots = scene.shots.map((shot) => (isRecord(shot) && rendering.has(shot.id) ? { ...shot, output: rendering.get(shot.id) } : shot));
  return { ...wanted, scene: { ...scene, shots } };
}
