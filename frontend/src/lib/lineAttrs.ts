/**
 * PR #204 round 17 (review 13 NIT-3): the attributes the line surfaces carry, on their own so a
 * surface in the first load (PersonLock, LineBox, CommonsErrorLine, CommonsPageLines) names them
 * without bringing in the modules that read them (hooks/useFocusHandover, lib/lockPlacement).
 */

/** The attribute a section's lock or not-connected line carries so a focus handover can find it. */
export const FOCUS_LINE_ATTR = 'data-focus-line';

/** The attribute that names a pane for the focus handover, when its region has no aria-label. */
export const FOCUS_SCOPE_ATTR = 'data-focus-scope';

/** Where a person lock's line sits (lib/lockPlacement has the rule). */
export type LockPlace = 'heading' | 'tab' | 'control' | 'page';

/** The one row a page keeps for its page-level lines (components/commons/CommonsPageLines). */
export const PAGE_LINES_ATTR = 'data-page-lines';

export const LOCK_PLACE_ATTR = 'data-lock-place';
