import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useSettingsDraftStore } from '../../../store/settingsDraftStore';
import { useUIStore } from '../../../store/uiStore';
import { useProviderReadinessStore } from '../../../store/providerReadinessStore';
import { keyText } from '../../../lib/directRoute';
import { keyReadiness } from '../../../lib/providerReadiness';
import { unlockSummary, type ProviderKeySpec } from '../../../lib/providerCatalog';
import { removeKey, saveKey } from '../../../lib/settingsWrites';
import { ProviderRow } from './ProviderRow';
import { ServiceAccountInput } from './ServiceAccountInput';
import { cancelRowFocus, focusRowAfterMove, hostOf, keyStatus, readServiceAccount, takeRowFocus } from './rowHelpers';



/** Removing deletes the key right away, so it takes two presses; Keep gets focus first. */
function RemoveKeyButton({ label, removing, onConfirm }: { label: string; removing: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const disarm = () => { setArmed(false); requestAnimationFrame(() => trigger.current?.focus()); };
  if (!armed) {
    return (
      <button type="button" ref={trigger} className="settings__button settings__button--ghost settings__remove-key settings__button--danger"
        aria-label={`Remove ${label}`} disabled={removing} onClick={() => setArmed(true)}>
        {removing ? 'Removing…' : 'Remove'}
      </button>
    );
  }
  return (
    // Capture phase: the dock closes on Escape from a native listener that
    // runs before React's bubble handlers, so disarming has to claim it first.
    <span className="settings__remove-confirm" role="group" data-claims-escape="" aria-label={`Remove the ${label}?`}
      onKeyDownCapture={(event) => { if (event.key === 'Escape') { event.preventDefault(); disarm(); } }}>
      <button type="button" className="settings__button" autoFocus onClick={disarm}>Keep</button>
      <button type="button" className="settings__button settings__confirm--danger"
        aria-label={`Confirm removing the ${label}`} onClick={() => { setArmed(false); onConfirm(); }}>Remove</button>
    </span>
  );
}

export function KeyRow({ spec, configured }: { spec: ProviderKeySpec; configured: boolean }) {
  const open = useSettingsDraftStore((s) => (s.openRow?.id === spec.key ? s.openRow.mode : null));
  const draft = useSettingsDraftStore((s) => s.keyDrafts[spec.key] ?? '');
  const pending = useSettingsDraftStore((s) => !!s.pending[spec.key]);
  const error = useSettingsDraftStore((s) => s.errors[spec.key]);
  const saved = useSettingsDraftStore((s) => s.saved?.apiKeys[spec.key] ?? '');
  const cache = useUIStore((s) => s.settingsCache);
  const health = useProviderReadinessStore();
  const [revealed, setRevealed] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  const serviceAccount = spec.input === 'service-account';
  // "Hugging Face token", "OpenAI API key": what screen readers hear.
  const credentialName = `${spec.label} ${spec.credential ?? 'API key'}`;

  useEffect(() => {
    if (!takeRowFocus(spec.key)) return;
    trigger.current?.focus();
    trigger.current?.scrollIntoView?.({ block: 'nearest' });
  }, [spec.key]);

  // Closing the row unmounts whatever had focus inside it; hand focus back to its button.
  useEffect(() => {
    const before = wasOpen.current;
    wasOpen.current = open;
    if (open === 'manage' && before !== 'manage') firstAction.current?.focus();
    if (open === 'edit' && before !== 'edit') {
      document.getElementById(`settings-row-${spec.key}`)?.querySelector<HTMLElement>('[data-provider-key]')?.focus();
    }
    if (before && !open) {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) trigger.current?.focus();
    }
  }, [open, spec.key]);

  const setOpen = (mode: 'manage' | 'edit' | null) => {
    useSettingsDraftStore.setState((state) => ({ openRow: mode ? { id: spec.key, mode } : null, errors: withoutKey(state.errors, spec.key) }));
    if (mode !== 'edit') setRevealed(false);
  };
  const cancelEdit = () => {
    useSettingsDraftStore.setState((state) => ({ keyDrafts: withoutKey(state.keyDrafts, spec.key) }));
    setFileName(null);
    setOpen(null);
    trigger.current?.focus();
  };
  const setDraft = (text: string) => useSettingsDraftStore.setState((state) => ({
    keyDrafts: { ...state.keyDrafts, [spec.key]: text }, errors: withoutKey(state.errors, spec.key),
  }));
  const canSave = !pending && (serviceAccount ? readServiceAccount(draft).ok : keyText(draft) !== '');
  const submit = () => {
    if (!canSave) return;
    if (!configured) focusRowAfterMove(spec.key);
    void saveKey(spec.key, draft).then((ok) => { if (!ok) cancelRowFocus(spec.key); });
  };

  // Escape backs out one step: an open row closes before the dock does.
  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    if ((event.target as Element).closest('[data-claims-escape]')) return;
    event.preventDefault();
    if (open === 'edit') cancelEdit(); else { setOpen(null); trigger.current?.focus(); }
  };

  const readiness = keyReadiness(spec.key, cache, health);
  const state = configured ? keyStatus(spec.key, health) : { tone: 'idle' as const, status: undefined, statusTone: undefined };
  const summary = unlockSummary(spec, configured ? 'connected' : 'add');
  const bodyId = `settings-row-${spec.key}`;

  const action = configured && open !== 'edit' ? (
    <button ref={trigger} type="button" className="settings-row__more" aria-label={`Manage ${spec.label}`}
      aria-expanded={open === 'manage'} aria-controls={bodyId} onClick={() => setOpen(open ? null : 'manage')}>
      <MoreHorizontal size={15} strokeWidth={1.75} aria-hidden="true" focusable="false" />
    </button>
  ) : open === 'edit' ? (
    <button ref={trigger} type="button" className="settings__button settings__button--ghost" onClick={cancelEdit}>Cancel</button>
  ) : (
    <button ref={trigger} type="button" className="settings__button" aria-label={`Add ${spec.label} key`}
      aria-expanded={false} aria-controls={bodyId} onClick={() => setOpen('edit')}>Add key</button>
  );

  return (
    <div onKeyDownCapture={onKeyDownCapture}>
      <ProviderRow id={spec.key} tone={state.tone} name={spec.label} status={state.status} statusTone={state.statusTone}
        summary={summary} wrapSummary={summary === spec.note} title={configured ? readiness.detail : undefined}
        action={action}>
        {open === 'manage' && (
          <div id={bodyId} className="settings-row__manage">
            <div className="settings-row__buttons">
              {/* GM, PR #203 r16 item 5: the actions on the key, together on
                  one row; the key's page is a reference, on its own line below. */}
              <button ref={firstAction} type="button" className="settings__button" onClick={() => setOpen('edit')}>Replace key</button>
              <RemoveKeyButton label={credentialName} removing={pending} onConfirm={() => {
                focusRowAfterMove(spec.key);
                void removeKey(spec.key).then((ok) => { if (!ok) cancelRowFocus(spec.key); });
              }} />
            </div>
            <p className="settings-hint">
              {serviceAccount ? 'Service-account key saved.' : <>Saved key ending in <span className="settings-mono">{saved.replace(/^\*+/, '') || '····'}</span>.</>}
              {/* "Saved" needs no more words; a check result explains itself. */}
              {state.status !== 'Saved' && <> {readiness.detail}</>}
            </p>
            {/* Under "Saved key ending in …" (GM, PR #203 r16 item 5), as the
                edit view shows it; a key with its own link words ("Open
                Hugging Face tokens", r14 item 5) uses them here too. */}
            <p className="settings-hint settings-row__key-link">
              <a href={spec.url} target="_blank" rel="noopener noreferrer">
                {spec.keyLink ?? 'Key page'}<span aria-hidden="true"> ↗</span>
              </a>
            </p>
            {spec.caveat && <p className="settings-hint">{spec.caveat}</p>}
            {error && <p className="settings-row__error" role="alert">{error}</p>}
          </div>
        )}
        {open === 'edit' && (
          <form id={bodyId} className="settings-row__edit" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            {serviceAccount ? (
              <ServiceAccountInput label={spec.label} value={draft} fileName={fileName}
                onChange={(text, name) => { setDraft(text); setFileName(name); }} onSubmit={submit} />
            ) : (
              <div className="settings-key">
                <input
                  className="settings-key__input"
                  type={revealed ? 'text' : 'password'}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={spec.placeholder}
                  aria-label={credentialName}
                  aria-invalid={!!error || undefined}
                  data-provider-key={spec.key}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="settings-key__reveal" onClick={() => setRevealed((on) => !on)}
                  aria-label={`${revealed ? 'Hide' : 'Show'} ${credentialName}`}>{revealed ? 'Hide' : 'Show'}</button>
              </div>
            )}
            {/* GM, PR #203 r11 item 1: how to make the key, its page, then the caveat. */}
            {spec.instruction && <p className="settings-hint">{spec.instruction}</p>}
            {spec.keyLink && (
              <p className="settings-hint">
                <a href={spec.url} target="_blank" rel="noopener noreferrer">
                  {spec.keyLink}<span aria-hidden="true"> ↗</span>
                </a>
              </p>
            )}
            {spec.caveat && <p className="settings-hint">{spec.caveat}</p>}
            {error && <p className="settings-row__error" role="alert">{error}</p>}
            <div className="settings-row__foot">
              {spec.keyLink ? <span /> : (
                <span className="settings-hint">
                  {configured ? 'Key page: ' : 'No key yet? '}
                  <a href={spec.url} target="_blank" rel="noopener noreferrer">{hostOf(spec.url)} ↗</a>
                </span>
              )}
              <button type="submit" className="settings__button settings__button--primary" disabled={!canSave}>
                {pending ? 'Saving…' : 'Save key'}
              </button>
            </div>
          </form>
        )}
      </ProviderRow>
    </div>
  );
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}
