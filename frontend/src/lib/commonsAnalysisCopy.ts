import { becauseLine } from './errorCopy';

/**
 * A failed Commons analysis, in GM's words (GM - Design, error-copy round 3,
 * item 4): heading "Couldn’t analyze this reference." with the reason mapped
 * from last_error's kind. The backend decides the kind where the analysis
 * fails (backend/commons/analysis_errors.py) and sends it as
 * `last_error_kind`. A kind this build doesn't know (a newer backend), or
 * none (an older one), says the "anything else" line. The raw last_error is
 * shown only behind the detail's collapsed "Details" toggle.
 */
export const ANALYSIS_FAILED = "Couldn’t analyze this reference.";

const REASONS: Record<string, string> = {
  // network, timeout or provider 5xx
  unavailable: 'The analysis service didn’t respond. Try again.',
  // the model refused or couldn't read the image: trying again would get the same answer (design: no button)
  unreadable: 'The analyzer couldn’t read this image.',
  // no pixel of it is seen, so it was never sent (GM r5 on #208): neutral, not an error
  transparent: 'This image is too transparent to analyze.',
};

/** Kinds that aren't an error: shown in the muted colour, with no Retry
 *  (the image won't change, so neither would the answer). */
export function analysisFailureIsNeutral(kind: string | null | undefined): boolean {
  return kind === 'transparent';
}
const OTHER = 'Something went wrong during analysis. Try again.';

export function analysisFailureReason(kind: string | null | undefined): string {
  return (kind && Object.prototype.hasOwnProperty.call(REASONS, kind) ? REASONS[kind] : undefined) ?? OTHER;
}

/** Whether trying again can help: the reasons that say "Try again." (the analyzer's refusal and a transparent image don't). */
export function analysisFailureRetries(kind: string | null | undefined): boolean {
  return analysisFailureReason(kind).endsWith(' Try again.');
}

/** The failure as one line in the because form: "Nebula couldn’t analyze this reference because the analysis
 * service didn’t respond. Try again." The line is the same beside a Try again button as alone. */
export function analysisFailureLine(kind: string | null | undefined): string {
  return becauseLine({ heading: ANALYSIS_FAILED, reason: analysisFailureReason(kind) });
}
