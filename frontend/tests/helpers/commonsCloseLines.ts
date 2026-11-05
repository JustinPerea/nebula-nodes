/**
 * PR #204 (GM r41, the string table): every close-batch failure, as [why, status, the backend's
 * detail, the line verbatim, whether the close stays live]. GM r41: only a line ending "Try again."
 * or "Try again in a moment." leaves the close live. tests/commonsCopy.ratchet renders each row in
 * both panes; tests/tryAgainLines.ratchet takes its close rows from the live ones (round 18o,
 * review 18 logic LOW-6), so a new live row needs no hand-kept second list.
 */
export const CLOSE_LINES: Array<[string, number, string | undefined, string, 'live' | 'locked']> = [
  ['503, no answer in time', 503, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.', 'live'],
  ['502, a gateway', 502, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.', 'live'],
  ['504, a gateway timeout', 504, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.', 'live'],
  ['408, a request timeout', 408, undefined, 'Nebula couldn’t close the batch because the server didn’t respond. Try again.', 'live'],
  ['500, the server\'s own error', 500, 'Internal Server Error', 'Nebula couldn’t close the batch because the server hit an error. Try again.', 'live'],
  ['501', 501, undefined, 'Nebula couldn’t close the batch because the server hit an error. Try again.', 'live'],
  ['429, a rate limit', 429, undefined, 'Nebula couldn’t close the batch because the server is busy. Try again in a moment.', 'live'],
  ['no answer at all', 0, undefined, 'Nebula couldn’t close the batch because the server isn’t answering. Try again.', 'live'],
  ['409, a grade still running', 409, 'A grading attempt is still running. Close after it finishes.',
    'Nebula couldn’t close the batch because a grade is still running. Close the batch again when it finishes.', 'locked'],
  ['409, sealed meanwhile', 409, "These labels are sealed as blind ground truth, so there's nothing to close.",
    'Nebula couldn’t close the batch because its labels were already sealed as blind ground truth. Reload to see them.', 'locked'],
  ['409, changed somewhere else', 409, 'Labels changed in another window. Reload before saving.',
    'Nebula couldn’t close the batch because it changed somewhere else. Reload, then close the batch again.', 'locked'],
  ['409, no set anymore', 409, "There's no held-out set yet. Prepare a folder first.",
    'Nebula couldn’t close the batch because its held-out set no longer exists. Reload to get the latest references.', 'locked'],
  ['409, the integrity check', 409, "The held-out set doesn't match what was saved, so Nebula stopped and changed nothing.",
    'Nebula couldn’t close the batch because the held-out set doesn’t match what was saved. Nothing was changed. Reload to check it again.', 'locked'],
  ['409, a reason not listed (its words to the console)', 409, 'Try again, or reload if it keeps happening.',
    'Nebula couldn’t close the batch because the server didn’t accept the request. Try again.', 'live'],
  ['422, another 4xx', 422, undefined, 'Nebula couldn’t close the batch because the server didn’t accept the request. Try again.', 'live'],
  ['415, another 4xx', 415, 'Content-Type must be application/json', 'Nebula couldn’t close the batch because the server didn’t accept the request. Try again.', 'live'],
  ['403, a request without the person\'s token (human_dep)', 403, 'only the human UI session can do this',
    'Nebula couldn’t close the batch because this sign-in isn’t allowed to do that. Open the link Nebula printed when it started.', 'locked'],
  ['403, a foreign Origin (local_guard)', 403, 'Origin not allowed',
    'Nebula couldn’t close the batch because this sign-in isn’t allowed to do that. Open the link Nebula printed when it started.', 'locked'],
  ['403, a foreign Host (local_guard)', 403, 'Host not allowed',
    'Nebula couldn’t close the batch because this sign-in isn’t allowed to do that. Open the link Nebula printed when it started.', 'locked'],
  // Tested-only (GM r43 Q5): in the app a 404 "Commons is disabled" switches the Commons to its off
  // view and the dialog unmounts with the pane (tests/presenceRound18l.closeOff), so this line
  // shows only where the dialog renders alone.
  ['Commons off (tested-only)', 404, 'Commons is disabled',
    'Commons is turned off because Nebula started without it. Restart Nebula with NEBULA_COMMONS_ENABLED=1 to close this batch.', 'locked'],
];
