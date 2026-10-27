import type { ModelNodeDefinition } from '../types';
import { allParamDefinitions } from '../lib/directRoute';
import { useUIStore } from '../store/uiStore';
import { useProviderReadinessStore } from '../store/providerReadinessStore';
import { modelReadiness } from '../lib/providerReadiness';
import { withNewKreaMode } from '../lib/kreaConnection';
import { offlineMark, useBackendOffline } from '../lib/useBackendOffline';
import '../styles/provider-readiness.css';

/** Connection feedback never changes model selection, recipe parameters or jobs. */
export function ProviderReadinessBadge({ definition, params, onSetup }: {
  definition: ModelNodeDefinition;
  params?: Record<string, unknown>;
  onSetup?: () => void;
}) {
  const cache = useUIStore((state) => state.settingsCache);
  const health = useProviderReadinessStore();
  // Offline is read-only (GM, round 15 of PR #114): "Set up" (and
  // "Settings") is dimmed with a not-allowed cursor, and doesn't open.
  const offline = useBackendOffline();
  // Catalog rows describe the defaults addNode will save, while existing
  // recipes always use their actual params (including missing legacy fields).
  const defaults = Object.fromEntries(allParamDefinitions(definition).filter((param) => param.default !== undefined)
    .map((param) => [param.key, param.default]));
  const readiness = modelReadiness(definition,
    params ?? withNewKreaMode(definition, defaults, cache.kreaConnectionMode), cache, health);
  const manage = readiness.tone === 'success' || readiness.label.startsWith('Configured') || readiness.label === 'Krea signed in';
  return (
    // Offline (GM, round 16 of PR #114): the line goes neutral grey, since
    // orange would say "set this up now" while nothing can be set up.
    <div className={`provider-readiness provider-readiness--${readiness.tone}${offline ? ' provider-readiness--offline' : ''}`}>
      <span className="provider-readiness__label" title={readiness.detail}>
        {readiness.connectionLabel && <span className="provider-readiness__route">{readiness.connectionLabel} · </span>}
        <span>{readiness.label}</span>
      </span>
      {readiness.setupTarget && <button type="button" className="provider-readiness__setup"
        title={readiness.detail}
        aria-label={`Connection settings for ${definition.displayName}`}
        disabled={offline}
        {...offlineMark(offline)}
        onClick={() => {
          onSetup?.();
          useUIStore.getState().openProviderSetup(readiness.setupTarget!);
        }}>{manage ? 'Settings' : 'Set up'}</button>}
    </div>
  );
}
