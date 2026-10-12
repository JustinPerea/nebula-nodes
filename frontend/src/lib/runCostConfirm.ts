import { updateSettings } from './api';
import { RUN_COST_CONFIRM_DEFAULT_USD, useUIStore } from '../store/uiStore';

/*
 * "Ask before costly runs" lives in settings.json, because the backend holds
 * agents to the same threshold (backend/services/agent_spend.py). The UI store
 * keeps a copy in this browser so the Run button can ask before settings load.
 */

export const RUN_COST_CONFIRM_SETTING = 'runCostConfirmUsd';

/** null means never ask; a missing or unreadable value is the default, as on the backend. */
export function readRunCostConfirm(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : RUN_COST_CONFIRM_DEFAULT_USD;
}

let migration: Promise<unknown> | null = null;

/** Apply the threshold from a GET /api/settings response. Before it was saved
 * there, it lived only in this browser: carry that choice over once. */
export function applySavedRunCostConfirm(settings: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(settings, RUN_COST_CONFIRM_SETTING)) {
    useUIStore.getState().setRunCostConfirmUsd(readRunCostConfirm(settings[RUN_COST_CONFIRM_SETTING]));
    return;
  }
  if (migration) return;
  migration = updateSettings({ [RUN_COST_CONFIRM_SETTING]: useUIStore.getState().runCostConfirmUsd })
    .catch((error) => {
      migration = null; // try again on the next read
      console.warn('Could not save the run cost threshold:', error);
    });
}

/** For tests. */
export function resetRunCostConfirmMigration() {
  migration = null;
}
