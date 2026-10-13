/**
 * The person's launch token for the packaged app (see
 * backend/services/person_session.py and frontend/src/lib/personSession.ts).
 *
 * Electron main makes one per launch, writes it to the sidecar's stdin (never
 * argv or env, which `ps` shows), and hands it over IPC only to the app's own
 * main frame. With a remote-debugging port open, anything on this machine can
 * drive the renderer, so there is no token at all and person-only actions stay
 * locked (fail closed); the renderer says why. That covers a debug port
 * opened any way: NEBULA_DESKTOP_DEBUG_PORT, or Chromium/Node switches on the
 * command line (`--remote-debugging-port`, `--remote-debugging-pipe`,
 * `--inspect*`), which Chromium honours even in a packaged build
 * (`open -a Nebula --args --remote-debugging-port=9222`). The Vite dev
 * renderer gets one only with NEBULA_DESKTOP_DEV_PERSON=1.
 */
import { randomBytes } from 'node:crypto';

export const PERSON_TOKEN_CHANNEL = 'person:token';

/** 32 random bytes as 43 base64url characters, the shape the backend accepts. */
export function newPersonToken(random = randomBytes) {
  return random(32).toString('base64url');
}

/**
 * Chromium and Node switches that let another local process drive this app
 * (CDP or the Node inspector). Checked before main.mjs appends its own.
 */
export const DEBUG_SWITCHES = Object.freeze([
  'remote-debugging-port',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
]);

const DEBUG_ARG = /^--?(remote-debugging-(?:port|pipe)|inspect(?:-[a-z-]+)?)(?:=|$)/;

/**
 * Which debug switches this launch was started with.
 *
 * @param {{
 *   hasSwitch?: (name: string) => boolean,   // app.commandLine.hasSwitch
 *   argv?: string[],                          // process.argv
 *   execArgv?: string[],                      // process.execArgv
 *   nodeOptions?: string,                     // process.env.NODE_OPTIONS
 * }} sources
 * @returns {string[]} switch names, sorted, without dashes
 */
export function debugSwitchesInUse({ hasSwitch, argv = [], execArgv = [], nodeOptions = '' } = {}) {
  const found = new Set();
  if (hasSwitch) {
    for (const name of DEBUG_SWITCHES) {
      if (hasSwitch(name)) found.add(name);
    }
  }
  const words = [...argv, ...execArgv, ...String(nodeOptions ?? '').split(/\s+/)];
  for (const word of words) {
    const match = DEBUG_ARG.exec(String(word));
    if (match) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Decide this launch's token.
 * @param {{ debugPort?: string, debugSwitches?: string[], isDevelopment?: boolean, devOptIn?: string }} launch
 * @returns {{ token: string | null, reason: null | 'DEBUG_PORT' | 'DEV_RENDERER' }}
 */
export function decidePersonToken({ debugPort, debugSwitches, isDevelopment, devOptIn }, random = randomBytes) {
  if (debugPort) return { token: null, reason: 'DEBUG_PORT' };
  if (Array.isArray(debugSwitches) && debugSwitches.length > 0) return { token: null, reason: 'DEBUG_PORT' };
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
