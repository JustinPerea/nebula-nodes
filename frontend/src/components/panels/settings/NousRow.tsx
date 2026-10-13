import { useRef } from 'react';
import { useSettingsDraftStore } from '../../../store/settingsDraftStore';
import { useProviderReadinessStore } from '../../../store/providerReadinessStore';
import { providerCheckIsCurrent } from '../../../lib/providerReadiness';
import { ProviderRow } from './ProviderRow';
import { NOUS_ROW } from './rowHelpers';

/** Nous signs in through the local Hermes CLI, so the row explains how instead of taking a key. */
export function NousRow({ summary }: { summary: string }) {
  const open = useSettingsDraftStore((s) => s.openRow?.id === NOUS_ROW);
  const health = useProviderReadinessStore();
  const trigger = useRef<HTMLButtonElement>(null);
  const entry = health.providers.Nous;
  const current = providerCheckIsCurrent(entry, health.checkedAt);
  const signedIn = current && entry.configured;
  const setOpen = (on: boolean) => useSettingsDraftStore.setState({ openRow: on ? { id: NOUS_ROW, mode: 'manage' } : null });
  const tone = health.loading ? 'busy' : !current ? 'idle' : entry.status === 'valid' ? 'ok' : entry.configured ? 'warn' : 'idle';
  const status = health.loading ? 'Checking…' : !current ? undefined
    : entry.status === 'valid' ? 'Signed in' : entry.configured ? "Sign-in couldn't be verified" : undefined;

  return (
    <div onKeyDownCapture={(event) => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }}>
      <ProviderRow id={NOUS_ROW} setup="nous" tone={tone} name="Nous Portal · sign-in" status={status}
        statusTone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : undefined} summary={summary}
        action={
          <button ref={trigger} type="button" className={`settings__button${open ? ' settings__button--ghost' : ''}`}
            aria-expanded={open} aria-controls="settings-row-nous" onClick={() => setOpen(!open)}>
            {open ? 'Done' : signedIn ? 'How it works' : 'How to connect'}
          </button>
        }>
        {open && (
          <div id="settings-row-nous" className="settings-row__manage">
            <p className="settings-hint">
              On the computer running Nebula, run <code className="settings-mono">hermes model</code> and choose Nous Portal.
              It signs in through Hermes in your browser; there's no key to paste.
            </p>
            <p className="settings-hint">Then use Check connections. Checking never starts a generation.</p>
          </div>
        )}
      </ProviderRow>
    </div>
  );
}
