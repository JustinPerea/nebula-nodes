import { apiFetch } from './backend';

/**
 * One-shot LLM rewrite of a Create prompt via the backend `/api/enhance-prompt`
 * (uses whichever provider key is configured). Returns the enhanced text.
 * Throws with a user-readable message on failure (no key, provider error).
 */
export async function enhancePrompt(prompt: string): Promise<string> {
  const res = await apiFetch('/api/enhance-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    let detail = `Enhance failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* keep the status fallback */
    }
    throw new Error(detail);
  }
  const data = (await res.json()) as { enhanced?: string };
  const enhanced = (data.enhanced ?? '').trim();
  if (!enhanced) throw new Error('Enhance returned nothing.');
  return enhanced;
}
