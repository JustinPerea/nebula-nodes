/**
 * What a provider calls its credential, by key name: "token" for Replicate and
 * Hugging Face, "key" for every other (GM, PR #203 r25 item 3).
 *
 * The one source is the provider's Settings link word (providerCatalog
 * `keyLink`: "Open Replicate tokens"); that catalog, with every key's URL,
 * notes and the Hugging Face token's instructions, loads with Settings, not
 * with the app. The provider switcher and its "needs a token" lines run on the
 * canvas, so they read this short table, and tests/credentialNoun.test.ts holds
 * the two together: a catalog link word the table doesn't say fails it.
 */
const TOKEN_KEYS: ReadonlySet<string> = new Set(['REPLICATE_API_TOKEN', 'HF_TOKEN']);

export function credentialNounFor(key: string | undefined): 'key' | 'token' {
  return key !== undefined && TOKEN_KEYS.has(key) ? 'token' : 'key';
}
