import { create } from 'zustand';
import { normalizeKreaMode, type KreaConnectionMode } from '../lib/kreaConnection';

export interface SettingsDraft {
  apiKeys: Record<string, string>;
  routing: Record<string, string>;
  kreaConnectionMode: KreaConnectionMode;
  outputPath: string;
  exportFolder: string;
  zoomTelemetryEnabled: boolean;
}

export interface SettingsMutation {
  id: string;
  provider?: string;
}

interface SettingsDraftState {
  draft: SettingsDraft | null;
  baseline: SettingsDraft | null;
  mutation: SettingsMutation | null;
  pendingRefresh: SettingsMutation | null;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  error: string | null;
  removedProvider: string | null;
}

// Deliberately volatile: unsaved credentials survive dock unmounting but are
// never written to localStorage/sessionStorage and disappear on page reload.
export const useSettingsDraftStore = create<SettingsDraftState>(() => ({
  draft: null,
  baseline: null,
  mutation: null,
  pendingRefresh: null,
  saveStatus: 'idle',
  error: null,
  removedProvider: null,
}));

export function readSettingsDraft(settings: Record<string, unknown>): SettingsDraft {
  const readStringRecord = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some((entry) => typeof entry !== 'string')) {
      throw new Error('Invalid settings response');
    }
    return { ...value } as Record<string, string>;
  };
  return {
    apiKeys: readStringRecord(settings.apiKeys),
    routing: readStringRecord(settings.routing ?? {}),
    kreaConnectionMode: normalizeKreaMode(settings.kreaConnectionMode),
    outputPath: typeof settings.outputPath === 'string' ? settings.outputPath : '',
    exportFolder: typeof settings.exportFolder === 'string' ? settings.exportFolder : '',
    zoomTelemetryEnabled: settings.zoomTelemetryEnabled === true,
  };
}

export function settingsDraftIsDirty(draft: SettingsDraft | null, baseline: SettingsDraft | null): boolean {
  return draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
}
