import { saveRunCostConfirm } from '../../../lib/settingsWrites';
import { useSettingsDraftStore } from '../../../store/settingsDraftStore';
import { RUN_COST_CONFIRM_CHOICES, useUIStore } from '../../../store/uiStore';
import { AgentSpendSection } from './AgentSpendSection';
import { SwitchRow } from './Switch';

function usd(value: number) {
  return value < 1 ? `$${value.toFixed(2)}` : `$${value}`;
}

/** Preferences apply the moment they change. Most live in this browser; the
 * run-cost threshold is saved to settings.json, because it limits agents too. */
export function PreferencesTab() {
  // Selected one by one: the UI store changes constantly while the canvas is in use.
  const ui = {
    runCostConfirmUsd: useUIStore((s) => s.runCostConfirmUsd),
    notificationPrefs: useUIStore((s) => s.notificationPrefs),
    setNotificationPrefs: useUIStore((s) => s.setNotificationPrefs),
    canvasPerfMode: useUIStore((s) => s.canvasPerfMode),
    setCanvasPerfMode: useUIStore((s) => s.setCanvasPerfMode),
    canvasLowDetail: useUIStore((s) => s.canvasLowDetail),
    setCanvasLowDetail: useUIStore((s) => s.setCanvasLowDetail),
    canvasMinimapEnabled: useUIStore((s) => s.canvasMinimapEnabled),
    setCanvasMinimapEnabled: useUIStore((s) => s.setCanvasMinimapEnabled),
    agentLogEnabled: useUIStore((s) => s.agentLogEnabled),
    setAgentLogEnabled: useUIStore((s) => s.setAgentLogEnabled),
  };
  const costError = useSettingsDraftStore((s) => s.errors.runCostConfirmUsd);
  const costValue = ui.runCostConfirmUsd === null ? 'off' : String(ui.runCostConfirmUsd);
  const customCost = ui.runCostConfirmUsd !== null && !(RUN_COST_CONFIRM_CHOICES as readonly number[]).includes(ui.runCostConfirmUsd);

  return (
    <div className="settings-prefs">
      <section aria-labelledby="settings-runs-heading">
        <div className="settings-label"><h3 id="settings-runs-heading">Runs</h3></div>
        <div className="settings-list">
          <div className="settings-pref">
            <span className="settings-pref__text">
              <label className="settings-pref__title" htmlFor="settings-run-cost-confirm">Ask before costly runs</label>
              <span className="settings-pref__description" id="settings-run-cost-confirm-help">At list prices. Agents must ask above this, and for any node without a published price</span>
            </span>
            <select
              id="settings-run-cost-confirm"
              className="settings__select settings__select--compact"
              value={costValue}
              aria-describedby="settings-run-cost-confirm-help"
              onChange={(event) => void saveRunCostConfirm(event.target.value === 'off' ? null : Number(event.target.value))}
            >
              {customCost && <option value={costValue}>{usd(ui.runCostConfirmUsd!)} or more</option>}
              {RUN_COST_CONFIRM_CHOICES.map((value) => <option key={value} value={String(value)}>{usd(value)} or more</option>)}
              <option value="off">Never</option>
            </select>
          </div>
          {costError && <p className="settings-row__error" role="alert">{costError}</p>}
          <SwitchRow title="Job notifications" description="When a run finishes in a background tab, or after a long run"
            checked={ui.notificationPrefs.enabled} onChange={(enabled) => ui.setNotificationPrefs({ enabled })} />
          {ui.notificationPrefs.enabled && (
            <SwitchRow nested title="Completion sound" description="A short tone when a run finishes"
              checked={ui.notificationPrefs.sound} onChange={(sound) => ui.setNotificationPrefs({ sound })} />
          )}
        </div>
      </section>

      <AgentSpendSection />

      <section aria-labelledby="settings-canvas-heading">
        <div className="settings-label"><h3 id="settings-canvas-heading">Canvas</h3></div>
        <div className="settings-list">
          <SwitchRow title="Performance mode" description="Only render nodes on screen. Helps large graphs."
            checked={ui.canvasPerfMode} onChange={ui.setCanvasPerfMode} />
          <SwitchRow title="Low detail when zoomed out" description="Hide node previews past a zoom level for smoother panning"
            checked={ui.canvasLowDetail} onChange={ui.setCanvasLowDetail} />
          <SwitchRow title="Minimap" description="An overview of your nodes in the bottom-right corner"
            checked={ui.canvasMinimapEnabled} onChange={ui.setCanvasMinimapEnabled} />
        </div>
      </section>

      <section aria-labelledby="settings-agent-heading">
        <div className="settings-label"><h3 id="settings-agent-heading">Agent</h3></div>
        <div className="settings-list">
          <SwitchRow title="Agent log" description="Execution telemetry under the chat"
            checked={ui.agentLogEnabled} onChange={ui.setAgentLogEnabled} />
        </div>
      </section>
    </div>
  );
}
