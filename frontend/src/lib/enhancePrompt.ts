import { apiRequest } from './apiRequest';
import { FailureNotice } from './errorCopy';

/**
 * One-shot LLM rewrite of a Create prompt via the backend `/api/enhance-prompt`
 * (uses whichever provider key is configured). Returns the enhanced text.
 * Throws with a user-readable message on failure (no key, provider error).
 */
export async function enhancePrompt(prompt: string): Promise<string> {
  // The backend's reason (no key, a provider error) after the heading; a
  // FastAPI field list is no reason the person can read (GM's fallback line).
  const res = await apiRequest("Couldn't enhance the prompt.", '/api/enhance-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  const data = (await res.json()) as { enhanced?: string };
  const enhanced = (data.enhanced ?? '').trim();
  if (!enhanced) throw new FailureNotice("Couldn't enhance the prompt.", 'The model sent back an empty prompt. Try again.');
  return enhanced;
}
