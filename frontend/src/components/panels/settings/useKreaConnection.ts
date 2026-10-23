import { useEffect, useRef, useState } from 'react';
import {
  getKreaConnection, connectKrea, checkKreaConnection, disconnectKrea, isKreaAuthorizationUrl, type KreaConnectionState,
} from '../../../lib/kreaConnection';
import { useUIStore } from '../../../store/uiStore';
import { failureMessage } from '../../../lib/errorCopy';

/**
 * Krea sign-in state and actions. Lives above the row because the row moves
 * between the Connected and Add lists as the status changes; polling and
 * errors shouldn't restart when it does.
 */
export function useKreaConnection() {
  const connection = useUIStore((s) => s.settingsCache.kreaConnection);
  const setConnection = useUIStore((s) => s.setKreaConnection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const version = requestVersion.current;
    getKreaConnection().then((state) => {
      if (!cancelled && requestVersion.current === version) setConnection(state);
    }).catch(() => {
      if (!cancelled && requestVersion.current === version) setError("Couldn't check Krea. Check that the Nebula backend is running.");
    });
    return () => { cancelled = true; };
  }, [setConnection]);

  useEffect(() => {
    if (connection?.status !== 'connecting') return;
    let cancelled = false;
    const version = requestVersion.current;
    const timer = window.setTimeout(() => {
      getKreaConnection().then((state) => {
        if (!cancelled && requestVersion.current === version) setConnection(state);
      }).catch(() => {
        if (!cancelled && requestVersion.current === version) {
          setError("Couldn't check sign-in progress. Use Check connection to retry.");
          setConnection({ status: 'error' });
        }
      });
    }, 2000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connection, setConnection]);

  async function act(action: () => Promise<KreaConnectionState>) {
    requestVersion.current += 1;
    setBusy(true);
    setError(null);
    setLaunchError(null);
    try { setConnection(await action()); }
    catch (value) { setError(failureMessage(value, "Couldn't update the Krea connection.")); }
    finally { setBusy(false); }
  }

  /** Must run inside the click: the browser only lets us reserve a tab during user activation. */
  function signIn() {
    const bridge = window.nebulaDesktop?.kreaLinks;
    let signInWindow: Window | null = null;
    if (!bridge) {
      // Reserve during the click, before registration can consume user activation.
      // Setting opener directly preserves the handle without exposing Nebula to Krea.
      try {
        signInWindow = window.open('about:blank', '_blank');
        if (signInWindow) {
          signInWindow.opener = null;
          try {
            signInWindow.document.title = 'Opening Krea sign-in…';
            if (signInWindow.document.body) signInWindow.document.body.textContent = 'Opening Krea sign-in…';
          } catch { /* A host may restrict decoration while still allowing navigation. */ }
        }
      } catch {
        signInWindow?.close();
        signInWindow = null;
      }
    }

    void act(async () => {
      let state: KreaConnectionState;
      try { state = await connectKrea(); }
      catch (value) { signInWindow?.close(); throw value; }
      const url = state.authorizationUrl;
      if (state.status !== 'connecting' || !url || !isKreaAuthorizationUrl(url)) {
        signInWindow?.close();
        if (state.status === 'connecting') setLaunchError("Couldn't prepare Krea sign-in. Use Restart sign-in to try again.");
        return state;
      }
      try {
        if (bridge) {
          const result = await bridge.open(url);
          if (!result.ok) throw new Error('Browser launch failed');
        } else {
          if (!signInWindow || signInWindow.closed) throw new Error('Sign-in tab unavailable');
          signInWindow.location.replace(url);
        }
      } catch {
        signInWindow?.close();
        setLaunchError("Krea sign-in didn't open. Use Open Krea sign-in below to continue.");
      }
      return state;
    });
  }

  return {
    connection, busy, error, launchError, setError, signIn,
    check: () => void act(checkKreaConnection),
    disconnect: () => void act(disconnectKrea),
  };
}

export type KreaController = ReturnType<typeof useKreaConnection>;
