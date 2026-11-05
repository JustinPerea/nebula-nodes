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

import { PRESETS, PROBES } from './traceProbes';

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
