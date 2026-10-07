/** Browser-only Commons file selection. Picking a file does not upload it. */
export function pickFiles(options: { multiple?: boolean; accept?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple ?? false;
    input.accept = options.accept ?? '';
    input.hidden = true;
    const finish = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** Starts a browser download; this cannot acknowledge a filesystem save. */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

/** Browser confirmation preserves the explicit human action for destructive edits. */
export async function showConfirm(message: string): Promise<boolean> {
  return window.confirm(message);
}
