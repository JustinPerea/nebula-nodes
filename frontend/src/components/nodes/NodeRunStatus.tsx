import { useEffect, useState } from 'react';
import type { ModelNodeDefinition, NodeData } from '../../types';
import { useUIStore } from '../../store/uiStore';
import { providerLabel, runRouteProvider } from '../../lib/modelDiscovery';
import { formatElapsed } from '../../lib/runStatus';

interface NodeRunStatusProps {
  data: NodeData;
  definition: ModelNodeDefinition | undefined;
}

/** What a running node is doing, on the node itself: who it's waiting on and
 * for how long ("OpenAI · 6s"), plus a bar once the provider reports progress. */
export function NodeRunStatus({ data, definition }: NodeRunStatusProps) {
  const apiKeys = useUIStore((state) => state.settingsCache.apiKeys);
  const executing = data.state === 'executing';
  // A node that was already running when it mounted (project switch, remount)
  // counts from now; the store stamps the real start for live runs.
  const [mountedAt] = useState(() => Date.now());
  const startedAt = data.runStartedAt ?? mountedAt;
  // Ticks once a second while running. Between runs it goes stale, and the next
  // run's later start time reads as 0s until the first tick.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!executing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [executing]);

  if (data.state !== 'queued' && !executing) return null;
  const provider = definition ? runRouteProvider(definition, apiKeys) : null;
  const percent = executing && data.progress !== undefined && data.progress > 0
    ? Math.round(data.progress * 100) : null;
  const parts = data.state === 'queued'
    ? ['Queued']
    : [provider ? providerLabel(provider) : 'Running', formatElapsed(now - startedAt), percent !== null ? `${percent}%` : null];

  return (
    <div className="model-node__loading" role="status">
      <div className="model-node__loading-spinner" />
      <span className="model-node__loading-text">{parts.filter(Boolean).join(' · ')}</span>
      {percent !== null && (
        <div className="model-node__progress">
          <div className="model-node__progress-bar" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}
