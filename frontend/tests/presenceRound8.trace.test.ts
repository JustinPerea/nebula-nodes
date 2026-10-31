/**
 * PR #204 round 8: every reviewer probe of the frontend trace, pinned to its exact outcome (review
 * 6 gates NIT-1): which function the line is said to drop at, and how many paths are listed as
 * untraced. A probe that only asked "drops somewhere, or untraced" passed by the fail-closed rule
 * alone, so round 7's fixes (a destructured action, a two-hop store alias, a const prefix, a
 * placeholder first segment, a bracketed action) weren't pinned. With the exact outcome, each of
 * those fixes taken out changes it.
 * - Review 6 held LOW-5 and gates LOW-4: a marker's words in a string, a template, a block
 *   comment or a JSX comment aren't a marker (Q1-Q3, Q11, R8, R9); a path made by a helper call
 *   is the transport's (Q6); JSX text isn't a comment (J1).
 * - Documented limits (round 6 P6), kept so a change to them is seen: a marker that ends the try's
 *   or the branch's last line, or an unrelated call's line inside the branch, counts (Q12, R11, R12).
 */
import { describe, expect, it } from 'vitest';
import { callersOf, untracedApiText, withSources } from './personGatedCallers';
import { GATES_PROBES, PRESETS, PROBES, RESPONSE_PROBES, ROUND8_PROBES } from './traceProbes';

const EXPECTED: Record<string, { found: Record<string, string>; untraced: number }> = {
  P1_store_via_hook_reexport: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P1b_store_via_hook_const_alias: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P2_destructured_action: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P3a_two_store_layers_plain: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P3b_two_store_layers_outer_registers_elsewhere: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P4_component_rewraps: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P5_hook: { found: {'hooks/useSave.ts#useSave': 'drops', 'components/C.tsx#go': 'drops'}, untraced: 0 },
  P6_const_api_prefix: { found: {'components/C.tsx#go': 'drops'}, untraced: 1 },
  P7_placeholder_first_segment: { found: {}, untraced: 1 },
  P8_component_response_unit_keeper: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P9_uncaught_in_component_helper_keeper_elsewhere: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P10_window_event_dispatch: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P12_marker_on_the_line_before_the_branch: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  P11_selector_in_other_store_file_via_getState_bracket: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q1_marker_in_a_string_literal: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q2_marker_in_a_template_literal: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q3_marker_in_a_block_comment_in_the_catch: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q4_keeper_on_one_branch_inside_not_ok: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q5_unrelated_method_with_a_keepers_name: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q6_path_from_a_function_and_a_registering_catch: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q7_action_read_into_a_const: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q8_destructured_with_rename: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q9_dot_call: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q10_response_bound_by_destructure: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q11_jsx_comment_marker: { found: {'components/C.tsx#Panel': 'drops'}, untraced: 0 },
  Q12_trailing_marker_after_the_try: { found: {'components/C.tsx#go': 'keeps'}, untraced: 0 },
  Q13_store_alias_two_hops: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q14_getState_assigned_first: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  Q15_api_path_in_object_map: { found: {}, untraced: 1 },
  R1_early_return: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  R2_ternary: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  R3_status_check: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  R5_then_chain: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  R8_marker_in_template_literal: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  R9_marker_in_string: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  R10_leading_comment_on_branch: { found: {'components/C.tsx#go': 'drops'}, untraced: 0 },
  R11_trailing_comment_after_branch_close: { found: {'components/C.tsx#go': 'keeps'}, untraced: 0 },
  J1_marker_in_jsx_text: { found: { 'components/C.tsx#Panel': 'drops' }, untraced: 0 },
  R12_marker_in_unrelated_call_in_branch: { found: {'components/C.tsx#go': 'keeps'}, untraced: 0 },
};

describe('round 8: each reviewer probe\'s exact outcome', () => {
  const worlds = { ...PROBES, ...GATES_PROBES, ...RESPONSE_PROBES, ...ROUND8_PROBES };
  it('every probe is pinned', () => {
    expect(Object.keys(worlds).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
  for (const [name, files] of Object.entries(worlds)) {
    it(name, { timeout: 30_000 }, () => {
      const found = withSources(files, () => callersOf(PRESETS));
      const untraced = withSources(files, () => untracedApiText());
      expect({ found: Object.fromEntries([...found].map(([id, unit]) => [id, unit.outcome])), untraced: untraced.length })
        .toEqual(EXPECTED[name]);
    });
  }
});
