import { create } from 'zustand';
import { apiFetch } from '../lib/backend';
import { REFUSED_FALLBACK_COPY, RequestFailedError, failureMessage, isConnectionFailure } from '../lib/errorCopy';
import { PROVIDER_HEALTH_TTL_MS, type ProviderHealthEntry, type ProviderHealthState, type ProviderHealthStatus } from '../lib/providerReadiness';

interface ProviderReadinessState extends ProviderHealthState {
  revision: number;
  checkConnections: () => Promise<void>;
  invalidate: () => void;
}

const statuses = new Set<ProviderHealthStatus>(['not_configured', 'configured_unverified', 'valid',
  'invalid', 'unauthorized', 'insufficient_credits', 'rate_limited', 'error']);
let requestVersion = 0;
/** GM, round 3f: "Couldn't check the connections. Nebula's server isn't
 * answering. Make sure it's running, then try again." That is the request
 * with no answer (CONNECTION_LOST_COPY). Round 3g, GM: ""Nebula didn't
 * respond" is wrong when something did answer. → "Couldn't check the
 * connections. Try again, or reload if it keeps happening."", for any
 * answered failure, a malformed answer included. */
const CHECK_HEADING = "Couldn't check the connections.";
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function clearExpiry() {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
}

function readProviders(value: unknown): Record<string, ProviderHealthEntry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection check');
  const entries = new Map<string, ProviderHealthEntry>();
  for (const [name, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Invalid connection check');
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.configured !== 'boolean' || (entry.status === 'valid' && !entry.configured) || !statuses.has(entry.status as ProviderHealthStatus)
      || typeof entry.last_checked !== 'string' || !Number.isFinite(Date.parse(entry.last_checked))) throw new Error('Invalid connection check');
    // Raw provider exception details may contain transport URLs; keep only the public status contract.
    entries.set(name, { configured: entry.configured, status: entry.status as ProviderHealthStatus, last_checked: entry.last_checked });
  }
  return Object.fromEntries(entries);
}

/** Volatile checks run only after an explicit action, never during model discovery. */
export const useProviderReadinessStore = create<ProviderReadinessState>((set, get) => ({
  providers: {}, checkedAt: null, loading: false, error: null, revision: 0,
  invalidate: () => {
    requestVersion += 1;
    clearExpiry();
    set((state) => ({ providers: {}, checkedAt: null, loading: false, error: null, revision: state.revision + 1 }));
  },
  checkConnections: async () => {
    const request = ++requestVersion;
    const revision = get().revision;
    clearExpiry();
    set({ providers: {}, checkedAt: null, loading: true, error: null });
    try {
      const response = await apiFetch('/api/health/providers?refresh=true');
      if (!response.ok) throw new RequestFailedError(CHECK_HEADING, response.status);
      const data = await response.json();
      const providers = readProviders(data?.providers);
      if (request !== requestVersion || get().revision !== revision) return;
      const checkedAt = Date.now();
      set({ providers, checkedAt, loading: false, error: null });
      const timestamps = Object.values(providers).map((entry) => Date.parse(entry.last_checked));
      const earliest = Math.min(checkedAt, ...timestamps);
      expiryTimer = setTimeout(() => get().invalidate(), Math.max(0, earliest + PROVIDER_HEALTH_TTL_MS - checkedAt));
    } catch (error) {
      if (request !== requestVersion || get().revision !== revision) return;
      // Never the error's own text (it may carry a URL): the request's line.
      set({ providers: {}, checkedAt: null, loading: false, error: isConnectionFailure(error)
        ? failureMessage(error, CHECK_HEADING) : `${CHECK_HEADING} ${REFUSED_FALLBACK_COPY}` });
    }
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('nebula:settings-saved', () => useProviderReadinessStore.getState().invalidate());
}
