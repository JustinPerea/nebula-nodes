import { isAbsolute } from 'node:path';

/** The OS folder chooser for Settings' output and export folders. */
export const FOLDER_PICKER_CHANNEL = 'dialog:choose-folder';

/** A starting folder is only a hint: absolute, plain text, sane length. Anything else is dropped. */
export function folderPickerDefaultPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/u.test(value) || !isAbsolute(value)) return undefined;
  return value;
}

/**
 * Show a folder chooser over the main window and return the picked path.
 * The renderer only ever learns a path the person picked; it can't list or read folders.
 */
export function registerFolderPickerHandler(ipcMain, dialog, validateSender, getWindow) {
  ipcMain.handle(FOLDER_PICKER_CHANNEL, async (event, defaultPath) => {
    if (!validateSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const start = folderPickerDefaultPath(defaultPath);
    try {
      const options = { properties: ['openDirectory', 'createDirectory'], ...(start ? { defaultPath: start } : {}) };
      const window = getWindow();
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths?.[0]) return { ok: true, path: null };
      return { ok: true, path: result.filePaths[0] };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
