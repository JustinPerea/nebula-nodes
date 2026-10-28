import { apiFetch } from './backend';
import type { ProjectContext } from './projectContext';
import { RequestFailedError, requestError, requestSucceeded, withHeading } from './errorCopy';

/**
 * apiFetch for a call that names its action (GM, error-copy round 2:
 * "Couldn't {verb} {object}." then the reason). A request with no answer
 * comes back as a ConnectionLostError under `heading`; an answered failure
 * as a RequestFailedError (requestError: GM's line for its status, or the
 * backend's written reason), logged once for the console. Statuses in
 * `allow` (a 404 that means "none", a 409 the caller reads) come back as
 * the response, for the caller to handle; `as` turns the error into the
 * caller's own class.
 *
 * Its own module, not backend.ts, so a test that mocks backend's apiFetch
 * mocks this call too (a call inside one module can't be mocked).
 */
export async function apiRequest(heading: string, path: string, init?: RequestInit,
  options: { allow?: number[]; as?: (error: RequestFailedError) => Error;
    /** The project and canvas the request was made for, when not the one
     * open now (a note composed before a switch: round 23 of PR #195). */
    project?: ProjectContext | null } = {}): Promise<Response> {
  let response: Response;
  try {
    // The same call shape as a plain apiFetch(path) when there is no init.
    response = await ('project' in options ? apiFetch(path, init, { project: options.project ?? null })
      : init === undefined ? apiFetch(path) : apiFetch(path, init));
  } catch (error) {
    throw withHeading(error, heading);
  }
  if (response.ok) {
    requestSucceeded(heading);
  } else if (!options.allow?.includes(response.status)) {
    // `as`: a module's own error class (ProjectRequestError...), same parts.
    const error = await requestError(heading, response);
    throw options.as ? options.as(error) : error;
  }
  return response;
}
