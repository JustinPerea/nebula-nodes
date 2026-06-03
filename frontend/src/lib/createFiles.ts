import { apiFetch } from './backend';

export async function revealInFinder(url: string): Promise<void> {
  const res = await apiFetch('/api/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `Reveal failed: ${res.status}`);
  }
}

export async function saveToFolder(url: string, filename?: string): Promise<{ savedPath: string }> {
  const res = await apiFetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, filename }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `Export failed: ${res.status}`);
  }
  return res.json() as Promise<{ savedPath: string }>;
}
