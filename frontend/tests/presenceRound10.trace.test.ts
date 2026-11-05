/**
 * PR #204 round 10 (review 8 LOW-1 and LOW-2): path forms the trace (tests/personGatedCallers.ts)
 * let the catch decide, each pinned to its exact outcome. Every probe sends POST /api/presets and
 * then `if (!res.ok) setLine(await res.text())` with no marker, inside a try whose catch registers:
 * read right, the call drops ('drops'); where the trace can't read the path it is listed as
 * untraced and no catch decides it. None may come out 'keeps'.
 * - A function-local `const` path is the path at each of its uses (B1, J5, B24, C*); a `let`, an
 *   assignment, a conditional with a branch it can't read, a const never used, or a path held in
 *   an object is listed (B2, B10, U*).
 * - `paths['presets']()` is `paths.presets()` (B6); a path helper handed to a call uncalled is
 *   listed (B23, N*).
 * - K*: the same forms with the branch registered keep, so a resolved path isn't just forced to drop.
 * - W1 (LOW-2, T_wrappers_no_join): a helper that wraps its path in joinBackendPath is still a
 *   path helper, so its call in a local it can't read is listed.
 */
import { describe, expect, it } from 'vitest';
import { callersOf, untracedApiText, withSources } from './personGatedCallers';

const PRESETS = { method: 'POST', path: '/api/presets' };
const ONE_PRESET = { method: 'POST', path: '/api/presets/{preset_id}' };
const GO = 'components/C.tsx#go';
const DROPS = { found: { [GO]: 'drops' }, untraced: 0 };
const LISTED = { found: {}, untraced: 1 };

/** The probe's panel: the request in a try whose catch registers; its `!res.ok` branch doesn't. */
const dropBody = (pre: string, inner: string) => `${pre}
export function Panel({ setLine, show }: any) {
  const go = async () => {
    try {
      ${inner}
      if (!res.ok) setLine(await res.text());
    } catch (e) { show(String(e)); } // clears-on-promote: zz.lost
  };
  return go;
}`;
/** The same with the branch registered and the catch not: read right, it keeps. */
const keepBody = (pre: string, inner: string) => `${pre}
export function Panel({ setLine, show }: any) {
  const go = async () => {
    try {
      ${inner}
      if (!res.ok) setLine(await res.text()); // clears-on-promote: zz.refused
    } catch (e) { show(String(e)); }
  };
  return go;
}`;
const HP = "const presetsPath = () => '/api/presets';";
const SEND = "const res = await apiFetch(u, { method: 'POST' });";

interface Probe { files: Record<string, string>; found: Record<string, string>; untraced: number; route?: { method: string; path: string } }
const C = (source: string) => ({ 'components/C.tsx': source });

const PROBES: Record<string, Probe> = {
  // ---- review 8 LOW-1, as the review wrote them ----
  B1_bare_literal_local: { files: C(dropBody('', `const u = '/api/presets'; ${SEND}`)), ...DROPS },
  B2_literal_let: { files: C(dropBody('', `let u = ''; u = '/api/presets'; ${SEND}`)), ...LISTED },
  B6_element_access: { files: C(dropBody("const paths = { presets: () => '/api/presets' };", "const res = await apiFetch(paths['presets'](), { method: 'POST' });")), ...DROPS },
  B10_object_prop: { files: C(dropBody('', "const cfg = { url: '/api/presets' }; const res = await apiFetch(cfg.url, { method: 'POST' });")), ...LISTED },
  B23_helper_as_arg_callback: { files: C(dropBody(`${HP} const send = (p: () => string) => apiFetch(p(), { method: 'POST' });`, 'const res = await send(presetsPath);')),
    found: { [GO]: 'drops' }, untraced: 1 },
  B24_literal_ternary_local: { files: C(dropBody('', `const u = show.x ? '/api/presets' : '/api/presets'; ${SEND}`)), ...DROPS },
  J5_literal_local_used_twice: { files: C(dropBody('', "const u = '/api/presets'; console.log(u); const res = await fetch(u, { method: 'POST' });")), ...DROPS },
  // A module const is still followed as its own unit (control).
  B3_module_const: { files: C(dropBody("const PATH = '/api/presets';", "const res = await apiFetch(PATH, { method: 'POST' });")), ...DROPS },
  // ---- a function-local const, resolved ----
  C1_const_of_a_const: { files: C(dropBody('', `const a = '/api/presets'; const u = a; ${SEND}`)), ...DROPS },
  C2_const_of_a_module_const: { files: C(dropBody("const PATH = '/api/presets';", `const u = PATH; ${SEND}`)), ...DROPS },
  C3_const_in_a_template: { files: C(dropBody('', "const base = '/api/presets'; const res = await apiFetch(`${base}/${show.id}`, { method: 'POST' });")),
    route: ONE_PRESET, ...DROPS },
  C4_const_in_a_concat: { files: C(dropBody('', "const base = '/api/presets'; const res = await apiFetch(base + '/' + show.id, { method: 'POST' });")),
    route: ONE_PRESET, ...DROPS },
  C6_const_in_a_template_in_a_concat: { files: C(dropBody('', "const base = '/api/presets'; const res = await apiFetch(`${base}/` + show.id, { method: 'POST' });")),
    route: ONE_PRESET, ...DROPS },
  C5_const_template_with_an_id: { files: C(dropBody('', `const u = \`/api/presets/\${show.id}\`; ${SEND}`)), route: ONE_PRESET, ...DROPS },
  // ---- fail closed: held where the trace can't read it ----
  U1_literal_let_initialized: { files: C(dropBody('', `let u = '/api/presets'; ${SEND}`)), ...LISTED },
  U2_conditional_with_an_unread_branch: { files: C(dropBody('', `const u = show.x ? '/api/presets' : show.y; ${SEND}`)), ...LISTED },
  U3_const_never_used: { files: C(dropBody('', "const u = '/api/presets'; const res = await apiFetch(show.y, { method: 'POST' });")), ...LISTED },
  U4_property_assigned: { files: C(dropBody('', "const cfg = { url: '' }; cfg.url = '/api/presets'; const res = await apiFetch(cfg.url, { method: 'POST' });")), ...LISTED },
  U5_const_in_a_shorthand_property: { files: C(dropBody('', "const u = '/api/presets'; const cfg = { u }; show.log(u); const res = await apiFetch(cfg.u, { method: 'POST' });")),
    found: { [GO]: 'keeps' }, untraced: 1 },
  U6_nullish_local: { files: C(dropBody('', `const u = '/api/presets' ?? show.y; ${SEND}`)), ...LISTED },
  N1_helper_handed_to_new: { files: C(dropBody(HP, 'const res = await new Sender(presetsPath).send();')), found: { [GO]: 'drops' }, untraced: 1 },
  N2_helper_handed_over_non_null: { files: C(dropBody(`${HP} const send = (p: () => string) => apiFetch(p(), { method: 'POST' });`, 'const res = await send(presetsPath!);')),
    found: { [GO]: 'drops' }, untraced: 1 },
  N3_element_helper_handed_over: { files: C(dropBody("const paths = { presets: () => '/api/presets' }; const send = (p: () => string) => apiFetch(p(), { method: 'POST' });",
    "const res = await send(paths['presets']);")), found: { [GO]: 'drops' }, untraced: 1 },
  // ---- read right, a registered branch keeps ----
  K1_const_local_branch_registers: { files: C(keepBody('', `const u = '/api/presets'; ${SEND}`)), found: { [GO]: 'keeps' }, untraced: 0 },
  K2_const_local_beside_a_property_read: { files: C(keepBody('', `const u = '/api/presets'; show.log(show.u); ${SEND}`)), found: { [GO]: 'keeps' }, untraced: 0 },
  K3_element_access_branch_registers: { files: C(keepBody("const paths = { presets: () => '/api/presets' };", "const res = await apiFetch(paths['presets'](), { method: 'POST' });")),
    found: { [GO]: 'keeps' }, untraced: 0 },
  // ---- review 8 LOW-2: joinBackendPath in PATH_WRAPPERS ----
  W1_helper_wrapped_in_joinBackendPath_in_a_local: { files: C(dropBody("const presetsUrl = () => joinBackendPath(b, '/api/presets');",
    "const u = presetsUrl() as string; const res = await apiFetch(u, { method: 'POST' });")), found: { [GO]: 'drops' }, untraced: 1 },
};

describe('round 10: review 8\'s trace probes, exact outcomes (LOW-1, LOW-2)', () => {
  it('each probe is its own source', () => {
    expect(new Set(Object.values(PROBES).map((probe) => JSON.stringify(probe.files))).size).toBe(Object.keys(PROBES).length);
  });
  for (const [name, { files, found, untraced, route = PRESETS }] of Object.entries(PROBES)) {
    it(name, { timeout: 30_000 }, () => {
      const units = withSources(files, () => callersOf(route));
      const listed = withSources(files, () => untracedApiText());
      expect({ found: Object.fromEntries([...units].map(([id, unit]) => [id, unit.outcome])), untraced: listed.length })
        .toEqual({ found, untraced });
    });
  }
});
