/**
 * A failed Commons analysis, in GM's words (GM - Design, error-copy round 3,
 * item 4): heading "Couldn't analyze this reference." with the reason mapped
 * from last_error's kind. The backend decides the kind where the analysis
 * fails (backend/commons/analysis_errors.py) and sends it as
 * `last_error_kind`. A kind this build doesn't know (a newer backend), or
 * none (an older one), says the "anything else" line. The raw last_error is
 * shown only behind the detail's collapsed "Details" toggle.
 */
export const ANALYSIS_FAILED = "Couldn't analyze this reference.";

const REASONS: Record<string, string> = {
  // network, timeout or provider 5xx
  unavailable: "The analysis service didn't respond.",
  // the model refused or couldn't read the image
  unreadable: "The analyzer couldn't read this image.",
};
const OTHER = 'Something went wrong during analysis.';

export function analysisFailureReason(kind: string | null | undefined): string {
  return (kind && Object.prototype.hasOwnProperty.call(REASONS, kind) ? REASONS[kind] : undefined) ?? OTHER;
}
