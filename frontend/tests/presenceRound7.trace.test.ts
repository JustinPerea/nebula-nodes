/**
 * PR #204 round 7: the reviewers' probes of the frontend trace (tests/personGatedCallers.ts),
 * kept as tests. Each synthetic world sends a gated route and shows its refusal's line without
 * registering it, so the trace must say the line drops (or list the path as untraced), never
 * that it keeps.
 * - Gates-security LOW-1: the lib/-only fail-closed rule, sendsTo and the keepsLine fallback.
 * - Held-state-ui LOW-7: a store action destructured from getState(), and the other forms.
 */
import { describe, expect, it } from 'vitest';
import { callersOf, untracedApiText, withSources } from './personGatedCallers';

const PRESETS = { method: 'POST', path: '/api/presets' };
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

const PROBES: Record<string, Record<string, string>> = {
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


describe('gates-security LOW-1: the reviewer probes fail closed', () => {
  for (const [name, files] of Object.entries(PROBES)) {
    it(name, () => {
      const found = withSources(files, () => callersOf(PRESETS));
      const untraced = withSources(files, () => untracedApiText());
      const outcomes = [...found.values()].map((unit) => unit.outcome);
      // Somewhere the line is said to drop, or the path is listed for a declaration.
      expect(outcomes.includes('drops') || untraced.length > 0, `${name}: ${[...found].map(([id, u]) => id + '=' + u.outcome).join(', ')}`).toBe(true);
      expect([...found].filter(([id]) => id.startsWith('components/C.tsx')).every(([, u]) => u.outcome !== 'keeps')).toBe(true);
    });
  }
});

const LIB = { 'lib/a.ts': `import { apiFetch } from './backend';\nexport async function save() { const r = await apiFetch('/api/presets', { method: 'POST' }); if (!r.ok) throw new Error('no'); return r; }` };
const storeA = `import { create } from 'zustand';\nimport { save } from '../lib/a';\nexport const useA = create((set, get) => ({\n  actionA: async () => { await save(); },\n}));`;
const show = (body: string) => `import { failureMessage } from '../lib/errorCopy';\n${body}`;
const run = (files: Record<string, string>) => withSources({ ...LIB, ...files }, () => {
  const found = callersOf(PRESETS);
  return Object.fromEntries([...found].map(([id, unit]) => [id, unit.outcome]));
});

describe('review 5 held-state-ui LOW-7: the reviewer probes', () => {
  it('P1 two store layers that rethrow, then a component that drops', () => {
    const out = run({
      'store/a.ts': storeA,
      'store/b.ts': `import { create } from 'zustand';\nimport { useA } from './a';\nexport const useB = create((set, get) => ({\n  actionB: async () => { await useA.getState().actionA(); },\n}));`,
      'components/C.tsx': show(`import { useB } from '../store/b';\nexport function C({ setLine }) { const go = async () => { try { await useB.getState().actionB(); } catch (e) { setLine(failureMessage(e, 'No.')); } }; return go; }`),
    });
    expect(out, JSON.stringify(out)).toMatchObject({ 'components/C.tsx#go': 'drops' });
  });
  it('P2 a component that catches and re-wraps, then a parent that drops', () => {
    const out = run({
      'store/a.ts': storeA,
      'components/Child.tsx': show(`import { useA } from '../store/a';\nexport async function child() { try { await useA.getState().actionA(); } catch (e) { throw new Error(failureMessage(e, 'Wrapped.')); } }`),
      'components/Parent.tsx': show(`import { child } from './Child';\nexport function Parent({ setLine }) { const go = async () => { try { await child(); } catch (e) { setLine(failureMessage(e, 'No.')); } }; return go; }`),
    });
    expect(out, JSON.stringify(out)).toMatchObject({ 'components/Parent.tsx#go': 'drops' });
  });
  it('P3 a hook (useCallback) with no catch, its component drops', () => {
    const out = run({
      'store/a.ts': storeA,
      'hooks/useSave.ts': `import { useCallback } from 'react';\nimport { useA } from '../store/a';\nexport function useSave() { return useCallback(async () => { await useA.getState().actionA(); }, []); }`,
      'components/C.tsx': show(`import { useSave } from '../hooks/useSave';\nexport function C({ setLine }) { const save = useSave(); const go = async () => { try { await save(); } catch (e) { setLine(failureMessage(e, 'No.')); } }; return go; }`),
    });
    expect(Object.values(out)).toContain('drops');
  });
  it('P4 a store action destructured from getState()', () => {
    const out = run({
      'store/a.ts': storeA,
      'components/C.tsx': show(`import { useA } from '../store/a';\nexport function C({ setLine }) { const go = async () => { const { actionA } = useA.getState(); try { await actionA(); } catch (e) { setLine(failureMessage(e, 'No.')); } }; return go; }`),
    });
    expect(Object.values(out)).toContain('drops');
  });
  it('P5 a store action passed as a prop to a child that drops', () => {
    const out = run({
      'store/a.ts': storeA,
      'components/C.tsx': show(`import { useA } from '../store/a';\nimport { Child } from './Child';\nexport function C() { return Child({ onSave: useA.getState().actionA }); }`),
      'components/Child.tsx': show(`export function Child({ onSave, setLine }) { const go = async () => { try { await onSave(); } catch (e) { setLine(failureMessage(e, 'No.')); } }; return go; }`),
    });
    expect(Object.values(out)).toContain('drops');
  });
  it('P6 a catch that registers something else but drops this line (keepsLine by unrelated marker)', () => {
    const out = run({
      'store/a.ts': storeA,
      'components/C.tsx': show(`import { useA } from '../store/a';\nimport { clearSetterOnPromote } from '../lib/clearsOnPromote';\nexport function C({ setLine, setOther }) { const go = async () => { try { await useA.getState().actionA(); } catch (e) { setLine(failureMessage(e, 'No.')); clearSetterOnPromote(e, setOther, 'x', null); // clears-on-promote: probe.other\n } }; return go; }`),
    });
    expect(out, JSON.stringify(out)).toMatchObject({ 'components/C.tsx#go': 'keeps' }); // documents: a marker anywhere in the catch counts
  });
  it('P7 store action awaited inside Promise.all, component drops', () => {
    const out = run({
      'store/a.ts': `import { create } from 'zustand';\nimport { save } from '../lib/a';\nexport const useA = create((set, get) => ({\n  actionA: async () => { await Promise.all([save()]); },\n}));`,
      'components/C.tsx': show(`import { useA } from '../store/a';\nexport function C({ setLine }) { const go = async () => { try { await useA.getState().actionA(); } catch (e) { setLine(failureMessage(e, 'No.')); } }; return go; }`),
    });
    expect(Object.values(out)).toContain('drops');
  });
});

// Review 5 MEDIUM-1 (round 7): a function counts as a keeper by forwarding only when its body
// always makes the keeper's call, and only when every function of that name in the file does.
const keeperFile = (forwarders: string) => show(`import { useA } from '../store/a';
import { clearSetterOnPromote } from '../lib/clearsOnPromote';
function keep(e, setLine) { const line = failureMessage(e, 'No.'); setLine(line); clearSetterOnPromote(e, setLine, line, null); } // clears-on-promote: probe.keep
${forwarders}
export function C({ setLine }) { const go = async () => { try { await useA.getState().actionA(); } catch (e) { say(e, setLine); } }; return go; }`);
describe('round 7: a forwarder keeps only when it always forwards', () => {
  it('always forwards: keeps', () => {
    const out = run({ 'store/a.ts': storeA, 'components/C.tsx': keeperFile('function say(e, setLine) { keep(e, setLine); }') });
    expect(out, JSON.stringify(out)).toMatchObject({ 'components/C.tsx#go': 'keeps' });
  });
  it('forwards on one branch only: drops', () => {
    const out = run({ 'store/a.ts': storeA,
      'components/C.tsx': keeperFile("function say(e, setLine) { if (e) keep(e, setLine); else setLine(failureMessage(e, 'No.')); }") });
    expect(out, JSON.stringify(out)).toMatchObject({ 'components/C.tsx#go': 'drops' });
  });
  it('two functions of the name, one of them not forwarding: drops', () => {
    const out = run({ 'store/a.ts': storeA,
      'components/C.tsx': keeperFile(`const one = { say(e, setLine) { keep(e, setLine); } };
const two = { say(e, setLine) { setLine(failureMessage(e, 'No.')); } };
void one; void two;
function say(e, setLine) { two.say(e, setLine); }`) });
    expect(out, JSON.stringify(out)).toMatchObject({ 'components/C.tsx#go': 'drops' });
  });
});
