/** A personal agent's name as it reads inside a sentence, an aria-label, a
 * title or a button name. The presets are stored as "Your Claude", "Your
 * Codex", "Your Gemini" and "Your Antigravity" (capital where the name starts
 * a label or a sentence), so mid-sentence the first word drops to lower case:
 * "Use your Gemini in chat". A name that doesn't start with "Your " (a name
 * stored before the change such as "Claude (your setup)", Hermes, a custom
 * agent, a model picker entry) comes back unchanged. The backend twin is
 * `in_sentence` in backend/services/personal_agents.py. */
export function agentNameInSentence(name: string): string {
  return name.startsWith('Your ') && name.length > 5 ? `your ${name.slice(5)}` : name;
}
