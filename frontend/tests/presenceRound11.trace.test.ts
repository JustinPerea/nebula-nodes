/**
 * PR #204 round 11 (review 9 gates-trace LOW-2, LOW-3, NIT-1; lock-sweep LOW-3): the trace
 * (tests/personGatedCallers.ts), in synthetic sources.
 * - LOW-2: a helper's call inside a longer path (`${base(s)}/${id}/dismiss`, `base(s) + '/read'`)
 *   is read with the rest of it, each of the helper's paths in its place: the route is the whole
 *   path's, never the helper's bare one.
 * - LOW-3: an imported const held in a local, a namespace member (`paths.X`), a parameter
 *   wrapper (`const post = (u) => apiFetch(u, …)`) and an imported '/api' prefix are each read;
 *   what can't be read is listed with its reason (a `let` of an imported path, '/api' joined to
 *   a name it can't read, a wrapper that reads the answer itself).
 * - NIT-1: a self-referential const no longer overflows the stack.
 * - T1 (localConst innermost-only): a const in a block around the try's block is found (P1).
 * - lock-sweep LOW-3: lockReach walks from a sender to every control that reaches it, and says
 *   how each is locked; a second, unlocked control is caught wherever it is.
 * Each probe sends POST /api/presets, then `if (!res.ok) setLine(await res.text())` with no marker
 * inside a try whose catch registers: read right, the call drops ('drops'). None may keep.
 */
import { describe, expect, it } from 'vitest';
import { callersOf, lockReach, untracedApiText, withSources } from './personGatedCallers';

const PRESETS = { method: 'POST', path: '/api/presets' };
const GO = 'components/C.tsx#go';
const DROPS = { found: { [GO]: 'drops' }, untraced: [] as string[] };
const dropBody = (pre: string, inner: string, outer = '') => `${pre}
export function Panel({ setLine, show }: any) {
  ${outer}
  const go = async () => {
    try {
      ${inner}
      if (!res.ok) setLine(await res.text());
    } catch (e) { show(String(e)); } // clears-on-promote: zz.lost
  };
  return go;
}`;
const SEND = "const res = await apiFetch(u, { method: 'POST' });";
const C = (source: string, more: Record<string, string> = {}) => ({ 'components/C.tsx': source, ...more });
const PATHS = { 'lib/paths.ts': "export const PRESETS_PATH = '/api/presets';" };
const PREFIX = { 'lib/paths.ts': "export const API = '/api';" };

interface Probe { files: Record<string, string>; found: Record<string, string>; untraced: string[]; route?: { method: string; path: string } }
const PROBES: Record<string, Probe> = {
  // ---- LOW-3: imported and namespaced consts ----
  P4b_imported_const_in_a_local: { files: C(dropBody("import { PRESETS_PATH } from '../lib/paths';", `const u = PRESETS_PATH; ${SEND}`), PATHS), ...DROPS },
  P4b2_imported_const_aliased: { files: C(dropBody("import { PRESETS_PATH as P } from '../lib/paths';", `const u = P; ${SEND}`), PATHS), ...DROPS },
  P4b3_imported_through_a_reexport: { files: C(dropBody("import { PRESETS_PATH } from '../lib/index';", `const u = PRESETS_PATH; ${SEND}`),
    { ...PATHS, 'lib/index.ts': "export { PRESETS_PATH } from './paths';" }), ...DROPS },
  P4d_namespace_member: { files: C(dropBody("import * as paths from '../lib/paths';", "const res = await apiFetch(paths.PRESETS_PATH, { method: 'POST' });"), PATHS), ...DROPS },
  P4d2_namespace_member_in_a_local: { files: C(dropBody("import * as paths from '../lib/paths';", `const u = paths.PRESETS_PATH; ${SEND}`), PATHS), ...DROPS },
  P4c_imported_api_prefix_in_a_template: { files: C(dropBody("import { API } from '../lib/paths';", `const u = \`\${API}/presets\`; ${SEND}`), PREFIX), ...DROPS },
  // Fail closed, with the reason.
  U7_imported_const_in_a_let: { files: C(dropBody("import { PRESETS_PATH } from '../lib/paths';", `let u = PRESETS_PATH; ${SEND}`), PATHS),
    found: {}, untraced: ["components/C.tsx:6 /api/presets (a path const held in a name or object the trace doesn't read)"] },
  U8_imported_api_prefix_joined_to_a_name: { files: C(dropBody("import { API } from '../lib/paths';", "const res = await apiFetch(API + show.tail, { method: 'POST' });"), PREFIX),
    // Listed twice, both closed: the joined text, and the prefix const at that use.
    found: {}, untraced: ["components/C.tsx:6 /api${…} (the /api prefix joined where the trace can't read the path)",
      "components/C.tsx:6 /api (the /api prefix joined where the trace can't read the path)"] },
  U9_inline_api_prefix_joined_to_a_name: { files: C(dropBody('', "const res = await apiFetch('/api' + show.tail, { method: 'POST' });")),
    found: {}, untraced: ["components/C.tsx:6 /api${…} (the /api prefix joined where the trace can't read the path)"] },
  U10_local_api_prefix_used_unread: { files: C(dropBody('', "const b = '/api'; const res = await apiFetch(b + show.tail, { method: 'POST' });")),
    found: {}, untraced: ["components/C.tsx:6 /api (the /api prefix joined where the trace can't read the path)",
      "components/C.tsx:6 /api${…} (the /api prefix joined where the trace can't read the path)"] },
  // ---- LOW-3: a parameter wrapper ----
  P3e_arrow_wrapper: { files: C(dropBody('', "const post = (u: string) => apiFetch(u, { method: 'POST' }); const res = await post('/api/presets');")), ...DROPS },
  P3c_function_wrapper: { files: C(dropBody('', "function post(u: string) { return apiFetch(u, { method: 'POST' }); } const res = await post('/api/presets');")), ...DROPS },
  U11_wrapper_that_reads_the_answer: { files: C(dropBody('', "const post = async (u: string) => { const r = await apiFetch(u, { method: 'POST' }); show.log(r.status); return r; }; const res = await post('/api/presets');")),
    found: {}, untraced: ["components/C.tsx:6 /api/presets (handed to a function that sends it and reads the answer itself)"] },
  // ---- LOW-2: a helper composed with a tail ----
  P5c_helper_with_a_tail: { files: C(dropBody("function base(x: any) { return x ? '/api/presets' : `/api/boards/${x}/presets`; }", "const res = await apiFetch(`${base(show)}/${show.id}`, { method: 'POST' });")),
    route: { method: 'POST', path: '/api/presets/{preset_id}' }, ...DROPS },
  P5c_not_the_bare_route: { files: C(dropBody("function base(x: any) { return x ? '/api/presets' : `/api/boards/${x}/presets`; }", "const res = await apiFetch(`${base(show)}/${show.id}`, { method: 'POST' });")),
    found: {}, untraced: [] },
  P5e_helper_in_a_concat: { files: C(dropBody("const base = () => '/api/presets';", "const res = await apiFetch(base() + '/' + show.id, { method: 'POST' });")),
    route: { method: 'POST', path: '/api/presets/{preset_id}' }, ...DROPS },
  // ---- T1: a const outside the try's own block ----
  P1_const_in_an_outer_block: { files: C(dropBody('', SEND, "const u = '/api/presets';")), ...DROPS },
};

describe('round 11: review 9\'s trace forms, exact outcomes (LOW-2, LOW-3, T1)', () => {
  for (const [name, { files, found, untraced, route = PRESETS }] of Object.entries(PROBES)) {
    it(name, { timeout: 30_000 }, () => {
      const units = withSources(files, () => callersOf(route));
      const listed = withSources(files, () => untracedApiText());
      expect({ found: Object.fromEntries([...units].map(([id, unit]) => [id, unit.outcome])), untraced: listed.map((l) => `${l.file}:${l.line} ${l.text} (${l.reason})`) })
        .toEqual({ found, untraced });
    });
  }
  it('NIT-1: a self-referential const doesn\'t overflow the stack', { timeout: 30_000 }, () => {
    const files = C(dropBody('', "const u = `${u}/api/presets`; const res = await apiFetch(u, { method: 'POST' });"));
    expect(() => withSources(files, () => untracedApiText())).not.toThrow();
    const units = withSources(files, () => callersOf(PRESETS));
    expect(Object.fromEntries([...units].map(([id, unit]) => [id, unit.outcome]))).toEqual({ [GO]: 'drops' });
  });
});

// ---- LOW-2: lib/agentNotes' exact shape ----
const NOTES_LIB = `import { apiRequest } from './api';
function base(surface: any): string {
  return surface.kind === 'canvas'
    ? '/api/canvas/agent-notes'
    : \`/api/moodboards/\${encodeURIComponent(surface.boardId)}/agent-notes\`;
}
export async function dismissAgentNote(surface: any, id: string) {
  const response = await apiRequest("Couldn't dismiss the update.", \`\${base(surface)}/\${encodeURIComponent(id)}/dismiss\`, { method: 'POST' });
  return response.json();
}
export async function markRead(surface: any) {
  await apiRequest("Couldn't mark them read.", base(surface) + '/read', { method: 'POST' });
}`;
const NOTES = {
  'lib/agentNotes.ts': NOTES_LIB,
  'components/NewButton.tsx': `import { dismissAgentNote, markRead } from '../lib/agentNotes';
export function NewButton({ s, id }: any) { return <button onClick={() => { void dismissAgentNote(s, id); void markRead(s); }}>Dismiss</button>; }`,
};
describe('round 11: a helper\'s path with a tail is the whole path (review 9 LOW-2)', () => {
  const traced = (route: { method: string; path: string }) => withSources(NOTES, () => [...callersOf(route).keys()]);
  it('the composed routes trace to the control, both surfaces', { timeout: 30_000 }, () => {
    for (const path of ['/api/canvas/agent-notes/{note_id}/dismiss', '/api/moodboards/{moodboard_id}/agent-notes/{note_id}/dismiss',
      '/api/canvas/agent-notes/read', '/api/moodboards/{moodboard_id}/agent-notes/read']) {
      expect(traced({ method: 'POST', path }), path).toEqual(['components/NewButton.tsx#NewButton']);
    }
  });
  it('and never the helper\'s bare path', { timeout: 30_000 }, () => {
    expect(traced({ method: 'POST', path: '/api/canvas/agent-notes' })).toEqual([]);
    expect(withSources(NOTES, () => untracedApiText())).toEqual([]);
  });
});

// ---- lock-sweep LOW-3: from a sender to its controls ----
const SENDER = {
  'lib/keys.ts': "export async function removeKey(p: string) { await apiRequest(\"Couldn't remove.\", `/api/settings/api-keys/${p}`, { method: 'DELETE' }); }",
  'components/usePersonLock.ts': 'export function usePersonLock(verb: string): any { return verb; }',
};
const KEYS = { method: 'DELETE', path: '/api/settings/api-keys/{provider}' };
const HOST = (body: string) => `import { removeKey } from '../lib/keys';
import { usePersonLock } from './usePersonLock';
export function Host({ p }: any) {
  const lock = usePersonLock('change provider settings');
  ${body}
}`;
/** The controls that reach removeKey, each `file:line attribute locked-by` (or `OPEN`). */
const byLine = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
function controls(sources: Record<string, string>): { sites: string[]; open: string[]; held: string[] } {
  return withSources({ ...SENDER, ...sources }, () => {
    const points = [...callersOf(KEYS)].flatMap(([, unit]) => (unit.points ?? [unit.node]).map((node) => ({ file: unit.file, node })));
    const reach = lockReach(points);
    return {
      sites: reach.sites.map((s) => `${s.file}:${s.line} <${s.tag}> ${s.attribute} ${s.locked ?? 'OPEN'}`).sort(byLine),
      open: reach.open.map((o) => o.at),
      held: reach.held.map((h) => `${h.at} ${h.locked}`).sort(byLine),
    };
  });
}
describe('round 11: lockReach reaches each control and reads its lock (lock-sweep LOW-3)', () => {
  it('a guard, a control spread and a disabled read are each a lock; an early return holds the way', { timeout: 30_000 }, () => {
    const reach = controls({ 'components/Host.tsx': HOST(`const undo = () => { if (lock.locked) return; void removeKey(p); };
  return <div>
    <button onClick={lock.guard(() => removeKey(p))}>A</button>
    <button onClick={undo}>B</button>
    <button {...lock.control()} onClick={() => removeKey(p)}>C</button>
    <button disabled={lock.locked} onClick={() => removeKey(p)}>D</button>
  </div>;`) });
    expect(reach.sites).toEqual([
      'components/Host.tsx:7 <button> onClick lock.guard',
      'components/Host.tsx:9 <button> onClick lock.control()',
      'components/Host.tsx:10 <button> onClick disabled={lock.locked}',
    ]);
    // The early return locks `undo` itself, so whatever control reaches it is locked.
    expect(reach.held).toEqual(['components/Host.tsx:5 lock.locked return']);
    expect(reach.open).toEqual([]);
  });
  it('a second control in another file that reaches the same helper unlocked is caught (SettingsNoticeBar\'s Undo)', { timeout: 30_000 }, () => {
    const { sites } = controls({
      'components/Host.tsx': HOST('return <button {...lock.control()} onClick={lock.guard(() => removeKey(p))}>Remove</button>;'),
      'lib/undo.ts': "import { removeKey } from './keys';\nexport function undoAddedKey(p: string) { return removeKey(p); }",
      'components/Notice.tsx': "import { undoAddedKey } from '../lib/undo';\nexport function Notice({ p }: any) { return <button onClick={() => undoAddedKey(p)}>Undo</button>; }",
    });
    expect(sites).toEqual(['components/Host.tsx:5 <button> onClick lock.guard', 'components/Notice.tsx:2 <button> onClick OPEN']);
  });
  it('a handler handed to a component is followed into it, and a lock prop counts there', { timeout: 30_000 }, () => {
    const row = `export function Row({ onRemove, lock }: any) {
  return <span>
    <button {...lock.control()} onClick={onRemove}>x</button>
    <button onClick={() => onRemove()}>y</button>
  </span>;
}`;
    expect(controls({ 'components/Host.tsx': `import { Row } from './Row';\n${HOST('return <Row lock={lock} onRemove={() => removeKey(p)} />;')}`, 'components/Row.tsx': row }).sites)
      .toEqual(['components/Row.tsx:3 <button> onClick lock.control()', 'components/Row.tsx:4 <button> onClick OPEN']);
  });
  it('a hook\'s returned member is followed to the controls that read it', { timeout: 30_000 }, () => {
    const hook = "import { removeKey } from '../lib/keys';\nexport function useKeys(p: string) { return { remove: () => removeKey(p), p }; }";
    const panel = `import { useKeys } from './useKeys';\nimport { usePersonLock } from './usePersonLock';
export function Panel({ p }: any) {
  const keys = useKeys(p);
  const lock = usePersonLock('change provider settings');
  return <div>
    <button onClick={lock.guard(keys.remove)}>ok</button>
    <button onClick={keys.remove}>bad</button>
  </div>;
}`;
    expect(controls({ 'components/useKeys.ts': hook, 'components/Panel.tsx': panel }).sites)
      .toEqual(['components/Panel.tsx:7 <button> onClick lock.guard', 'components/Panel.tsx:8 <button> onClick OPEN']);
  });
  it('a hook\'s returned shorthand member (`{ remove }`) is followed too', { timeout: 30_000 }, () => {
    // The hook sends itself, so its `remove` is the sending unit and the member is what's followed.
    const hook = "export function useKeys(p: string, show: any) {\n  const remove = async () => { try { await apiRequest('x', `/api/settings/api-keys/${p}`, { method: 'DELETE' }); } catch (e) { show(e); } };\n  return { remove, p };\n}";
    const panel = `import { useKeys } from './useKeys';\nimport { usePersonLock } from './usePersonLock';
export function Panel({ p }: any) {
  const { remove } = useKeys(p, null);
  const lock = usePersonLock('change provider settings');
  return <div>
    <button onClick={lock.guard(remove)}>ok</button>
    <button onClick={remove}>bad</button>
  </div>;
}`;
    expect(controls({ 'components/useKeys.ts': hook, 'components/Panel.tsx': panel }).sites)
      .toEqual(['components/Panel.tsx:7 <button> onClick lock.guard', 'components/Panel.tsx:8 <button> onClick OPEN']);
  });
  it('a sender that settles its own answer is followed into the files that import it', { timeout: 30_000 }, () => {
    const { sites } = controls({
      'lib/keys.ts': "export async function removeKey(p: string, show: any) { try { await apiRequest('x', `/api/settings/api-keys/${p}`, { method: 'DELETE' }); } catch (e) { show(e); } }",
      'components/Host.tsx': HOST('return <button onClick={lock.guard(() => removeKey(p, null))}>Remove</button>;'),
      'components/Other.tsx': "import { removeKey as drop } from '../lib/keys';\nexport function Other({ p }: any) { return <button onClick={() => drop(p, null)}>Undo</button>; }",
    });
    expect(sites).toEqual(['components/Host.tsx:5 <button> onClick lock.guard', 'components/Other.tsx:2 <button> onClick OPEN']);
  });
  it('a lock taken while a condition holds counts only paired with a guard on the same side (DeferredRunNotice\'s Run)', { timeout: 30_000 }, () => {
    const host = (spread: string, handler: string) => controls({ 'components/Host.tsx': HOST(`const other = usePersonLock('x');
  return <button {...${spread}} onClick={${handler}}>Run</button>;`) }).sites
      .map((site) => site.endsWith(' OPEN') ? site : site.replace(/onClick .*$/, 'onClick locked'));
    // The guarded side reads as the guard and the other side as the pairing, whichever is merged
    // first; an unlocked way to a site wins the merge, so without the pairing it reads OPEN.
    expect(host('(gone ? lock.control() : {})', 'gone ? lock.guard(() => removeKey(p)) : () => void removeKey(p)'))
      .toEqual(['components/Host.tsx:6 <button> onClick locked']);
    expect(host('(gone ? {} : lock.control())', 'gone ? () => void removeKey(p) : lock.guard(() => removeKey(p))'))
      .toEqual(['components/Host.tsx:6 <button> onClick locked']);
    // Not paired: another condition, the guard on the other side, another lock, no guard.
    for (const [spread, handler] of [
      ['(gone ? lock.control() : {})', 'left ? lock.guard(() => removeKey(p)) : () => void removeKey(p)'],
      ['(gone ? lock.control() : {})', 'gone ? () => void removeKey(p) : lock.guard(() => removeKey(p))'],
      ['(gone ? lock.control() : {})', 'gone ? other.guard(() => removeKey(p)) : () => void removeKey(p)'],
      ['(gone ? lock.control() : {})', '() => void removeKey(p)'],
    ]) expect(host(spread, handler), `${spread} ${handler}`).toEqual(['components/Host.tsx:6 <button> onClick OPEN']);
  });
  it('a send from an effect is open: no control, and no lock on the way', { timeout: 30_000 }, () => {
    expect(controls({ 'components/Host.tsx': HOST('useEffect(() => { void removeKey(p); }, []);\n  return null;') }).open).toEqual(['components/Host.tsx#Host']);
  });
  it('work held for the promote is locked on the way', { timeout: 30_000 }, () => {
    const host = HOST('return <button onClick={() => whenPerson(\'k\', () => void removeKey(p))}>x</button>;');
    expect(controls({ 'components/Host.tsx': host }).sites).toEqual(['components/Host.tsx:5 <button> onClick whenPerson()']);
  });
});
