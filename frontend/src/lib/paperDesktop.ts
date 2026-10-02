/** The browser follows Paper anchors; Electron delegates the same exact URL to the OS. */
export function isDesktopMode(): boolean {
  return typeof window !== 'undefined' && window.nebulaDesktop?.shell === 'electron';
}

export async function openExternalUrl(url: string): Promise<void> {
  const bridge = window.nebulaDesktop?.paperLinks;
  if (!bridge) throw new Error('Paper desktop links require the current Nebula desktop bridge.');
  const result = await bridge.open(url);
  if (!result.ok) throw new Error(result.error ?? 'Could not open the Paper artwork.');
}
