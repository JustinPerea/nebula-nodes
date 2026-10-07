/** Chat carries human authority only when this backend enables Commons. */
export async function commonsChatAuthority(enabled: boolean, brand: string): Promise<{
  brand?: string | null;
  commonsToken?: string;
}> {
  if (!enabled) return {};
  const { resolveCommonsToken } = await import('./commonsApi');
  return { brand: brand.trim() || null, commonsToken: await resolveCommonsToken() };
}
