/**
 * PR #204 round 14, review 11 held-calls LOW-4: three imported-wrapper forms the trace
 * (tests/personGatedCallers) decided by the catch around them, so a caller that drops its line on a
 * `!res.ok` answer read as one that keeps it. Each probe sends POST /api/presets through a wrapper,
 * then `if (!res.ok) setLine(...)` with no marker, inside a try whose catch registers. Each must come
 * out `drops` (the wrapper is read) or be listed as untraced (it can't be), never `keeps`.
 * - P1, P1b: a default-exported wrapper (an arrow, `export default function`), and a name.
 * - P3: a wrapper that hands its path on to another file's wrapper (`post = (u) => send(u)`).
 * - P13: a wrapper a call returns (`usePost()('/api/…')`).
 */
import { describe, expect, it } from 'vitest';
import { callersOf, untracedApiText, withSources } from './personGatedCallers';

const PRESETS = { method: 'POST', path: '/api/presets' };
const GO = 'components/C.tsx#go';
const dropBody = (imports: string, inner: string) => `${imports}
export function Panel({ setLine, show }: any) {
  const go = async () => {
    try {
      ${inner}
      if (!res.ok) setLine(await res.text());
    } catch (e) { show(String(e)); } // clears-on-promote: zz.lost
  };
  return go;
}`;
const C = (source: string, more: Record<string, string> = {}) => ({ 'components/C.tsx': source, ...more });
const AF = "import { apiFetch } from './backend';\n";
const viaPost = (imports: string) => C(dropBody(imports, "const res = await post('/api/presets');"));

function trace(files: Record<string, string>) {
  return withSources(files, () => ({
    found: Object.fromEntries([...callersOf(PRESETS)].map(([id, unit]) => [id, unit.outcome])),
    untraced: untracedApiText().map((e) => `${e.file}:${e.line} ${e.text} (${e.reason})`),
  }));
}

const PROBES: Record<string, { files: Record<string, string>; expect: 'drops' | 'untraced' }> = {
  P1_default_export_arrow: {
    files: { ...viaPost("import post from '../lib/post';"), 'lib/post.ts': `${AF}export default (u: string) => apiFetch(u, { method: 'POST' });` },
    expect: 'drops',
  },
  P1b_default_export_function: {
    files: { ...viaPost("import post from '../lib/post';"), 'lib/post.ts': `${AF}export default function post(u: string) { return apiFetch(u, { method: 'POST' }); }` },
    expect: 'drops',
  },
  P1c_default_export_name: {
    files: { ...C(dropBody("import send from '../lib/post';", "const res = await send('/api/presets');")),
      'lib/post.ts': `${AF}const post = (u: string) => apiFetch(u, { method: 'POST' });\nexport default post;` },
    expect: 'drops',
  },
  P1d_default_export_unreadable: {
    files: { ...viaPost("import post from '../lib/post';"), 'lib/post.ts': `${AF}export default makePoster(apiFetch);` },
    expect: 'untraced',
  },
  P3_wrapper_chain_two_files: {
    files: { ...viaPost("import { post } from '../lib/a';"),
      'lib/a.ts': "import { send } from './b';\nexport const post = (u: string) => send(u);",
      'lib/b.ts': `${AF}export const send = (u: string) => apiFetch(u, { method: 'POST' });` },
    expect: 'drops',
  },
  P3b_wrapper_chain_to_unreadable: {
    files: { ...viaPost("import { post } from '../lib/a';"),
      'lib/a.ts': "import { send } from './b';\nexport const post = (u: string) => send(u);",
      'lib/b.ts': `${AF}export const send = makeSender(apiFetch);` },
    expect: 'untraced',
  },
  P13_wrapper_a_call_returns: {
    files: C(dropBody("import { usePost } from '../lib/post';", "const res = await usePost()('/api/presets');"),
      { 'lib/post.ts': `${AF}export const usePost = () => (u: string) => apiFetch(u, { method: 'POST' });` }),
    expect: 'untraced',
  },
};

describe('review 11 LOW-4: imported-wrapper forms are read, or listed, never decided by the catch', () => {
  for (const [name, probe] of Object.entries(PROBES)) {
    it(name, { timeout: 60_000 }, () => {
      const out = trace(probe.files);
      expect(out.found[GO], JSON.stringify(out)).not.toBe('keeps');
      if (probe.expect === 'drops') expect(out.found[GO], JSON.stringify(out)).toBe('drops');
      else expect(out.untraced.some((line) => line.startsWith('components/C.tsx:') && line.includes('/api/presets')), JSON.stringify(out)).toBe(true);
    });
  }

  // A wrapper that throws on every failed answer is a throwing call: its catch keeps the line.
  it('control: a wrapper chain whose first wrapper throws on a failed answer is the catch\'s to decide (keeps)', { timeout: 60_000 }, () => {
    const out = trace({ ...viaPost("import { post } from '../lib/a';"),
      'lib/a.ts': "import { send } from './b';\nexport async function post(u: string) { const r = await send(u); if (!r.ok) throw new Error('no'); return r; }",
      'lib/b.ts': `${AF}export const send = (u: string) => apiFetch(u, { method: 'POST' });` });
    expect(out.found[GO], JSON.stringify(out)).toBe('keeps');
  });
});
