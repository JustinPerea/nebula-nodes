import { describe, expect, it } from 'vitest';
import { mergeScenes, withFields, ORDER, PRESENCE, WHOLE } from '../../src/lib/cinemaSceneMerge';

/**
 * PR #198 fix round 8, H1 (review 7): the ORDER branch of withFields moved
 * its index inside find's callback and emptied every shot. Review 7's
 * property fuzz, kept as a test, with reorders on both sides; and the cases
 * it found, by name.
 */
type Shot = { id: string; prompt?: string; refs?: string[]; output?: unknown };
type Scene = { version: number; aspectRatio: string; shots: Shot[] };
const canon = (v: unknown): string => JSON.stringify(v, (_k, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));
const same = (a: unknown, b: unknown) => canon(a) === canon(b);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const authored = (s: Scene) => ({ ...s, shots: s.shots.map((shot) => { const rest = { ...shot }; delete rest.output; return rest; }) });

function rng(seed: number) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const PROMPTS = ['p0', 'p1', 'p2', 'p3'];
function mutate(r: () => number, scene: Scene, side: string, counter: { n: number }, collide: boolean): Scene {
  const out = clone(scene);
  const ops = 1 + Math.floor(r() * 3);
  for (let i = 0; i < ops; i += 1) {
    const op = Math.floor(r() * 6);
    if (op === 0 && out.shots.length) { const s = out.shots[Math.floor(r() * out.shots.length)]; s.prompt = PROMPTS[Math.floor(r() * 4)]; }
    else if (op === 1) out.shots.splice(Math.floor(r() * (out.shots.length + 1)), 0, { id: collide && r() < 0.3 ? 'x1' : `${side}${counter.n++}`, prompt: PROMPTS[Math.floor(r() * 4)] });
    else if (op === 2 && out.shots.length) out.shots.splice(Math.floor(r() * out.shots.length), 1);
    else if (op === 3 && out.shots.length > 1) { const a = Math.floor(r() * out.shots.length); const b = Math.floor(r() * out.shots.length); [out.shots[a], out.shots[b]] = [out.shots[b], out.shots[a]]; }
    else if (op === 4) out.aspectRatio = r() < 0.5 ? '9:16' : '1:1';
    else if (op === 5 && out.shots.length) { const s = out.shots[Math.floor(r() * out.shots.length)]; s.refs = [PROMPTS[Math.floor(r() * 4)]]; }
  }
  // dedupe ids (a collide may add x1 twice on one side)
  const seen = new Set<string>(); out.shots = out.shots.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  return out;
}

describe('mergeScenes: a property fuzz with reorders (review 7 H1, I6)', () => {
  it('20000 seeds: no invariant fails, no empty shot, Use theirs leaves no clash', () => {
    const fails: Record<string, { seed: number; base: Scene; mine: Scene; theirs: Scene; result: unknown; clashes: unknown; back: unknown }[]> = {};
    const fail = (k: string, d: (typeof fails)[string][number]) => { if ((fails[k] ??= []).length < 3) fails[k].push(d); };
    const counts: Record<string, number> = {};
    const count = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
    for (let seed = 1; seed <= 20000; seed += 1) {
      const r = rng(seed);
      const n = 1 + Math.floor(r() * 4);
      const base: Scene = { version: 1, aspectRatio: '16:9', shots: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, prompt: PROMPTS[Math.floor(r() * 4)] })) };
      const collide = seed % 7 === 0;
      const counter = { n: 1 };
      const mine = r() < 0.15 ? clone(base) : mutate(r, base, 'm', counter, collide);
      const theirs = r() < 0.15 ? clone(base) : mutate(r, base, 't', counter, collide);
      const m = mergeScenes(base as never, mine as never, theirs as never, same);
      const res = m.scene as unknown as Scene;
      const d = { seed, base, mine, theirs, result: res, clashes: m.clashes, back: m.back };
      const ids = res.shots.map((s) => s.id);
      if (new Set(ids).size !== ids.length) fail('I3 duplicate ids', d);
      if (same(authored(mine), authored(base)) && (!same(authored(res), authored(theirs)) || m.clashes.length)) fail('I1 mine==base => theirs', d);
      if (same(authored(theirs), authored(base)) && (!same(authored(res), authored(mine)) || m.clashes.length)) fail('I2 theirs==base => mine', d);
      if (same(authored(theirs), authored(mine)) && (!same(authored(res), authored(mine)) || m.clashes.length)) fail('I2b mine==theirs => that, no clash', d);
      const B = new Set(base.shots.map((s) => s.id));
      for (const s of theirs.shots) if (!B.has(s.id) && !ids.includes(s.id)) fail('I4 a shot theirs added is lost', d);
      for (const s of mine.shots) if (!B.has(s.id) && !ids.includes(s.id)) fail('I4 a shot mine added is lost', d);
      // Both added the same id with different content: kept as one (a clash), the other side's shot is gone either way.
      for (const s of mine.shots) {
        const t = theirs.shots.find((x) => x.id === s.id);
        if (!B.has(s.id) && t && !same(s, t)) { count('same new id on both sides'); }
      }
      // I5 per-field one-sided changes
      for (const s of res.shots) {
        const b = base.shots.find((x) => x.id === s.id); const mm = mine.shots.find((x) => x.id === s.id); const tt = theirs.shots.find((x) => x.id === s.id);
        if (!b || !mm || !tt) continue;
        for (const key of ['prompt', 'refs'] as const) {
          const clashed = m.clashes.some((c: { shot: string | null; key: string }) => c.shot === s.id && c.key === key);
          if (same(mm[key], b[key]) && !same(s[key], tt[key])) fail(`I5 only theirs changed ${key}, result differs`, d);
          if (same(tt[key], b[key]) && !same(s[key], mm[key])) fail(`I5 only mine changed ${key}, result differs`, d);
          if (!same(mm[key], b[key]) && !same(tt[key], b[key]) && !same(mm[key], tt[key]) && !clashed) fail(`I5 both changed ${key}, no clash`, d);
        }
      }
      // I8 removals
      for (const b of base.shots) {
        const inM = mine.shots.find((x) => x.id === b.id); const inT = theirs.shots.find((x) => x.id === b.id);
        if (!inM && !inT && ids.includes(b.id)) fail('I8 removed by both, still there', d);
        if (!inT && inM && same(inM, b) && ids.includes(b.id)) fail('I8 theirs removed, mine untouched, still there', d);
        if (!inM && inT && same(inT, b) && ids.includes(b.id)) fail('I8 mine removed, theirs untouched, still there', d);
      }
      // I7 order: neither reordered => base's relative order kept
      const rel = (s: Scene) => s.shots.map((x) => x.id).filter((id) => B.has(id) && ids.includes(id) && mine.shots.some((y) => y.id === id) && theirs.shots.some((y) => y.id === id));
      const bo = rel(base);
      if (same(rel(mine), bo) && same(rel(theirs), bo) && !same(res.shots.map((x) => x.id).filter((id) => bo.includes(id)), bo)) fail('I7 order changed with no reorder', d);
      // I6: take theirs for the clashes, merge again against theirs: nothing left to clash
      const taken = withFields(res as never, m.clashes, theirs as never) as unknown as Scene;
      if (taken.shots.some((x) => !x)) { fail('W withFields(Use theirs) makes an undefined shot', { ...d, result: { res, taken } }); continue; }
      const keptProbe = withFields(res as never, m.clashes, mine as never) as unknown as Scene;
      if (keptProbe.shots.some((x) => !x)) { fail('W withFields(Keep mine) makes an undefined shot', { ...d, result: { res, keptProbe } }); continue; }
      const again = mergeScenes(theirs as never, taken as never, theirs as never, same);
      if (again.clashes.length) fail('I6 Use theirs leaves a clash', d);
      // "Use theirs": every clash field as theirs has it
      for (const c of m.clashes as { shot: string | null; key: string }[]) {
        count(`clash ${c.key === ORDER ? 'ORDER' : c.key === PRESENCE ? 'PRESENCE' : c.shot ? 'shot-field' : 'scene-field'}`);
        if (c.key === ORDER) {
          const common = taken.shots.map((x) => x.id).filter((id) => theirs.shots.some((y) => y.id === id));
          const tOrder = theirs.shots.map((x) => x.id).filter((id) => common.includes(id));
          if (!same(common, tOrder)) fail('I6b Use theirs ORDER not theirs', d);
        } else if (c.key === PRESENCE) {
          if (taken.shots.some((x) => x.id === c.shot) !== theirs.shots.some((x) => x.id === c.shot)) fail('I6b Use theirs PRESENCE not theirs', d);
        } else if (c.shot) {
          const a = taken.shots.find((x) => x.id === c.shot) as Record<string, unknown> | undefined; const t = theirs.shots.find((x) => x.id === c.shot) as Record<string, unknown> | undefined;
          if (a && t && !same(a[c.key], t[c.key])) fail('I6b Use theirs field not theirs', d);
        }
      }
      // "Keep mine": withFields(res, clashes, mine) must equal mine on those fields
      const kept = withFields(res as never, m.clashes, mine as never) as unknown as Scene;
      for (const c of m.clashes as { shot: string | null; key: string }[]) {
        if (c.key === PRESENCE && kept.shots.some((x) => x.id === c.shot) !== mine.shots.some((x) => x.id === c.shot)) fail('Keep mine PRESENCE not mine', d);
      }
      // Symmetry of clash detection (fields only)
      const m2 = mergeScenes(base as never, theirs as never, mine as never, same);
      const key = (cs: { shot: string | null; key: string }[]) => cs.filter((c) => c.key !== PRESENCE).map((c) => `${c.shot}/${c.key}`).sort().join(',');
      if (key(m.clashes) !== key(m2.clashes)) fail('S clash set not symmetric', d);
      count('cases');
    }
    expect(Object.fromEntries(Object.entries(fails).map(([k, v]) => [k, v[0]]))).toEqual({});
    // The fuzz reaches every kind of clash, order clashes included.
    expect(counts['clash ORDER'] ?? 0).toBeGreaterThan(0);
    expect(counts['clash PRESENCE'] ?? 0).toBeGreaterThan(50);
    // Review 8, N-4: 20000 seeds take seconds; under a loaded full run the
    // default 5 s ran out.
  }, 60_000);
});

describe('order clashes, by name (review 7 seed 8332)', () => {
  const scene = (...ids: string[]) => ({ version: 1, aspectRatio: '16:9', shots: ids.map((id) => ({ id, prompt: id })) });
  const base = scene('s1', 's2', 's3');
  const mine = scene('s2', 's1', 's3');
  const theirs = scene('s1', 's3', 's2');
  const ids = (s: { shots: { id: string }[] }) => s.shots.map((shot) => shot?.id ?? null);

  it('both reorder: one ORDER clash, the card keeps mine', () => {
    const m = mergeScenes(base as never, mine as never, theirs as never, same);
    expect(m.clashes).toEqual([{ shot: null, key: ORDER }]);
    expect(ids(m.scene)).toEqual(['s2', 's1', 's3']);
  });

  it('Use theirs takes their order, Keep mine keeps mine, never an empty shot', () => {
    const m = mergeScenes(base as never, mine as never, theirs as never, same);
    expect(ids(withFields(m.scene, m.clashes, theirs as never))).toEqual(['s1', 's3', 's2']);
    expect(ids(withFields(m.scene, m.clashes, mine as never))).toEqual(['s2', 's1', 's3']);
  });

  it('a shot only one side has keeps its slot when the order is taken', () => {
    const card = scene('s2', 'n1', 's1', 's3');
    expect(ids(withFields(card as never, [{ shot: null, key: ORDER }], theirs as never))).toEqual(['s1', 'n1', 's3', 's2']);
  });

  it('WHOLE takes the source as it is', () => {
    expect(withFields(mine as never, [{ shot: null, key: WHOLE }], theirs as never)).toEqual(theirs);
  });
});
