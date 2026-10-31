import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useSettingsDraftStore, type SettingsDraft } from '../../../store/settingsDraftStore';
import { useUIStore } from '../../../store/uiStore';
import { saveField } from '../../../lib/settingsWrites';
import { isBackendOffline } from '../../../lib/backendConnection';
import { SwitchRow } from './Switch';
import { LineText } from '../../LineText';

type FolderField = 'outputPath' | 'exportFolder';

/**
 * A folder setting. It saves when you press Enter, leave the field, or pick a
 * folder; Escape puts back what was saved. In the desktop app Choose… opens
 * the system folder picker.
 */
function FolderField({ field, label, saved, placeholder, hint }: {
  field: FolderField;
  label: string;
  saved: string;
  placeholder: string;
  hint: string;
}) {
  const draft = useSettingsDraftStore((s) => s.fieldDrafts[field]);
  const pending = useSettingsDraftStore((s) => !!s.pending[field]);
  const justSaved = useSettingsDraftStore((s) => s.justSaved === field);
  const error = useSettingsDraftStore((s) => s.errors[field]);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const picker = typeof window !== 'undefined' ? window.nebulaDesktop?.folders : undefined;
  const value = draft ?? saved;
  const inputId = `settings-${field}`;
  const hintId = `${inputId}-hint`;

  const setDraft = (text: string | undefined) => useSettingsDraftStore.setState((state) => {
    const fieldDrafts = { ...state.fieldDrafts };
    if (text === undefined) delete fieldDrafts[field]; else fieldDrafts[field] = text;
    const errors = { ...state.errors };
    delete errors[field];
    return { fieldDrafts, errors };
  });
  const commit = () => {
    if (draft === undefined) return;
    // Round 16 (L3): going offline disables the field, which blurs it. That
    // blur isn't the person leaving the field, so nothing is sent and the
    // draft stays for when Nebula answers again.
    if (isBackendOffline()) return;
    if (draft.trim() === saved.trim()) { setDraft(undefined); return; }
    void saveField(field, draft);
  };

  async function choose() {
    if (!picker) return;
    setChooseError(null);
    try {
      const result = await picker.choose(value.trim() || undefined);
      if (!result.ok) throw new Error(result.error);
      if (result.path && result.path !== saved) void saveField(field, result.path);
    } catch {
      setChooseError("The folder picker couldn't open. Type the path instead.");
    }
  }

  return (
    <div className="settings-folder">
      <div className="settings-label">
        <h3><label htmlFor={inputId}>{label}</label></h3>
        <span className="settings-saved" role="status">{pending ? 'Saving…' : justSaved ? 'Saved' : ''}</span>
      </div>
      <div className="settings-folder__control">
        <input
          id={inputId}
          className="settings-folder__input"
          type="text"
          value={value}
          placeholder={placeholder}
          aria-describedby={hintId}
          aria-invalid={!!error || undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
          // Capture: Escape reverts an edit before the dock's listener can close Settings.
          onKeyDownCapture={(event) => {
            if (event.key === 'Escape' && draft !== undefined) { event.preventDefault(); setDraft(undefined); }
          }}
        />
        {picker && (
          <button type="button" className="settings__button" disabled={pending} onClick={() => void choose()}
            aria-label={`Choose ${label.toLowerCase()} folder`}>Choose…</button>
        )}
      </div>
      {(error || chooseError) && <p className="settings-row__error" role="alert"><LineText text={error ?? chooseError} /></p>}
      <p className="settings-hint settings-folder__hint" id={hintId}>{hint}</p>
    </div>
  );
}

export function StorageTab({ saved }: { saved: SettingsDraft }) {
  const telemetryPending = useSettingsDraftStore((s) => !!s.pending.zoomTelemetryEnabled);
  const telemetryError = useSettingsDraftStore((s) => s.errors.zoomTelemetryEnabled);
  const desktop = typeof window !== 'undefined' && !!window.nebulaDesktop?.folders;

  return (
    <div className="settings-storage">
      <FolderField field="outputPath" label="Generated files" saved={saved.outputPath}
        placeholder={desktop ? 'Default folder' : 'Default: ./output'}
        hint={`Every run saves here.${desktop ? '' : ' Use an absolute path.'} A new folder takes effect after Nebula restarts.`} />
      <FolderField field="exportFolder" label="Exports" saved={saved.exportFolder} placeholder="Default: ~/Downloads"
        hint="Where Save and Export start." />

      <section aria-labelledby="settings-help-heading">
        <div className="settings-label"><h3 id="settings-help-heading">Help &amp; advanced</h3></div>
        <div className="settings-list">
          <button type="button" className="settings-pref settings-pref--link" onClick={() => {
            // Close the way Escape does: it closes Settings wherever it's docked.
            useUIStore.getState().setLeftDock(null);
            useUIStore.getState().startOnboarding();
          }}>
            <span className="settings-pref__title">Show onboarding again</span>
            <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          </button>
          <SwitchRow title="Demo zoom telemetry" description="Records canvas bounds for demo-video editing, saved under the generated-files folder"
            checked={saved.zoomTelemetryEnabled} disabled={telemetryPending}
            onChange={(enabled) => void saveField('zoomTelemetryEnabled', enabled)} />
        </div>
        {telemetryError && <p className="settings-row__error" role="alert"><LineText text={telemetryError} /></p>}
      </section>
    </div>
  );
}
