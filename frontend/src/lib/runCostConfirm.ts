import { getSettings, updateSettings } from './api';
import { isPersonRefusal } from './clearsOnPromote';
import { personUnconfirmed } from './personSession';
import { afterPersonRefusal, whenPerson } from './personWork';
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

/** The carry-over below: none yet, waiting for this tab to be the person's, or sent. */
let migration: 'waiting' | Promise<unknown> | null = null;

/** Apply the threshold from a GET /api/settings response. Before it was saved
 * there, it lived only in this browser: carry that choice over once.
 *
 * PR #204 round 11: the carry-over is PUT /api/settings, the person's alone. It used to go out
 * on every read that lacked the setting (the app's load and each Settings open), from any tab,
 * and a refusal reset it to go again on the next read: a held tab sent it, and was refused, on
 * every read. Now it goes out only from a tab connected as the person (lib/personWork). A held
 * tab waits and, on the promote, reads the settings again first, so a choice another tab
 * already carried over isn't written twice. A refusal waits for the promote again; it isn't
 * retried by the next read. */
export function applySavedRunCostConfirm(settings: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(settings, RUN_COST_CONFIRM_SETTING)) {
    useUIStore.getState().setRunCostConfirmUsd(readRunCostConfirm(settings[RUN_COST_CONFIRM_SETTING]));
    return;
  }
  if (migration) return;
  if (personUnconfirmed()) {
    migration = 'waiting';
    whenPerson(RUN_COST_MIGRATION, readAgainThenCarryOver);
    return;
  }
  carryOver();
}

const RUN_COST_MIGRATION = 'run-cost-migration';

function carryOver(): void {
  migration = updateSettings({ [RUN_COST_CONFIRM_SETTING]: useUIStore.getState().runCostConfirmUsd })
    .catch((error) => {
      // Refused because of this tab (demoted meanwhile): once more on the next promote, never on
      // the next read (lib/personWork afterPersonRefusal). No line: the carry-over is quiet.
      if (isPersonRefusal(error)) {
        migration = 'waiting';
        afterPersonRefusal(RUN_COST_MIGRATION, error, readAgainThenCarryOver);
        return;
      }
      migration = null; // another failure: try again on the next read
      console.warn('Could not save the run cost threshold:', error);
    });
}

function readAgainThenCarryOver(): void {
  migration = null;
  getSettings().then(applySavedRunCostConfirm).catch((error) => {
    console.warn('Could not read the settings to save the run cost threshold:', error);
  });
}

/** For tests. */
export function resetRunCostConfirmMigration() {
  migration = null;
}

/** For tests: where the carry-over stands. */
export function runCostMigrationState(): 'none' | 'waiting' | 'sent' {
  return migration === null ? 'none' : migration === 'waiting' ? 'waiting' : 'sent';
}
