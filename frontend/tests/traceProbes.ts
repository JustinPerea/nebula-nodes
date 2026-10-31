/**
 * The reviewers' synthetic worlds for the frontend trace (tests/personGatedCallers.ts), shared by
 * presenceRound7.trace and presenceRound8.trace. Each sends POST /api/presets and shows its
 * refusal's line without registering it (or registers it, where a probe says so).
 * - PROBES: review 5 (round 7), gates-security LOW-1 and held-state-ui LOW-7.
 * - GATES_PROBES: review 6 gates-security LOW-4 (Q1-Q15).
 * - RESPONSE_PROBES: review 6 held-state-ui LOW-5 (R1-R12, a component's own Response).
 */
export const PRESETS = { method: 'POST', path: '/api/presets' };
const SEND = `apiRequest('No.', '/api/presets', { method: 'POST' })`;
const STORE_A = `import { create } from 'zustand';
export const useA = create((set, get) => ({
  save: async () => { await ${SEND}; },
}));`;
const panel = (imports: string, body: string) => `${imports}
import { failureMessage } from '../lib/errorCopy';
export function Panel({ setLine }: { setLine: (line: string) => void }) {
  const go = async () => { ${body} };
  return go;
}`;
const CATCH = (call: string) => `try { await ${call}; } catch (error) { setLine(failureMessage(error, 'No.')); }`;

export const PROBES: Record<string, Record<string, string>> = {
  P1_store_via_hook_reexport: {
    'store/a.ts': STORE_A,
    'hooks/useA.ts': `export { useA as useAlias } from '../store/a';`,
    'components/C.tsx': panel(`import { useAlias } from '../hooks/useA';`, CATCH('useAlias.getState().save()')),
  },
  P1b_store_via_hook_const_alias: {
    'store/a.ts': STORE_A,
    'hooks/useA.ts': `import { useA } from '../store/a';\nexport const useAlias = useA;`,
    'components/C.tsx': panel(`import { useAlias } from '../hooks/useA';`, CATCH('useAlias.getState().save()')),
  },
  P2_destructured_action: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panel(`import { useA } from '../store/a';`, `const { save } = useA.getState(); ${CATCH('save()')}`),
  },
  P3a_two_store_layers_plain: {
    'store/a.ts': STORE_A,
    'store/b.ts': `import { create } from 'zustand';\nimport { useA } from './a';
export const useB = create((set, get) => ({
  outer: async () => { await useA.getState().save(); },
}));`,
    'components/C.tsx': panel(`import { useB } from '../store/b';`, CATCH('useB.getState().outer()')),
  },
  P3b_two_store_layers_outer_registers_elsewhere: {
    'store/a.ts': STORE_A,
    'store/b.ts': `import { create } from 'zustand';\nimport { useA } from './a';
export const useB = create((set, get) => ({
  notify: (line) => { set({ line }); }, // clears-on-promote: zz.notify
  outer: async () => { if (!get().ready) get().notify('Not ready.'); await useA.getState().save(); },
}));`,
    'components/C.tsx': panel(`import { useB } from '../store/b';`, CATCH('useB.getState().outer()')),
  },
  P4_component_rewraps: {
    'store/a.ts': STORE_A,
    'components/C.tsx': `import { useA } from '../store/a';
async function doSave() { try { await useA.getState().save(); } catch (error) { throw new Error('Wrapped: ' + String(error)); } }
export function Panel({ setLine }) { const go = async () => { try { await doSave(); } catch (e) { setLine((e as Error).message); } }; return go; }`,
  },
  P5_hook: {
    'store/a.ts': STORE_A,
    'hooks/useSave.ts': `import { useCallback } from 'react';\nimport { useA } from '../store/a';
export function useSave() { return useCallback(async () => { await useA.getState().save(); }, []); }`,
    'components/C.tsx': panel(`import { useSave } from '../hooks/useSave';`, `const save = useSave(); ${CATCH('save()')}`),
  },
  P6_const_api_prefix: {
    'lib/a.ts': "const API = '/api/';\nexport function save() { return apiFetch(`${API}presets`, { method: 'POST' }); }",
    'components/C.tsx': panel(`import { save } from '../lib/a';`, CATCH('save()')),
  },
  P7_placeholder_first_segment: {
    'lib/a.ts': "export function save(kind = 'presets') { return apiFetch(`/api/${kind}`, { method: 'POST' }); }",
    'components/C.tsx': panel(`import { save } from '../lib/a';`, CATCH('save()')),
  },
  P8_component_response_unit_keeper: {
    'components/C.tsx': `import { failureMessage } from '../lib/errorCopy';
export function Panel({ setLine, show }) {
  const go = async () => {
    if (!navigator.onLine) { show('Offline.'); } // clears-on-promote: zz.offline
    const res = await apiFetch('/api/presets', { method: 'POST' });
    if (!res.ok) setLine(await res.text());
  };
  return go;
}`,
  },
  P9_uncaught_in_component_helper_keeper_elsewhere: {
    'store/a.ts': STORE_A,
    'components/C.tsx': `import { useA } from '../store/a';
import { failureMessage } from '../lib/errorCopy';
export function Panel({ setLine, show }) {
  const run = async () => {
    if (!navigator.onLine) show('Offline.'); // clears-on-promote: zz.offline2
    await useA.getState().save();
  };
  const go = () => { run().catch((e) => setLine(failureMessage(e, 'No.'))); };
  return go;
}`,
  },
  P10_window_event_dispatch: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panel(`import { useA } from '../store/a';`, `try { await useA.getState().save(); } catch (error) { window.dispatchEvent(new CustomEvent('line', { detail: failureMessage(error, 'No.') })); }`),
  },
  // Round 7: a marker that ends the line before a branch is that line's, not the branch's.
  P12_marker_on_the_line_before_the_branch: {
    'components/C.tsx': `import { failureMessage } from '../lib/errorCopy';
export function Panel({ setLine, show }) {
  const go = async () => {
    const res = await apiFetch('/api/presets', { method: 'POST' });
    show('Sent.'); // clears-on-promote: zz.sent
    if (!res.ok) setLine(await res.text());
  };
  return go;
}`,
  },
  P11_selector_in_other_store_file_via_getState_bracket: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panel(`import { useA } from '../store/a';`, CATCH("useA.getState()['save']()")),
  },
};



const panelQ = (imports: string, body: string) => `${imports}
import { failureMessage } from '../lib/errorCopy';
export function Panel({ setLine, show }: any) {
  const go = async () => { ${body} };
  return go;
}`;
const DROP_Q = `setLine(failureMessage(error, 'No.'))`;
const CATCH_Q = (call: string, handler = DROP_Q) => `try { await ${call}; } catch (error) { ${handler}; }`;

// Every probe drops the refusal's line unregistered; the trace must not say every caller keeps.
export const GATES_PROBES: Record<string, Record<string, string>> = {
  Q1_marker_in_a_string_literal: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panelQ(`import { useA } from '../store/a';`, CATCH_Q('useA.getState().save()', `setLine('see // clears-on-promote: zz.str')`)),
  },
  Q2_marker_in_a_template_literal: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panelQ(`import { useA } from '../store/a';`, CATCH_Q('useA.getState().save()', "setLine(`x // clears-on-promote: zz.tpl ${String(error)}`)")),
  },
  Q3_marker_in_a_block_comment_in_the_catch: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panelQ(`import { useA } from '../store/a';`, CATCH_Q('useA.getState().save()', `/* // clears-on-promote: zz.blk */ ${DROP_Q}`)),
  },
  Q4_keeper_on_one_branch_inside_not_ok: {
    'components/C.tsx': `export function Panel({ setLine, keep, flag }: any) {
  const k = (l) => { keep(l); }; // clears-on-promote: zz.k
  const go = async () => {
    const res = await apiFetch('/api/presets', { method: 'POST' });
    if (!res.ok) { if (flag) k('a'); else setLine(await res.text()); }
  };
  return go;
}`,
  },
  Q5_unrelated_method_with_a_keepers_name: {
    'components/C.tsx': `import { failureMessage } from '../lib/errorCopy';
import { useA } from '../store/a';
const notify = (line) => { console.log(line); }; // clears-on-promote: zz.n
export function Panel({ setLine, analytics }: any) {
  const go = async () => { try { await useA.getState().save(); } catch (error) { analytics.notify('x'); setLine(failureMessage(error, 'No.')); } };
  return go;
}`,
    'store/a.ts': STORE_A,
  },
  Q6_path_from_a_function_and_a_registering_catch: {
    'components/C.tsx': `const presetsPath = () => '/api/presets';
export function Panel({ setLine, show }: any) {
  const go = async () => {
    try {
      const res = await apiFetch(presetsPath(), { method: 'POST' });
      if (!res.ok) setLine(await res.text());
    } catch (e) { show(String(e)); } // clears-on-promote: zz.lost
  };
  return go;
}`,
  },
  Q7_action_read_into_a_const: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panelQ(`import { useA } from '../store/a';`, `const s = useA.getState().save; ${CATCH_Q('s()')}`),
  },
  Q8_destructured_with_rename: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panelQ(`import { useA } from '../store/a';`, `const { save: s } = useA.getState(); ${CATCH_Q('s()')}`),
  },
  Q9_dot_call: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panelQ(`import { useA } from '../store/a';`, CATCH_Q('useA.getState().save.call(null)')),
  },
  Q10_response_bound_by_destructure: {
    'components/C.tsx': `export function Panel({ setLine }: any) {
  const go = async () => { const { ok, status } = await apiFetch('/api/presets', { method: 'POST' }); if (!ok) setLine('No ' + status); };
  return go;
}`,
  },
  Q11_jsx_comment_marker: {
    'store/a.ts': STORE_A,
    'components/C.tsx': `import { failureMessage } from '../lib/errorCopy';
import { useA } from '../store/a';
export function Panel({ setLine }: any) {
  return <button onClick={async () => { try { await useA.getState().save(); } catch (error) { setLine(failureMessage(error, 'No.')); {/* // clears-on-promote: zz.jsx */} } }}>Go</button>;
}`,
  },
  Q12_trailing_marker_after_the_try: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panelQ(`import { useA } from '../store/a';`, `${CATCH_Q('useA.getState().save()')} // clears-on-promote: zz.after`),
  },
  Q13_store_alias_two_hops: {
    'store/a.ts': STORE_A,
    'hooks/b.ts': `import { useA } from '../store/a';\nexport const useB = useA;`,
    'hooks/c.ts': `import { useB } from './b';\nexport const useC = useB;`,
    'components/C.tsx': panelQ(`import { useC } from '../hooks/c';`, CATCH_Q('useC.getState().save()')),
  },
  Q14_getState_assigned_first: {
    'store/a.ts': STORE_A,
    'components/C.tsx': panelQ(`import { useA } from '../store/a';`, `const st = useA.getState(); ${CATCH_Q('st.save()')}`),
  },
  Q15_api_path_in_object_map: {
    'lib/a.ts': "const PATHS = { presets: '/api/presets' };\nexport function save() { return apiRequest('No.', PATHS.presets, { method: 'POST' }); }",
    'components/C.tsx': panelQ(`import { save } from '../lib/a';`, CATCH_Q('save()')),
  },
};


const comp = (body: string) => `import { failureMessage } from '../lib/errorCopy';
export function Panel({ setLine, show }) {
  const go = async () => {
${body}
  };
  return go;
}`;
const RESPONSE_BODIES: Record<string, string> = {
  R1_early_return: `    const res = await apiFetch('/api/presets', { method: 'POST' });
    if (res.ok) return;
    setLine(await res.text());`,
  R2_ternary: `    const res = await apiFetch('/api/presets', { method: 'POST' });
    res.ok ? show('ok') : setLine(await res.text());`,
  R3_status_check: `    const res = await apiFetch('/api/presets', { method: 'POST' });
    if (res.status >= 400) setLine(await res.text());`,
  R5_then_chain: `    await apiFetch('/api/presets', { method: 'POST' }).then(async (r) => { if (!r.ok) setLine(await r.text()); });`,
  R8_marker_in_template_literal: "    const res = await apiFetch('/api/presets', { method: 'POST' });\n    if (!res.ok) { const t = `x // clears-on-promote: zz.tpl`; setLine(t + await res.text()); }",
  R9_marker_in_string: "    const res = await apiFetch('/api/presets', { method: 'POST' });\n    if (!res.ok) { setLine('// clears-on-promote: zz.str ' + await res.text()); }",
  R10_leading_comment_on_branch: `    const res = await apiFetch('/api/presets', { method: 'POST' });
    // clears-on-promote: zz.lead
    if (!res.ok) setLine(await res.text());`,
  R11_trailing_comment_after_branch_close: `    const res = await apiFetch('/api/presets', { method: 'POST' });
    if (!res.ok) {
      setLine(await res.text());
    } // clears-on-promote: zz.trail`,
  R12_marker_in_unrelated_call_in_branch: `    const res = await apiFetch('/api/presets', { method: 'POST' });
    if (!res.ok) { show('x'); // clears-on-promote: zz.other
      setLine(await res.text()); }`,
};

/** Round 8: a marker's words as JSX text are text, not a comment. */
export const ROUND8_PROBES: Record<string, Record<string, string>> = {
  J1_marker_in_jsx_text: {
    'components/C.tsx': `export function Panel({ setLine }) {
  return <button onClick={async () => {
    const res = await apiFetch('/api/presets', { method: 'POST' });
    if (!res.ok) setLine(<p>// clears-on-promote: zz.jsxtext</p>);
  }}>Go</button>;
}`,
  },
};

export const RESPONSE_PROBES: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(RESPONSE_BODIES).map(([name, body]) => [name, { 'components/C.tsx': comp(body) }]));
