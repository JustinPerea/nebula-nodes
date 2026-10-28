import type { CinemaSceneSpec, CinemaShot } from '../types';

/**
 * PR #198 review 6, H2 (GM r9 decision 2, option b): a scene the person has
 * edits for that changed somewhere else (an agent, another window) is
 * rebased, never overwritten. A three-way merge per field: `base` is the
 * scene the person's edits started from, `mine` what the card shows,
 * `theirs` what Nebula has now.
 * - A field only one side changed takes that side's value.
 * - A field both changed to different values is a clash: the result keeps
 *   mine (the card goes on showing it) and the clash is listed.
 * - Shots added on either side stay. A shot the other side removed goes,
 *   unless the person changed it (a clash on the shot itself). A shot the
 *   person removed stays removed, unless the other side changed it since
 *   (it comes back, as `back`).
 * - The shots' order: a side that kept the base's order takes the other's.
 * A shot's runtime (output, variations, selectedVariation) is never merged
 * here: the canvas reads it from the sync as before.
 */

/** One authored field: a scene field (`shot` null), the shot order
 * (ORDER), a shot's presence (PRESENCE), or a field of one shot. */
export interface SceneField { shot: string | null; key: string }
export const ORDER = '#order';
export const PRESENCE = '#shot';
const RUNTIME = new Set(['output', 'variations', 'selectedVariation']);

type Same = (a: unknown, b: unknown) => boolean;
type Shot = CinemaShot & Record<string, unknown>;

export interface SceneMerge {
  scene: CinemaSceneSpec;
  clashes: SceneField[];
  /** Shots the person removed that the other side changed since: back in `scene`. */
  back: string[];
}

const authoredKeys = (...shots: (Shot | undefined)[]) =>
  [...new Set(shots.flatMap((shot) => (shot ? Object.keys(shot) : [])))].filter((key) => !RUNTIME.has(key) && key !== 'id');
const authored = (shot: Shot) => Object.fromEntries(Object.entries(shot).filter(([key]) => !RUNTIME.has(key)));
const sceneKeys = (...scenes: CinemaSceneSpec[]) =>
  [...new Set(scenes.flatMap((scene) => Object.keys(scene)))].filter((key) => key !== 'shots');
const byId = (scene: CinemaSceneSpec) => new Map(scene.shots.map((shot) => [shot.id, shot as Shot]));

function setField(target: Record<string, unknown>, key: string, from: Record<string, unknown> | undefined): void {
  if (from && key in from) target[key] = structuredCloneJson(from[key]);
  else delete target[key];
}
function structuredCloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

/** `ids` in `order`'s sequence, then the rest of `ids` as they came. */
function inOrder(ids: string[], order: string[]): string[] {
  const set = new Set(ids);
  const known = order.filter((id) => set.has(id));
  return [...known, ...ids.filter((id) => !known.includes(id))];
}

/** `skeleton` (ids in one side's order) with `extra` ids placed after their
 * nearest predecessor in `extraOrder` (the side that has them). */
function placeAfter(skeleton: string[], extra: string[], extraOrder: string[]): string[] {
  const out = [...skeleton];
  for (const id of extraOrder.filter((candidate) => extra.includes(candidate))) {
    if (out.includes(id)) continue;
    const before = extraOrder.slice(0, extraOrder.indexOf(id)).reverse().find((candidate) => out.includes(candidate));
    out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, id);
  }
  return out;
}

export function mergeScenes(base: CinemaSceneSpec, mine: CinemaSceneSpec, theirs: CinemaSceneSpec, same: Same): SceneMerge {
  const clashes: SceneField[] = [];
  const back: string[] = [];
  const result: Record<string, unknown> = { ...mine };
  for (const key of sceneKeys(base, mine, theirs)) {
    const [b, m, t] = [(base as never)[key], (mine as never)[key], (theirs as never)[key]];
    if (same(m, b)) setField(result, key, theirs as never);
    else if (!same(t, b) && !same(m, t)) clashes.push({ shot: null, key });
  }
  const [B, M, T] = [byId(base), byId(mine), byId(theirs)];
  const shots = new Map<string, Shot>();
  for (const id of new Set([...M.keys(), ...T.keys()])) {
    const [b, m, t] = [B.get(id), M.get(id), T.get(id)];
    if (m && t) {
      const shot: Shot = { ...m };
      for (const key of authoredKeys(b, m, t)) {
        const [bv, mv, tv] = [b?.[key], m[key], t[key]];
        if (b ? same(mv, bv) : same(mv, tv)) setField(shot, key, t);
        else if ((!b || !same(tv, bv)) && !same(mv, tv)) clashes.push({ shot: id, key });
      }
      shots.set(id, shot);
    } else if (m) {
      // Theirs removed it: it goes, unless the person changed it.
      if (!b) shots.set(id, m);
      else if (!same(authored(m), authored(b))) { shots.set(id, m); clashes.push({ shot: id, key: PRESENCE }); }
    } else if (t) {
      // Mine removed it (or theirs added it): back only if they changed it.
      if (!b) shots.set(id, t);
      else if (!same(authored(t), authored(b))) { shots.set(id, t); back.push(id); }
    }
  }
  const order = (scene: CinemaSceneSpec) => scene.shots.map((shot) => shot.id);
  const inAll = order(base).filter((id) => M.has(id) && T.has(id));
  const [bo, mo, to] = [inOrder(inAll, order(base)), inOrder(inAll, order(mine)), inOrder(inAll, order(theirs))];
  const kept = [...shots.keys()];
  let ids: string[];
  if (same(mo, bo)) {
    const skeleton = order(theirs).filter((id) => shots.has(id));
    ids = placeAfter(skeleton, kept.filter((id) => !skeleton.includes(id)), order(mine));
  } else {
    if (!same(to, bo) && !same(mo, to)) clashes.push({ shot: null, key: ORDER });
    const skeleton = order(mine).filter((id) => shots.has(id));
    ids = placeAfter(skeleton, kept.filter((id) => !skeleton.includes(id)), order(theirs));
  }
  result.shots = ids.map((id) => shots.get(id)!);
  return { scene: result as unknown as CinemaSceneSpec, clashes, back };
}

const sameField = (a: SceneField, b: SceneField) => a.shot === b.shot && a.key === b.key;

/** `target` with `fields` as `source` has them (the backend's values for a
 * save that waits for the person's choice, or the person's for the card). */
export function withFields(target: CinemaSceneSpec, fields: readonly SceneField[], source: CinemaSceneSpec): CinemaSceneSpec {
  const out = { ...target, shots: target.shots.map((shot) => ({ ...shot })) } as CinemaSceneSpec & Record<string, unknown>;
  const S = byId(source);
  for (const field of fields) {
    if (field.shot === null && field.key === ORDER) {
      const common = out.shots.filter((shot) => S.has(shot.id)).map((shot) => shot.id);
      const sorted = inOrder(common, source.shots.map((shot) => shot.id));
      let next = 0;
      out.shots = out.shots.map((shot) => (S.has(shot.id) ? out.shots.find((candidate) => candidate.id === sorted[next++])! : shot));
    } else if (field.shot === null) {
      setField(out, field.key, source as never);
    } else if (field.key === PRESENCE) {
      const has = out.shots.some((shot) => shot.id === field.shot);
      const from = S.get(field.shot);
      if (has && !from) out.shots = out.shots.filter((shot) => shot.id !== field.shot);
      else if (!has && from) {
        const ids = placeAfter(out.shots.map((shot) => shot.id), [field.shot], source.shots.map((shot) => shot.id));
        out.shots = ids.map((id) => out.shots.find((shot) => shot.id === id) ?? structuredCloneJson(from));
      }
    } else {
      const shot = out.shots.find((candidate) => candidate.id === field.shot) as Shot | undefined;
      if (shot) setField(shot, field.key, S.get(field.shot));
    }
  }
  return out;
}

/** The fields of `fields` that `a` and `b` still disagree on. */
export function stillClashing(fields: readonly SceneField[], a: CinemaSceneSpec, b: CinemaSceneSpec, same: Same): SceneField[] {
  return fields.filter((field) => !same(withFields(a, [field], b), a));
}

/** `a` and `b` together, each field once. */
export function unionFields(a: readonly SceneField[], b: readonly SceneField[]): SceneField[] {
  return [...a, ...b.filter((field) => !a.some((candidate) => sameField(candidate, field)))];
}
