/**
 * PR #204 round 9: review 7's trace probes, each pinned to its exact outcome.
 * - LOW-2: a path made by a helper (or written) and wrapped in await, `as`, `satisfies`, `!`,
 *   `<T>`, a template, a method call or a URL wrapper (String, backendUrl, joinBackendPath) is
 *   still the transport's: its `!res.ok` branch is read, not the catch (H1-H14, L1-L5, K1).
 *   Where the wrapped path is held somewhere the trace can't read, it is listed as untraced and
 *   no catch decides it (U1-U7).
 * - LOW-3: the destructure follow in callersOf (D1), a marker above the branch's statement (O3),
 *   a marker's words in the middle of a comment (O2), and a marker on its own line in a catch (O4).
 * - NIT-2: the chat socket's refusal is read from the syntax tree (S1-S9).
 */
import { describe, expect, it } from 'vitest';
import { callersOf, socketRefusalGaps, untracedApiText, withSources } from './personGatedCallers';
import { PRESETS, ROUND9_PROBES, SOCKET_PROBES } from './traceProbes';

const GO = 'components/C.tsx#go';
const EXPECTED: Record<string, { found: Record<string, string>; untraced: number }> = {
  H1_method_helper: { found: { [GO]: 'drops' }, untraced: 0 },
  H2_awaited_helper: { found: { [GO]: 'drops' }, untraced: 0 },
  H3_helper_as_string: { found: { [GO]: 'drops' }, untraced: 0 },
  H4_helper_non_null: { found: { [GO]: 'drops' }, untraced: 0 },
  H5_helper_in_a_template: { found: { [GO]: 'drops' }, untraced: 0 },
  H11_helper_in_String: { found: { [GO]: 'drops' }, untraced: 0 },
  H12_helper_in_backendUrl: { found: { [GO]: 'drops' }, untraced: 0 },
  H13_helper_satisfies: { found: { [GO]: 'drops' }, untraced: 0 },
  H14_helper_type_assertion: { found: { 'components/C.ts#go': 'drops' }, untraced: 0 },
  L1_literal_as: { found: { [GO]: 'drops' }, untraced: 0 },
  L2_literal_in_String: { found: { [GO]: 'drops' }, untraced: 0 },
  L3_literal_in_joinBackendPath: { found: { [GO]: 'drops' }, untraced: 0 },
  L4_literal_non_null: { found: { [GO]: 'drops' }, untraced: 0 },
  H7_helper_in_a_const: { found: { 'components/C.tsx#url': 'drops' }, untraced: 0 },
  K2_wrapped_helper_sent_by_apiRequest: { found: { [GO]: 'keeps' }, untraced: 0 },
  U8_helper_that_wraps_its_path: { found: { [GO]: 'drops' }, untraced: 1 },
  H15_lib_helper_returns_a_wrapped_transport: { found: { [GO]: 'drops' }, untraced: 0 },
  K3_same_name_in_another_file: { found: { 'lib/a.ts#presetsPath': 'drops' }, untraced: 0 },
  K1_method_helper_branch_registers: { found: { [GO]: 'keeps' }, untraced: 0 },
  U1_helper_as_string_in_a_local: { found: { [GO]: 'drops' }, untraced: 1 },
  U2_helper_in_a_template_in_a_local: { found: { [GO]: 'drops' }, untraced: 1 },
  U3_literal_as_string_in_a_local: { found: {}, untraced: 1 },
  U4_awaited_backendUrl_in_a_local: { found: { [GO]: 'drops' }, untraced: 1 },
  U5_helper_assigned_to_a_let: { found: { [GO]: 'drops' }, untraced: 1 },
  U6_helper_in_an_array: { found: { [GO]: 'drops' }, untraced: 1 },
  U7_method_helper_in_a_local: { found: { [GO]: 'drops' }, untraced: 1 },
  D1_destructured_outside_the_caller: { found: { [GO]: 'drops' }, untraced: 0 },
  O2_marker_words_mid_comment: { found: { [GO]: 'drops' }, untraced: 0 },
  O3_marker_above_the_branch_statement: { found: { [GO]: 'drops' }, untraced: 0 },
  O4_marker_on_its_own_line_in_the_catch: { found: { [GO]: 'keeps' }, untraced: 0 },
};

describe('round 9: review 7\'s trace probes, exact outcomes', () => {
  it('every probe is pinned', () => {
    expect(Object.keys(ROUND9_PROBES).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(new Set(Object.values(ROUND9_PROBES).map((files) => JSON.stringify(files))).size).toBe(Object.keys(ROUND9_PROBES).length);
  });
  for (const [name, files] of Object.entries(ROUND9_PROBES)) {
    it(name, { timeout: 30_000 }, () => {
      const found = withSources(files, () => callersOf(PRESETS));
      const untraced = withSources(files, () => untracedApiText());
      expect({ found: Object.fromEntries([...found].map(([id, unit]) => [id, unit.outcome])), untraced: untraced.length })
        .toEqual(EXPECTED[name]);
    });
  }
});

describe('round 9: the chat socket\'s refusal, read from the syntax tree (NIT-2)', () => {
  it('each probe is its own source', () => {
    expect(new Set(Object.values(SOCKET_PROBES).map((probe) => probe.source)).size).toBe(Object.keys(SOCKET_PROBES).length);
  });
  for (const [name, { source, gaps }] of Object.entries(SOCKET_PROBES)) {
    it(name, () => {
      expect(withSources({ 'components/Chat.tsx': source }, () => socketRefusalGaps('components/Chat.tsx', '/ws/chat'))).toEqual(gaps);
    });
  }
  it('the real ChatPanel opens /ws/chat and registers its refusal\'s line', { timeout: 30_000 }, () => {
    expect(socketRefusalGaps('components/panels/ChatPanel.tsx', '/ws/chat')).toEqual([]);
  });
});
