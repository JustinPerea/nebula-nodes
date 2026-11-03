/**
 * PR #204 rounds 18m and 18n (GM r44 1, r45 Q1): what unsaved edits lock, each in the house lock
 * form "Save or discard your <edits> to <what the control does>." A lock reason says what unlocks
 * that control. tests/commonsCopy.ratchet pins every line here.
 */
/** The close-batch opener (and, tested-only, the close inside its dialog). */
export const EDITS_LINE_LABELING = 'Save or discard your label changes to close this batch.';
export const EDITS_LINE_REVIEW = 'Save or discard your corrections to close this batch.';
/** Blind labeling's "Review batch" toggle, which switches to the batch's review view. */
export const REVIEW_BATCH_LINE = 'Save or discard your label changes to review the batch.';
/** The form's status line while edits are unsaved: the reference buttons wait for it. */
export const CHANGE_REFERENCE_LINE_LABELING = 'Save or discard your label changes to change the reference.';
export const CHANGE_REFERENCE_LINE_REVIEW = 'Save or discard your corrections to change the reference.';
/** Round 18o (GM r51 Q3): Agent review's "Generate remaining grades", which sits in the header, not
 * in the opener's row, so it has its own line under it. */
export const GENERATE_LINE_REVIEW = 'Save or discard your corrections to grade the rest.';
