/**
 * PR #204 (design): while a demote holds the Commons
 * (components/commons/CommonsView), every Commons call answers as it does with no person token:
 * the not-connected line under its heading, and nothing is sent (lib/commonsApi send). Its own
 * module, so the view sets it whatever a test mocks of the API.
 */
let held = false;
export function holdCommonsCalls(next: boolean): void { held = next; }
export function commonsCallsHeld(): boolean { return held; }
