import { apiRequest } from './apiRequest';

export async function revealInFinder(url: string): Promise<void> {
  await apiRequest("Couldn't show the file in Finder.", '/api/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

export async function saveToFolder(url: string, filename?: string): Promise<{ savedPath: string }> {
  const res = await apiRequest("Couldn't save the file.", '/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, filename }),
  });
  return res.json() as Promise<{ savedPath: string }>;
}
