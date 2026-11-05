/**
 * PR #204 round 13 (review 10 held-calls LOW-3, NIT-4): the trace (tests/personGatedCallers.ts),
 * in synthetic sources.
 * - LOW-3: a path handed to a function that sends it is read as that function's request in three
 *   more forms: a module const handed to a same-file wrapper (`post(PRESETS)`), an imported
 *   wrapper (`import { post }`, an alias, a re-export, a namespace), and a wrapper held as an
 *   object's member (`http.post(…)`, same file or imported). A path helper's call handed to one
 *   is read the same way. A callee from the trace's own files that it can't read (a wrapper made
 *   by a call, an object spread from another) is listed with its reason, never decided by the
 *   catch around it.
 * - NIT-4: lockReach follows `export { saveIt as save } from './w'` to the control that calls
 *   `save`; without that walk the helper would be an open end.
 * Each probe sends POST /api/presets, then `if (!res.ok) setLine(await res.text())` with no
 * marker inside a try whose catch registers: read right, the call drops ('drops'). None may keep.
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
const C = (source: string, more: Record<string, string> = {}) => ({ 'components/C.tsx': source, ...more });
const POST = { 'lib/post.ts': "import { apiFetch } from './backend';\nexport const post = (u: string) => apiFetch(u, { method: 'POST' });" };
const HTTP = { 'lib/http.ts': "import { apiFetch } from './backend';\nexport const http = { post: (u: string) => apiFetch(u, { method: 'POST' }) };" };

interface Probe { files: Record<string, string>; found: Record<string, string>; untraced: string[] }
const PROBES: Record<string, Probe> = {
  // ---- a module const handed to a wrapper (review 10 Q9) ----
  Q9_const_to_a_same_file_wrapper: { files: C(dropBody("const PRESETS = '/api/presets';", "const post = (u: string) => apiFetch(u, { method: 'POST' }); const res = await post(PRESETS);")), ...DROPS },
  Q9b_imported_const_to_an_imported_wrapper: { files: C(dropBody("import { PRESETS } from '../lib/paths';\nimport { post } from '../lib/post';", 'const res = await post(PRESETS);'),
    { ...POST, 'lib/paths.ts': "export const PRESETS = '/api/presets';" }), ...DROPS },
  Q9c_helper_call_to_a_wrapper: { files: C(dropBody("const presetsPath = () => '/api/presets';\nconst post = (u: string) => apiFetch(u, { method: 'POST' });", 'const res = await post(presetsPath());')), ...DROPS },
  // ---- an imported wrapper (review 10 Q10) ----
  Q10_imported_wrapper: { files: C(dropBody("import { post } from '../lib/post';", "const res = await post('/api/presets');"), POST), ...DROPS },
  Q10b_imported_wrapper_aliased: { files: C(dropBody("import { post as send } from '../lib/post';", "const res = await send('/api/presets');"), POST), ...DROPS },
  Q10c_imported_wrapper_through_a_reexport: { files: C(dropBody("import { send } from '../lib/index';", "const res = await send('/api/presets');"),
    { ...POST, 'lib/index.ts': "export { post as send } from './post';" }), ...DROPS },
  Q10d_wrapper_through_a_namespace: { files: C(dropBody("import * as net from '../lib/post';", "const res = await net.post('/api/presets');"), POST), ...DROPS },
  Q10e_imported_function_declaration: { files: C(dropBody("import { post } from '../lib/post';", "const res = await post('/api/presets');"),
    { 'lib/post.ts': "import { apiFetch } from './backend';\nexport function post(u: string) { return apiFetch(u, { method: 'POST' }); }" }), ...DROPS },
  // ---- a wrapper as an object's member (review 10 Q15) ----
  Q15_imported_object_member: { files: C(dropBody("import { http } from '../lib/http';", "const res = await http.post('/api/presets');"), HTTP), ...DROPS },
  Q15b_same_file_object_member: { files: C(dropBody("const http = { post(u: string) { return apiFetch(u, { method: 'POST' }); } };", "const res = await http.post('/api/presets');")), ...DROPS },
  // ---- fail closed: the trace's own function, unread ----
  U1_imported_wrapper_made_by_a_call: { files: C(dropBody("import { post } from '../lib/post';", "const res = await post('/api/presets');"),
    { 'lib/post.ts': "import { apiFetch } from './backend';\nconst make = () => (u: string) => apiFetch(u, { method: 'POST' });\nexport const post = make();" }),
    found: {}, untraced: ["components/C.tsx:6 /api/presets (handed to a function the trace can't read)"] },
  U2_object_member_from_a_spread: { files: C(dropBody("import { http } from '../lib/http';", "const res = await http.post('/api/presets');"),
    { 'lib/http.ts': "import { base } from './base';\nexport const http = { ...base };", 'lib/base.ts': 'export const base = {};' }),
    found: {}, untraced: ["components/C.tsx:6 /api/presets (handed to a function the trace can't read)"] },
  U3_const_to_an_unread_wrapper: { files: C(dropBody("import { post } from '../lib/post';\nconst PRESETS = '/api/presets';", 'const res = await post(PRESETS);'),
    { 'lib/post.ts': "export const post = make();\nfunction make(): any { return null; }" }),
    found: {}, untraced: ["components/C.tsx:7 /api/presets (a path const handed to a function the trace can't read)"] },
  U4_helper_call_to_a_wrapper_that_reads_it: { files: C(dropBody("const presetsPath = () => '/api/presets';\nconst post = async (u: string) => { const r = await apiFetch(u, { method: 'POST' }); console.log(r.status); return r; };",
    'const res = await post(presetsPath());')),
    found: {}, untraced: ["components/C.tsx:7 /api/presets (a path helper's call handed to a function that sends it and reads the answer itself)"] },
  // ---- not the trace's own: read as before (the catch around it) ----
  N1_a_parameter_callee: { files: C(dropBody('', "const res = await show.send('/api/presets');")), found: { [GO]: 'keeps' }, untraced: [] },
};

describe('round 13: review 10\'s three trace forms, resolved or listed (LOW-3)', () => {
  for (const [name, { files, found, untraced }] of Object.entries(PROBES)) {
    it(name, { timeout: 30_000 }, () => {
      const out = withSources(files, () => ({
        found: Object.fromEntries([...callersOf(PRESETS)].map(([id, unit]) => [id, unit.outcome])),
        untraced: untracedApiText().map((entry) => `${entry.file}:${entry.line} ${entry.text} (${entry.reason})`),
      }));
      expect(out).toEqual({ found, untraced });
    });
  }
});

// ---- NIT-4: lockReach's aliased re-export walk ----
const REEXPORT: Record<string, string> = {
  'lib/w.ts': "import { apiFetch } from './backend';\nexport async function saveIt(show: (s: string) => void) {\n  try { const r = await apiFetch('/api/settings', { method: 'PUT' }); if (!r.ok) throw new Error(await r.text()); } catch (e) { show(String(e)); } // clears-on-promote: zz.keep\n}",
  'lib/index.ts': "export { saveIt as save } from './w';",
  'components/B.tsx': "import { save } from '../lib/index';\nexport function B() { return <button onClick={() => void save()}>x</button>; }",
};
describe('lockReach follows an aliased re-export to its control (review 10 NIT-4)', () => {
  it('the button that calls the re-exported name is a site; nothing is left open', { timeout: 30_000 }, () => {
    const out = withSources(REEXPORT, () => {
      const callers = [...callersOf({ method: 'PUT', path: '/api/settings' })];
      const points = callers.flatMap(([, unit]) => (unit.points ?? [unit.node]).map((node) => ({ file: unit.file, node })));
      const reach = lockReach(points);
      return {
        callers: callers.map(([id, unit]) => `${id} ${unit.outcome}`),
        sites: reach.sites.map((site) => `${site.file}:${site.line} ${site.tag} ${site.attribute} ${site.locked ?? 'UNLOCKED'}`),
        open: reach.open.map((end) => end.at),
      };
    });
    expect(out).toEqual({ callers: ['lib/w.ts#saveIt keeps'], sites: ['components/B.tsx:2 button onClick UNLOCKED'], open: [] });
  });
});
