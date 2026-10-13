/**
 * The person's launch token for the packaged app (see
 * backend/services/person_session.py and frontend/src/lib/personSession.ts).
 *
 * Electron main makes one per launch, writes it to the sidecar's stdin (never
 * argv or env, which `ps` shows), and hands it over IPC only to the app's own
 * main frame. With a remote-debugging port open, anything on this machine can
 * drive the renderer, so there is no token at all and person-only actions stay
 * locked (fail closed); the renderer says why. The Vite dev renderer gets one
 * only with NEBULA_DESKTOP_DEV_PERSON=1.
 */
import { randomBytes } from 'node:crypto';

export const PERSON_TOKEN_CHANNEL = 'person:token';

/** 32 random bytes as 43 base64url characters, the shape the backend accepts. */
export function newPersonToken(random = randomBytes) {
  return random(32).toString('base64url');
}

/**
 * Decide this launch's token.
 * @returns {{ token: string | null, reason: null | 'DEBUG_PORT' | 'DEV_RENDERER' }}
 */
export function decidePersonToken({ debugPort, isDevelopment, devOptIn }, random = randomBytes) {
  if (debugPort) return { token: null, reason: 'DEBUG_PORT' };
  if (isDevelopment && devOptIn !== '1') return { token: null, reason: 'DEV_RENDERER' };
  return { token: newPersonToken(random), reason: null };
}

/** Answer `person:token` for the trusted main frame only. */
export function registerPersonTokenHandler(ipcMain, person, validateSender) {
  ipcMain.handle(PERSON_TOKEN_CHANNEL, (event) => {
    if (!validateSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    if (!person.token) return { ok: false, error: person.reason ?? 'DEBUG_PORT' };
    return { ok: true, token: person.token };
  });
}
