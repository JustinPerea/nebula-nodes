/** Match the manual Batch source: line mode trims/omits blank lines, while
 * whole-text mode preserves the authored item. Parsing never writes params. */
export function parseBatchItems(params: Record<string, unknown>): string[] {
  const text = typeof params.items_text === 'string' ? params.items_text : '';
  if (params.split_mode === 'none') return text ? [text] : [];
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function batchSizeCap(params: Record<string, unknown>): number {
  const value = params.batch_size_cap;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 25
    ? value : 10;
}

export function batchAuthoringError(params: Record<string, unknown>): string | null {
  if (params.items_text !== undefined && typeof params.items_text !== 'string') return 'Items must be text. Open settings to correct the saved value.';
  if (params.display_name !== undefined && typeof params.display_name !== 'string') return 'Name must be text. Open settings to correct the saved value.';
  if (params.split_mode !== undefined && params.split_mode !== 'none' && params.split_mode !== 'by_line') return 'Choose By line or Whole text in settings.';
  if (params.batch_size_cap !== undefined && (typeof params.batch_size_cap !== 'number'
    || !Number.isInteger(params.batch_size_cap) || params.batch_size_cap < 1 || params.batch_size_cap > 25)) {
    return 'The saved cap must be a whole number from 1 to 25. Open settings to correct it.';
  }
  return null;
}
