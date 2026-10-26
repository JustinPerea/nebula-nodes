import { FailureNotice } from './errorCopy';

/** The browser follows Paper anchors; Electron delegates the same exact URL to the OS. */
export function isDesktopMode(): boolean {
  return typeof window !== 'undefined' && window.nebulaDesktop?.shell === 'electron';
}

const OPEN_HEADING = "Couldn't open the Paper artwork.";

/** Error copy round 3e (GM): a written line for each way it can fail; the
 * bridge's own text goes to the console only. */
export async function openExternalUrl(url: string): Promise<void> {
  const bridge = window.nebulaDesktop?.paperLinks;
  if (!bridge) throw new FailureNotice(OPEN_HEADING, 'Update the Nebula desktop app, then try again.');
  const result = await bridge.open(url);
  if (!result.ok) {
    console.warn('[nebula] Paper desktop link', result.error ?? '');
    throw new FailureNotice(OPEN_HEADING, "Paper Desktop didn't open it. Use Open source link.");
  }
}
