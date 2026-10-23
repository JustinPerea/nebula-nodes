import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NebulaDesktopBridge } from '../../src/nebula-desktop';
import { isDesktopMode, openExternalUrl } from '../../src/lib/paperDesktop';

const originalBridge = window.nebulaDesktop;
function setBridge(bridge: Partial<NebulaDesktopBridge> | undefined) {
  window.nebulaDesktop = bridge as NebulaDesktopBridge | undefined;
}

afterEach(() => { window.nebulaDesktop = originalBridge; });

describe('Paper desktop artwork links', () => {
  it('lets the browser component retain its native anchor gesture', () => {
    setBridge(undefined);
    expect(isDesktopMode()).toBe(false);
  });

  it('detects older Electron shells so their app window never navigates to the external protocol', async () => {
    setBridge({ shell: 'electron' });
    expect(isDesktopMode()).toBe(true);
    // Error copy round 3e (GM): a written line, never "Could not".
    await expect(openExternalUrl('paper://file/a/b/c')).rejects
      .toThrow("Couldn't open the Paper artwork. Update the Nebula desktop app, then try again.");
  });

  it('passes the exact clicked artwork URL to the dedicated bridge', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true });
    setBridge({ shell: 'electron', paperLinks: { open } });
    const url = 'paper://file/file-a/page-a/logo-a';
    await openExternalUrl(url);
    expect(open).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('propagates structured native failures for the source card to expose its HTTPS fallback', async () => {
    setBridge({ shell: 'electron', paperLinks: { open: vi.fn().mockResolvedValue({ ok: false, error: 'No Paper handler' }) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = await openExternalUrl('paper://file/a/b/c').catch((e: Error) => e);
    // The bridge's own text goes to the console, the line to the card.
    expect((error as Error).message).toBe("Couldn't open the Paper artwork. Paper Desktop didn't open it. Use Open source link.");
    expect(warn).toHaveBeenCalledWith('[nebula] Paper desktop link', 'No Paper handler');
    warn.mockRestore();
  });
});
