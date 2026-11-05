/**
 * A Cinema scene's shape and its shots' run status (PR #198 review 2, M1 and
 * M2). The backend fills a scene's missing fields on every write
 * (services/cinema_scene_spec.py); this is the same fill for what the canvas
 * reads, so a scene saved before that (or one that reached the canvas some
 * other way) still opens instead of blanking the studio.
 */
import type { ActiveRun } from './runHistory';
import { nodeNameList } from './errorCopy';
import { RUN_LOCK_VERBS, lockLine, runFinishesLine } from './runLock';
import type { CinemaSceneSpec, CinemaShot, NodeState } from '../types';

export const DEFAULT_SCENE_MODEL = 'seedream-4-5';
export const DEFAULT_SCENE_ASPECT = '16:9';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const blank = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim());

/** `scene` with the defaults a new scene has wherever it lacks them (the
 * same object when it lacks none). Shots that aren't a list read as none,
 * and a shot that isn't an object is left out. */
export function normalizeCinemaScene(scene: unknown): CinemaSceneSpec {
  const value = isRecord(scene) ? scene : {};
  const base = isRecord(value.base) ? value.base : null;
  const fill: Record<string, unknown> = {};
  if (value.version === undefined || value.version === null) fill.version = 1;
  if (!base) fill.base = { model: DEFAULT_SCENE_MODEL };
  else if (blank(base.model) || typeof base.model !== 'string') fill.base = { ...base, model: DEFAULT_SCENE_MODEL };
  if (blank(value.aspectRatio) || typeof value.aspectRatio !== 'string') fill.aspectRatio = DEFAULT_SCENE_ASPECT;
  if (!Array.isArray(value.shots)) fill.shots = [];
  // A shot that isn't an object holds nothing to show or keep (the backend
  // drops it too, services/cinema_scene_spec.py).
  else if (value.shots.some((shot) => !isRecord(shot))) fill.shots = value.shots.filter(isRecord);
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

/** What a canvas card can draw of a scene, whatever its data (PR #198
 * review 3, L4: `shots: [null]` or a string took the whole canvas down):
 * its shots that are objects with a text id, an image URL only when it is
 * text, and the reference count only when it is a list. */
export interface SceneCardView {
  shots: { id: string; imageUrl: string | null; failed: boolean }[];
  sheetUrl: string | null;
  refCount: number;
}

export function sceneCardView(scene: unknown): SceneCardView {
  const value = isRecord(scene) ? scene : {};
  const shots = (Array.isArray(value.shots) ? value.shots : []).flatMap((shot) => {
    if (!isRecord(shot) || typeof shot.id !== 'string' || !shot.id) return [];
    const output = isRecord(shot.output) ? shot.output : {};
    return [{ id: shot.id, imageUrl: typeof output.imageUrl === 'string' && output.imageUrl ? output.imageUrl : null,
      failed: output.status === 'error' }];
  });
  const character = isRecord(value.character) ? value.character : {};
  return {
    shots,
    sheetUrl: typeof character.sheetUrl === 'string' && character.sheetUrl ? character.sheetUrl : null,
    refCount: Array.isArray(character.refImageUrls) ? character.refImageUrls.length : 0,
  };
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

/** A scene a run of the graph is still working on: queued for it, or its
 * node rendering now. Once its node is done (a cached scene at once) its
 * shots are free again, even while the run goes on downstream (PR #198
 * review 3, L2; the backend's _scene_render_done). With no state known,
 * it counts as in flight. */
function sceneInFlight(state: NodeState | undefined): boolean {
  return state === undefined || state === 'queued' || state === 'executing';
}

/** Why a shot can't be removed now (GM, PR #198 r2: block × while a shot
 * renders): 'stop' when Cinema shows a Stop control for the run rendering
 * it (Stop shot for this shot's run, the canvas's Stop for a run of the
 * graph while it is still on this scene: `sceneState`, the scene node's
 * run state), 'wait' when it renders with no Stop here (its optimistic
 * "running" while the run starts). Null when it can go.
 * A shot run renders its upstream scenes whole in every variation pass, so
 * it holds them until it ends (PR #198 review 4, M2; the backend's
 * _scene_render_done does the same). */
export function shotRemovalBlock(activeRuns: readonly ActiveRun[], nodeId: string,
  shot: Pick<CinemaShot, 'id' | 'output'>, sceneState?: NodeState): 'stop' | 'wait' | null {
  const rendering = activeRuns.some((run) => (run.kind === 'cinema-shot'
    ? (run.nodeId === nodeId ? run.shotId === shot.id : run.nodeIds.includes(nodeId))
    : run.nodeIds.includes(nodeId) && sceneInFlight(sceneState)));
  if (rendering) return 'stop';
  return isRecord(shot.output) && shot.output.status === 'running' ? 'wait' : null;
}

/** GM's tooltip for a blocked ×: "Stop the run first.", or (GM PR #205 r1,
 * the lock pattern with the ×'s own verb) "You can remove “Shot 2” when it
 * finishes." */
export function shotRemovalBlockTitle(block: 'stop' | 'wait', shotName: string): string {
  return block === 'stop' ? 'Stop the run first.' : lockLine(`remove “${shotName}”`, { finishes: 'it' });
}

/** The shots of a scene a run is rendering that a change would take away:
 * their numbers as the rail shows them ("Shot 2"), and whether there is a
 * Stop for any of them. */
export interface RenderingShots { numbers: number[]; stoppable: boolean }

/** Which of `scene`'s shots are rendering and not in `kept` (every shot
 * when `kept` is omitted: the scene itself goes); null when none is. */
export function renderingShots(activeRuns: readonly ActiveRun[], nodeId: string, scene: unknown,
  sceneState?: NodeState, kept?: ReadonlySet<string>): RenderingShots | null {
  const shots = isRecord(scene) && Array.isArray(scene.shots) ? scene.shots : [];
  const numbers: number[] = [];
  let stoppable = false;
  shots.forEach((shot, index) => {
    if (!isRecord(shot) || typeof shot.id !== 'string' || kept?.has(shot.id)) return;
    const block = shotRemovalBlock(activeRuns, nodeId, shot as unknown as CinemaShot, sceneState);
    if (!block) return;
    numbers.push(index + 1);
    stoppable = stoppable || block === 'stop';
  });
  return numbers.length > 0 ? { numbers, stoppable } : null;
}

const STOP_FIRST = 'Stop the run first.';
const WAIT_FOR_IT = 'Wait for it to finish.';

/** “Shot 2”, “Shot 2” and “Shot 3”, or "4 shots" (GM, PR #198 r3), and
 * whether that is more than one. */
function shotList(numbers: readonly number[]): { text: string; several: boolean } {
  const names = numbers.map((number) => `“Shot ${number}”`);
  if (names.length >= 4) return { text: `${names.length} shots`, several: true };
  const text = names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return { text, several: names.length > 1 };
}

/** GM, PR #198 r3 item 3: an undo or redo that would remove a shot still
 * rendering, refused before it is sent. "Couldn’t undo. It would remove
 * “Shot 2”, which is still running. Stop the run first." ("Couldn't redo.
 * …"; "…Wait for it to finish." with no Stop). Never the run id. Several
 * shots are builder's, on GM's pattern. The backend's 409 says the same
 * (main.py _removal_person_line). */
export function renderingRemovalLine(action: 'undo' | 'redo', shots: RenderingShots): string {
  const { text, several } = shotList(shots.numbers);
  const end = shots.stoppable ? STOP_FIRST : WAIT_FOR_IT;
  if (shots.numbers.length >= 4) return `Couldn’t ${action}. It would remove ${text} that are still running. ${end}`;
  return `Couldn’t ${action}. It would remove ${text}, which ${several ? 'are' : 'is'} still running. ${end}`;
}

/** GM, PR #198 r4 item 3: the Delete over several scenes with shots
 * rendering: "Stop the runs first." with a Stop control, else (GM PR #205
 * r1) "You can delete them when the running shots finish." */
export function scenesDeleteBlockTitle(stoppable: boolean): string {
  return stoppable ? 'Stop the runs first.' : lockLine(RUN_LOCK_VERBS.deleteThem, 'runningShots');
}

/** GM, PR #205 r1 answer 2: a refusal after a key press is the lock line
 * alone (the thing is plainly still there): "You can delete “X” when the run
 * finishes." (several named by the shared name-list rule, "the node" with no
 * name, "3 nodes" with no names), "You can undo when the run finishes.",
 * "You can redo when the run finishes." Cmd+D and Cmd+V the same (GM PR #205 r2 item 4). */
export function runLockedLine(action: 'delete' | 'duplicate' | 'undo' | 'redo' | 'paste', count = 1, name?: string,
  names?: readonly string[]): string {
  // GM PR #205 r2 item 4: Cmd+D says "You can duplicate “X” when the run
  // finishes." as Delete does, and Cmd+V "You can paste when the run finishes."
  if (action !== 'delete' && action !== 'duplicate') return runFinishesLine(RUN_LOCK_VERBS[action]);
  // GM r6: several nodes are named, up to 3, grouped by title, counted from 4.
  const what = names && names.length > 1 ? nodeNameList([...names]) : count === 1 ? name ?? 'the node' : `${count} nodes`;
  return runFinishesLine(`${action} ${what}`);
}

/** The run lock over a selection of only wires (PR #198 review 5, N1): the
 * Delete key is off during the run, and never silently. GM PR #205 r1: "You
 * can delete the connection when the run finishes." ("the 2 connections"). */
export function runLockedWiresLine(count: number): string {
  return runFinishesLine(`delete ${count === 1 ? 'the connection' : `the ${count} connections`}`);
}

/** GM, PR #198 r3 item 1: the scene's Delete, disabled while a shot
 * renders: "Stop the run first." with a Stop control, else (GM PR #205 r1's
 * pattern, the Delete's own verb) "You can delete “Scene” when it
 * finishes." */
export function sceneDeleteBlockTitle(scene: string, shots: RenderingShots): string {
  return shots.stoppable ? STOP_FIRST : lockLine(`delete “${scene}”`, { finishes: 'it' });
}

/** GM, PR #198 r3 item 1: a refused delete (the Delete key, the context
 * menu, a refused request): "Couldn't delete “Scene”. “Shot 2” is still
 * running. Stop the run first." ("…Wait for it to finish." with no Stop);
 * "“Shot 2” and “Shot 3” are still running."; "4 shots are still running." */
export function sceneDeleteRefusedLine(scene: string, shots: RenderingShots): string {
  const { text, several } = shotList(shots.numbers);
  return `Couldn’t delete “${scene}”. ${text} ${several ? 'are' : 'is'} still running. ${shots.stoppable ? STOP_FIRST : WAIT_FOR_IT}`;
}

/** GM, PR #198 r3 item 1, a multi-select delete that keeps the scene: the
 * rest is deleted and the line goes after "Deleted 3 nodes.": "“Scene”
 * wasn't deleted because “Shot 2” is still running." Two or three scenes
 * (GM r4 item 2, approved after "Deleted 3 nodes."): "“A” and “B” weren't
 * deleted because their shots are still running."; four or more: "4 scenes
 * weren't deleted because their shots are still running." */
export function scenesKeptLine(kept: readonly { scene: string; shots: RenderingShots }[]): string {
  if (kept.length === 1) {
    const { text, several } = shotList(kept[0].shots.numbers);
    return `“${kept[0].scene}” wasn’t deleted because ${text} ${several ? 'are' : 'is'} still running.`;
  }
  if (kept.length >= 4) return `${kept.length} scenes weren’t deleted because their shots are still running.`;
  // GM r6: same titles grouped with a count ("2 “Scene” nodes").
  return `${nodeNameList(kept.map((item) => item.scene))} weren’t deleted because their shots are still running.`;
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
