import { apiRequest } from './apiRequest';

/** The line Settings shows at its top until the person dismisses it
 * (GET /api/settings/notice, the person's only): today settings.restored's
 * line (GM, PR #203 r38 item 5). `path` is the part of `line` shown in mono.
 * Its own module, not api.ts, so a test that mocks api.ts for Settings
 * needn't know of it. */
export interface SettingsNotice { kind: string; line: string; path: string }

export async function getSettingsNotice(): Promise<SettingsNotice | null> {
  const response = await apiRequest('Couldn’t load your settings.', '/api/settings/notice');
  const body = await response.json() as { notice?: SettingsNotice | null };
  return body.notice ?? null;
}

/** The person read the line: it isn't shown again (POST
 * /api/settings/notice/dismiss). */
export async function dismissSettingsNotice(): Promise<void> {
  await apiRequest('Couldn’t dismiss the line.', '/api/settings/notice/dismiss', { method: 'POST' });
}

/** The line's text around its path, which Settings shows in mono and
 * selectable (GM, PR #203 r38 item 5); no path in the line, no split. */
export function noticeParts(notice: SettingsNotice): { before: string; path: string; after: string } {
  const at = notice.path ? notice.line.indexOf(notice.path) : -1;
  if (at < 0) return { before: notice.line, path: '', after: '' };
  return { before: notice.line.slice(0, at), path: notice.path, after: notice.line.slice(at + notice.path.length) };
}
