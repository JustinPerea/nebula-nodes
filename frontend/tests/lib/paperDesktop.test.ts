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
    await expect(openExternalUrl('paper://file/a/b/c')).rejects.toThrow('current Nebula desktop bridge');
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
    await expect(openExternalUrl('paper://file/a/b/c')).rejects.toThrow('No Paper handler');
  });
});
