import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { encryptValue, decryptValue } from './credentials.mjs';

/** Main-process-only key. No renderer/IPC method exposes this value. */
export async function getConnectorEncryptionKey(path, safeStorage) {
  try {
    const blob = await readFile(path, 'utf8');
    const { result: key } = await decryptValue(blob, safeStorage);
    if (!/^[A-Za-z0-9_-]{43}=$/.test(key)) throw new Error('Invalid connector vault key');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = randomBytes(32).toString('base64url') + '=';
  // encryptValue fails closed if OS credential encryption is unavailable.
  const blob = await encryptValue(key, safeStorage);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, blob, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
  return key;
}

export function isKreaAuthorizationUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.krea.ai' && !url.username && !url.password
      && url.pathname === '/auth/v1/oauth/authorize';
  } catch { return false; }
}

export function registerKreaAuthLinkHandler(ipcMain, shell, validateSender) {
  ipcMain.handle('krea:open-authorization', async (event, value) => {
    if (!validateSender(event) || !isKreaAuthorizationUrl(value)) {
      throw new Error('Invalid Krea authorization link');
    }
    await shell.openExternal(value);
    return { ok: true };
  });
}
