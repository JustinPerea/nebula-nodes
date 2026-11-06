import { DeferredSettingsTopNotice } from '../../../lib/deferredChunks';
import { deferredAtOnce } from '../../deferredAtOnce';

// The restored-at-start line shows only what a fetch brings in: mounted at once, it appears with its chunk.
export const SettingsTopNotice = deferredAtOnce(DeferredSettingsTopNotice, 'SettingsTopNotice');
